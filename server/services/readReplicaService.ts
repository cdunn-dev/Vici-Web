import { Pool, PoolConfig } from 'pg';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

interface ReplicaInstance {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  isActive: boolean;
  lastChecked: Date;
  responseTime: number;
  errorCount: number;
  queryCount: number;
  lagSeconds: number;
}

export interface ReadReplicaConfig {
  /**
   * Health check interval in milliseconds
   */
  healthCheckInterval: number;
  
  /**
   * Response time threshold in milliseconds
   */
  responseTimeThreshold: number;
  
  /**
   * Error count threshold
   */
  errorCountThreshold: number;
  
  /**
   * Replication lag threshold in seconds
   */
  lagThresholdSeconds: number;
  
  /**
   * Whether to use weighted round-robin
   */
  useWeightedRoundRobin: boolean;
  
  /**
   * Whether to use least connections
   */
  useLeastConnections: boolean;
  
  /**
   * Whether to use response time
   */
  useResponseTime: boolean;
  
  /**
   * Whether to enable failover
   */
  enableFailover: boolean;
  
  /**
   * Failover timeout in milliseconds
   */
  failoverTimeout: number;
}

type ReplicaSelectionStrategy = 'round-robin' | 'weighted-round-robin' | 'least-connections' | 'response-time' | 'least-lag';

export class ReadReplicaService extends EventEmitter {
  private primaryPool: Pool;
  private replicas: Map<string, ReplicaInstance> = new Map();
  private replicaPools: Map<string, Pool> = new Map();
  private config: ReadReplicaConfig;
  private currentIndex: number = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private strategy: ReplicaSelectionStrategy = 'round-robin';
  private isInitialized = false;

  constructor(primaryConfig: PoolConfig, config: Partial<ReadReplicaConfig> = {}) {
    super();
    
    this.primaryPool = new Pool(primaryConfig);
    
    this.config = {
      healthCheckInterval: 30000,
      responseTimeThreshold: 1000,
      errorCountThreshold: 5,
      lagThresholdSeconds: 10,
      useWeightedRoundRobin: false,
      useLeastConnections: false,
      useResponseTime: false,
      enableFailover: true,
      failoverTimeout: 5000,
      ...config
    };
    
    // Set up event listeners for the primary pool
    this.primaryPool.on('connect', () => {
      logger.debug('New client connected to the primary pool');
    });
    
    this.primaryPool.on('error', (err) => {
      logger.error('Unexpected error on idle client in primary pool', err);
    });
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    
    try {
      // Test the primary connection
      const client = await this.primaryPool.connect();
      client.release();
      
      logger.info('Primary database connection established');
      
      // Start health checks
      this.startHealthChecks();
      
      this.isInitialized = true;
      this.emit('initialized');
    } catch (error) {
      logger.error('Failed to initialize read replica service', error);
      throw error;
    }
  }

  addReplica(replica: ReplicaInstance): void {
    if (this.replicas.has(replica.id)) {
      logger.warn(`Replica with ID ${replica.id} already exists`);
      return;
    }
    
    const poolConfig: PoolConfig = {
      host: replica.host,
      port: replica.port,
      database: replica.database,
      user: replica.user,
      password: replica.password
    };
    
    const pool = new Pool(poolConfig);
    
    // Set up event listeners for the replica pool
    pool.on('connect', () => {
      logger.debug(`New client connected to the replica pool: ${replica.name}`);
    });
    
    pool.on('error', (err) => {
      logger.error(`Unexpected error on idle client in replica pool: ${replica.name}`, err);
    });
    
    this.replicas.set(replica.id, {
      ...replica,
      isActive: true,
      lastChecked: new Date(),
      responseTime: 0,
      errorCount: 0,
      queryCount: 0,
      lagSeconds: 0
    });
    
    this.replicaPools.set(replica.id, pool);
    
    logger.info(`Added replica: ${replica.name} (${replica.host}:${replica.port})`);
    this.emit('replicaAdded', replica.id);
  }

  removeReplica(replicaId: string): void {
    if (!this.replicas.has(replicaId)) {
      logger.warn(`Replica with ID ${replicaId} does not exist`);
      return;
    }
    
    const pool = this.replicaPools.get(replicaId);
    if (pool) {
      pool.end().catch(err => {
        logger.error(`Error ending pool for replica ${replicaId}`, err);
      });
      this.replicaPools.delete(replicaId);
    }
    
    this.replicas.delete(replicaId);
    
    logger.info(`Removed replica: ${replicaId}`);
    this.emit('replicaRemoved', replicaId);
  }

  async query(text: string, params?: any[], useReplica: boolean = true): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // If this is a write query or we're explicitly told not to use a replica, use the primary
    if (!useReplica || this.isWriteQuery(text)) {
      return this.primaryPool.query(text, params);
    }
    
    // Get active replicas
    const activeReplicas = this.getActiveReplicas();
    
    // If no active replicas, fall back to primary
    if (activeReplicas.length === 0) {
      logger.warn('No active replicas available, falling back to primary database');
      return this.primaryPool.query(text, params);
    }
    
    // Select a replica based on the strategy
    const selectedReplica = this.selectReplica(activeReplicas);
    
    if (!selectedReplica) {
      logger.warn('Failed to select a replica, falling back to primary database');
      return this.primaryPool.query(text, params);
    }
    
    const pool = this.replicaPools.get(selectedReplica.id);
    if (!pool) {
      logger.warn(`Pool not found for replica ${selectedReplica.id}, falling back to primary database`);
      return this.primaryPool.query(text, params);
    }
    
    try {
      const startTime = Date.now();
      const result = await pool.query(text, params);
      const endTime = Date.now();
      
      // Update metrics
      const replica = this.replicas.get(selectedReplica.id);
      if (replica) {
        replica.queryCount++;
        replica.responseTime = endTime - startTime;
        replica.lastChecked = new Date();
      }
      
      return result;
    } catch (error) {
      logger.error(`Error executing query on replica ${selectedReplica.id}`, error);
      
      // Update error count
      const replica = this.replicas.get(selectedReplica.id);
      if (replica) {
        replica.errorCount++;
        replica.lastChecked = new Date();
        
        // If error count exceeds threshold, mark as inactive
        if (replica.errorCount >= this.config.errorCountThreshold) {
          this.markReplicaInactive(selectedReplica.id);
        }
      }
      
      // Fall back to primary
      logger.info(`Falling back to primary database for query`);
      return this.primaryPool.query(text, params);
    }
  }

  async transaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Transactions should always use the primary database
    const client = await this.primaryPool.connect();
    
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private isWriteQuery(text: string): boolean {
    const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE'];
    const upperText = text.trim().toUpperCase();
    return writeKeywords.some(keyword => upperText.startsWith(keyword));
  }

  private selectReplica(replicas: ReplicaInstance[]): ReplicaInstance | null {
    if (replicas.length === 0) {
      return null;
    }
    
    switch (this.strategy) {
      case 'round-robin':
        return this.roundRobin(replicas);
      case 'weighted-round-robin':
        return this.weightedRoundRobin(replicas);
      case 'least-connections':
        return this.leastConnections(replicas);
      case 'response-time':
        return this.responseTime(replicas);
      case 'least-lag':
        return this.leastLag(replicas);
      default:
        return this.roundRobin(replicas);
    }
  }

  private roundRobin(replicas: ReplicaInstance[]): ReplicaInstance {
    const replica = replicas[this.currentIndex % replicas.length];
    this.currentIndex = (this.currentIndex + 1) % replicas.length;
    return replica;
  }

  private weightedRoundRobin(replicas: ReplicaInstance[]): ReplicaInstance {
    // Simple implementation - can be enhanced with actual weights
    return this.roundRobin(replicas);
  }

  private leastConnections(replicas: ReplicaInstance[]): ReplicaInstance {
    // Sort by query count (as a proxy for connections)
    return [...replicas].sort((a, b) => a.queryCount - b.queryCount)[0];
  }

  private responseTime(replicas: ReplicaInstance[]): ReplicaInstance {
    // Sort by response time
    return [...replicas].sort((a, b) => a.responseTime - b.responseTime)[0];
  }

  private leastLag(replicas: ReplicaInstance[]): ReplicaInstance {
    // Sort by replication lag
    return [...replicas].sort((a, b) => a.lagSeconds - b.lagSeconds)[0];
  }

  private startHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth().catch(err => {
        logger.error('Error during health check', err);
      });
    }, this.config.healthCheckInterval);
  }

  private async checkHealth(): Promise<void> {
    // Check primary health
    try {
      const startTime = Date.now();
      await this.primaryPool.query('SELECT 1');
      const endTime = Date.now();
      
      logger.debug(`Primary database health check passed (${endTime - startTime}ms)`);
    } catch (error) {
      logger.error('Primary database health check failed', error);
    }
    
    // Check replica health
    for (const [id, replica] of this.replicas.entries()) {
      const pool = this.replicaPools.get(id);
      if (!pool) {
        continue;
      }
      
      try {
        const startTime = Date.now();
        const result = await pool.query('SELECT 1');
        const endTime = Date.now();
        
        // Check replication lag
        let lagSeconds = 0;
        try {
          const lagResult = await pool.query(`
            SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::INT as lag_seconds
          `);
          lagSeconds = lagResult.rows[0]?.lag_seconds || 0;
        } catch (lagError) {
          logger.warn(`Could not determine replication lag for replica ${id}`, lagError);
        }
        
        // Update replica metrics
        replica.isActive = true;
        replica.lastChecked = new Date();
        replica.responseTime = endTime - startTime;
        replica.errorCount = 0;
        replica.lagSeconds = lagSeconds;
        
        // If lag exceeds threshold, mark as inactive
        if (lagSeconds > this.config.lagThresholdSeconds) {
          logger.warn(`Replica ${id} has high replication lag (${lagSeconds}s), marking as inactive`);
          this.markReplicaInactive(id);
        }
        
        logger.debug(`Replica ${id} health check passed (${endTime - startTime}ms, lag: ${lagSeconds}s)`);
      } catch (error) {
        logger.error(`Replica ${id} health check failed`, error);
        
        // Update error count
        replica.errorCount++;
        replica.lastChecked = new Date();
        
        // If error count exceeds threshold, mark as inactive
        if (replica.errorCount >= this.config.errorCountThreshold) {
          this.markReplicaInactive(id);
        }
      }
    }
  }

  private markReplicaInactive(replicaId: string): void {
    const replica = this.replicas.get(replicaId);
    if (replica) {
      replica.isActive = false;
      logger.warn(`Marked replica ${replicaId} as inactive`);
      this.emit('replicaInactive', replicaId);
    }
  }

  markReplicaActive(replicaId: string): void {
    const replica = this.replicas.get(replicaId);
    if (replica) {
      replica.isActive = true;
      replica.errorCount = 0;
      logger.info(`Marked replica ${replicaId} as active`);
      this.emit('replicaActive', replicaId);
    }
  }

  getReplicas(): ReplicaInstance[] {
    return Array.from(this.replicas.values());
  }

  getActiveReplicas(): ReplicaInstance[] {
    return Array.from(this.replicas.values()).filter(replica => replica.isActive);
  }

  getStrategy(): ReplicaSelectionStrategy {
    return this.strategy;
  }

  setStrategy(strategy: ReplicaSelectionStrategy): void {
    this.strategy = strategy;
    logger.info(`Set replica selection strategy to ${strategy}`);
  }

  updateConfig(config: Partial<ReadReplicaConfig>): void {
    this.config = {
      ...this.config,
      ...config
    };
    
    logger.info('Updated read replica configuration');
    
    // Restart health checks if interval changed
    if (config.healthCheckInterval) {
      this.startHealthChecks();
    }
  }

  async end(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    // End all replica pools
    for (const [id, pool] of this.replicaPools.entries()) {
      try {
        await pool.end();
        logger.info(`Ended pool for replica ${id}`);
      } catch (error) {
        logger.error(`Error ending pool for replica ${id}`, error);
      }
    }
    
    // End primary pool
    try {
      await this.primaryPool.end();
      logger.info('Ended primary pool');
    } catch (error) {
      logger.error('Error ending primary pool', error);
    }
    
    this.isInitialized = false;
    this.emit('ended');
  }
} 