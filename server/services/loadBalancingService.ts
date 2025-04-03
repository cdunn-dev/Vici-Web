import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

interface DatabaseInstance {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  weight: number;
  isActive: boolean;
  lastChecked: Date;
  responseTime: number;
  errorCount: number;
  queryCount: number;
}

interface LoadBalancingConfig {
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

type LoadBalancingStrategy = 'round-robin' | 'weighted-round-robin' | 'least-connections' | 'response-time';

export class LoadBalancingService extends EventEmitter {
  private instances: Map<string, DatabaseInstance> = new Map();
  private pools: Map<string, Pool> = new Map();
  private config: LoadBalancingConfig;
  private currentIndex: number = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private strategy: LoadBalancingStrategy = 'round-robin';

  constructor(config: Partial<LoadBalancingConfig> = {}) {
    super();
    
    this.config = {
      healthCheckInterval: 30000, // 30 seconds
      responseTimeThreshold: 1000, // 1 second
      errorCountThreshold: 5,
      useWeightedRoundRobin: false,
      useLeastConnections: false,
      useResponseTime: false,
      enableFailover: true,
      failoverTimeout: 60000, // 1 minute
      ...config
    };
    
    // Determine the load balancing strategy
    if (this.config.useWeightedRoundRobin) {
      this.strategy = 'weighted-round-robin';
    } else if (this.config.useLeastConnections) {
      this.strategy = 'least-connections';
    } else if (this.config.useResponseTime) {
      this.strategy = 'response-time';
    } else {
      this.strategy = 'round-robin';
    }
  }

  /**
   * Initialize the load balancing service
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing load balancing service');
      
      // Start health checks
      this.startHealthChecks();
      
      logger.info('Load balancing service initialized');
    } catch (error) {
      logger.error('Failed to initialize load balancing service:', error);
      throw error;
    }
  }

  /**
   * Add a database instance
   */
  addInstance(instance: DatabaseInstance): void {
    try {
      // Create a connection pool for the instance
      const pool = new Pool({
        host: instance.host,
        port: instance.port,
        database: instance.database,
        user: instance.user,
        password: instance.password
      });
      
      // Set up event listeners
      pool.on('connect', () => {
        logger.debug(`New client connected to pool for instance: ${instance.name}`);
      });
      
      pool.on('error', (err) => {
        logger.error(`Unexpected error on idle client for instance: ${instance.name}`, err);
        
        // Increment error count
        instance.errorCount++;
        
        // Check if instance should be marked as inactive
        if (instance.errorCount >= this.config.errorCountThreshold) {
          this.markInstanceInactive(instance.id);
        }
      });
      
      // Add instance and pool to maps
      this.instances.set(instance.id, instance);
      this.pools.set(instance.id, pool);
      
      logger.info(`Added database instance: ${instance.name}`);
    } catch (error) {
      logger.error(`Failed to add database instance: ${instance.name}`, error);
      throw error;
    }
  }

  /**
   * Remove a database instance
   */
  removeInstance(instanceId: string): void {
    try {
      const instance = this.instances.get(instanceId);
      
      if (!instance) {
        logger.warn(`Instance not found: ${instanceId}`);
        return;
      }
      
      // End the connection pool
      const pool = this.pools.get(instanceId);
      if (pool) {
        pool.end();
        this.pools.delete(instanceId);
      }
      
      // Remove the instance
      this.instances.delete(instanceId);
      
      logger.info(`Removed database instance: ${instance.name}`);
    } catch (error) {
      logger.error(`Failed to remove database instance: ${instanceId}`, error);
      throw error;
    }
  }

  /**
   * Get a database instance based on the load balancing strategy
   */
  getInstance(): DatabaseInstance | null {
    try {
      // Get active instances
      const activeInstances = Array.from(this.instances.values())
        .filter(instance => instance.isActive);
      
      if (activeInstances.length === 0) {
        logger.warn('No active database instances available');
        return null;
      }
      
      let selectedInstance: DatabaseInstance | null = null;
      
      switch (this.strategy) {
        case 'round-robin':
          selectedInstance = this.roundRobin(activeInstances);
          break;
        case 'weighted-round-robin':
          selectedInstance = this.weightedRoundRobin(activeInstances);
          break;
        case 'least-connections':
          selectedInstance = this.leastConnections(activeInstances);
          break;
        case 'response-time':
          selectedInstance = this.responseTime(activeInstances);
          break;
        default:
          selectedInstance = this.roundRobin(activeInstances);
      }
      
      if (selectedInstance) {
        // Increment query count
        selectedInstance.queryCount++;
        
        // Update last checked time
        selectedInstance.lastChecked = new Date();
      }
      
      return selectedInstance;
    } catch (error) {
      logger.error('Failed to get database instance', error);
      return null;
    }
  }

  /**
   * Get a connection pool for a database instance
   */
  getPool(instanceId: string): Pool | null {
    return this.pools.get(instanceId) || null;
  }

  /**
   * Execute a query using the load balancing service
   */
  async query(text: string, params?: any[]): Promise<any> {
    const instance = this.getInstance();
    
    if (!instance) {
      throw new Error('No active database instances available');
    }
    
    const pool = this.getPool(instance.id);
    
    if (!pool) {
      throw new Error(`No connection pool available for instance: ${instance.name}`);
    }
    
    const startTime = Date.now();
    
    try {
      const result = await pool.query(text, params || []);
      
      // Update response time
      const endTime = Date.now();
      const responseTime = endTime - startTime;
      
      instance.responseTime = (instance.responseTime * (instance.queryCount - 1) + responseTime) / instance.queryCount;
      
      // Check if response time exceeds threshold
      if (responseTime > this.config.responseTimeThreshold) {
        logger.warn(`Slow query on instance ${instance.name}: ${responseTime}ms`);
      }
      
      return result;
    } catch (error) {
      // Increment error count
      instance.errorCount++;
      
      // Check if instance should be marked as inactive
      if (instance.errorCount >= this.config.errorCountThreshold) {
        this.markInstanceInactive(instance.id);
      }
      
      // If failover is enabled, try another instance
      if (this.config.enableFailover) {
        logger.info(`Failing over from instance ${instance.name} due to error`);
        return this.failover(text, params || [], [instance.id]);
      }
      
      throw error;
    }
  }

  /**
   * Execute a transaction using the load balancing service
   */
  async transaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
    const instance = this.getInstance();
    
    if (!instance) {
      throw new Error('No active database instances available');
    }
    
    const pool = this.getPool(instance.id);
    
    if (!pool) {
      throw new Error(`No connection pool available for instance: ${instance.name}`);
    }
    
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      
      // Increment error count
      instance.errorCount++;
      
      // Check if instance should be marked as inactive
      if (instance.errorCount >= this.config.errorCountThreshold) {
        this.markInstanceInactive(instance.id);
      }
      
      // If failover is enabled, try another instance
      if (this.config.enableFailover) {
        logger.info(`Failing over from instance ${instance.name} due to transaction error`);
        return this.failoverTransaction(callback, [instance.id]);
      }
      
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Failover to another instance
   */
  private async failover(text: string, params: any[], excludedInstanceIds: string[]): Promise<any> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < this.config.failoverTimeout) {
      const instance = this.getInstance();
      
      if (!instance) {
        throw new Error('No active database instances available for failover');
      }
      
      // Skip excluded instances
      if (excludedInstanceIds.includes(instance.id)) {
        continue;
      }
      
      const pool = this.getPool(instance.id);
      
      if (!pool) {
        continue;
      }
      
      try {
        logger.info(`Attempting failover to instance: ${instance.name}`);
        const result = await pool.query(text, params);
        logger.info(`Failover to instance ${instance.name} successful`);
        return result;
      } catch (error) {
        logger.error(`Failover to instance ${instance.name} failed:`, error);
        
        // Add to excluded instances
        excludedInstanceIds.push(instance.id);
      }
    }
    
    throw new Error('Failover timeout exceeded');
  }

  /**
   * Failover to another instance for a transaction
   */
  private async failoverTransaction<T>(callback: (client: any) => Promise<T>, excludedInstanceIds: string[]): Promise<T> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < this.config.failoverTimeout) {
      const instance = this.getInstance();
      
      if (!instance) {
        throw new Error('No active database instances available for failover');
      }
      
      // Skip excluded instances
      if (excludedInstanceIds.includes(instance.id)) {
        continue;
      }
      
      const pool = this.getPool(instance.id);
      
      if (!pool) {
        continue;
      }
      
      const client = await pool.connect();
      
      try {
        logger.info(`Attempting transaction failover to instance: ${instance.name}`);
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        logger.info(`Transaction failover to instance ${instance.name} successful`);
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`Transaction failover to instance ${instance.name} failed:`, error);
        
        // Add to excluded instances
        excludedInstanceIds.push(instance.id);
      } finally {
        client.release();
      }
    }
    
    throw new Error('Transaction failover timeout exceeded');
  }

  /**
   * Round-robin load balancing strategy
   */
  private roundRobin(instances: DatabaseInstance[]): DatabaseInstance {
    const instance = instances[this.currentIndex % instances.length];
    this.currentIndex = (this.currentIndex + 1) % instances.length;
    return instance;
  }

  /**
   * Weighted round-robin load balancing strategy
   */
  private weightedRoundRobin(instances: DatabaseInstance[]): DatabaseInstance {
    // Calculate total weight
    const totalWeight = instances.reduce((sum, instance) => sum + instance.weight, 0);
    
    // Generate a random number between 0 and total weight
    let random = Math.random() * totalWeight;
    
    // Select an instance based on weight
    for (const instance of instances) {
      random -= instance.weight;
      if (random <= 0) {
        return instance;
      }
    }
    
    // Fallback to the last instance
    return instances[instances.length - 1];
  }

  /**
   * Least connections load balancing strategy
   */
  private leastConnections(instances: DatabaseInstance[]): DatabaseInstance {
    return instances.reduce((min, instance) => 
      instance.queryCount < min.queryCount ? instance : min
    );
  }

  /**
   * Response time load balancing strategy
   */
  private responseTime(instances: DatabaseInstance[]): DatabaseInstance {
    return instances.reduce((min, instance) => 
      instance.responseTime < min.responseTime ? instance : min
    );
  }

  /**
   * Start health checks
   */
  private startHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.healthCheckInterval = setInterval(async () => {
      await this.checkHealth();
    }, this.config.healthCheckInterval);
  }

  /**
   * Check the health of all database instances
   */
  private async checkHealth(): Promise<void> {
    try {
      for (const [instanceId, instance] of this.instances.entries()) {
        const pool = this.pools.get(instanceId);
        
        if (!pool) {
          continue;
        }
        
        const startTime = Date.now();
        
        try {
          // Execute a simple query to check if the connection is alive
          await pool.query('SELECT 1');
          
          // Update instance health
          instance.isActive = true;
          instance.errorCount = 0;
          instance.lastChecked = new Date();
          
          // Update response time
          const endTime = Date.now();
          const responseTime = endTime - startTime;
          
          // Use exponential moving average for response time
          const alpha = 0.1;
          instance.responseTime = alpha * responseTime + (1 - alpha) * instance.responseTime;
          
          logger.debug(`Health check passed for instance: ${instance.name}`);
        } catch (error) {
          // Mark instance as inactive
          this.markInstanceInactive(instanceId);
          logger.error(`Health check failed for instance: ${instance.name}`, error);
        }
      }
    } catch (error) {
      logger.error('Failed to check health of database instances', error);
    }
  }

  /**
   * Mark an instance as inactive
   */
  private markInstanceInactive(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    
    if (!instance) {
      return;
    }
    
    instance.isActive = false;
    logger.warn(`Marked instance as inactive: ${instance.name}`);
    
    // Emit event
    this.emit('instance-inactive', instance);
  }

  /**
   * Mark an instance as active
   */
  markInstanceActive(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    
    if (!instance) {
      return;
    }
    
    instance.isActive = true;
    instance.errorCount = 0;
    logger.info(`Marked instance as active: ${instance.name}`);
    
    // Emit event
    this.emit('instance-active', instance);
  }

  /**
   * Get all database instances
   */
  getInstances(): DatabaseInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get active database instances
   */
  getActiveInstances(): DatabaseInstance[] {
    return Array.from(this.instances.values())
      .filter(instance => instance.isActive);
  }

  /**
   * Get the current load balancing strategy
   */
  getStrategy(): LoadBalancingStrategy {
    return this.strategy;
  }

  /**
   * Set the load balancing strategy
   */
  setStrategy(strategy: LoadBalancingStrategy): void {
    this.strategy = strategy;
    logger.info(`Set load balancing strategy to: ${strategy}`);
  }

  /**
   * Update the load balancing configuration
   */
  updateConfig(config: Partial<LoadBalancingConfig>): void {
    this.config = {
      ...this.config,
      ...config
    };
    
    // Restart health checks if interval changed
    if (config.healthCheckInterval) {
      this.startHealthChecks();
    }
    
    // Update strategy based on config
    if (config.useWeightedRoundRobin) {
      this.strategy = 'weighted-round-robin';
    } else if (config.useLeastConnections) {
      this.strategy = 'least-connections';
    } else if (config.useResponseTime) {
      this.strategy = 'response-time';
    } else {
      this.strategy = 'round-robin';
    }
    
    logger.info('Updated load balancing configuration');
  }

  /**
   * End all connection pools
   */
  async end(): Promise<void> {
    try {
      logger.info('Ending all connection pools');
      
      // Stop health checks
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
      
      // End all connection pools
      const endPromises = Array.from(this.pools.values()).map(pool => pool.end());
      await Promise.all(endPromises);
      
      // Clear maps
      this.pools.clear();
      
      logger.info('All connection pools ended successfully');
    } catch (error) {
      logger.error('Failed to end connection pools', error);
      throw error;
    }
  }
} 