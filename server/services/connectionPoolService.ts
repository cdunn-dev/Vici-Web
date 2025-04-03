import { Pool, PoolConfig } from 'pg';
import { logger } from '../utils/logger';

interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  activeCount: number;
  maxWaitTime: number;
  avgWaitTime: number;
  timestamp: Date;
}

interface PoolConfigOptions extends PoolConfig {
  minSize?: number;
  maxSize?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  maxUses?: number;
  healthCheckInterval?: number;
}

export class ConnectionPoolService {
  private pool: Pool;
  private config: PoolConfigOptions;
  private metrics: PoolMetrics[] = [];
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isInitialized = false;

  constructor(config: PoolConfigOptions) {
    this.config = {
      minSize: 5,
      maxSize: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      maxUses: 7500,
      healthCheckInterval: 30000,
      ...config
    };

    this.pool = new Pool(this.config);
    
    // Set up event listeners
    this.pool.on('connect', () => {
      logger.debug('New client connected to the pool');
    });
    
    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
    });
    
    this.pool.on('remove', () => {
      logger.debug('Client removed from the pool');
    });
  }

  /**
   * Initialize the connection pool
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Initializing connection pool');
      
      // Create the minimum number of connections
      const initialConnections = Math.min(this.config.minSize || 5, this.config.maxSize || 20);
      const connectionPromises = [];
      
      for (let i = 0; i < initialConnections; i++) {
        connectionPromises.push(this.pool.connect());
      }
      
      // Wait for all connections to be established
      await Promise.all(connectionPromises);
      
      // Start collecting metrics
      this.startMetricsCollection();
      
      // Start health checks
      this.startHealthChecks();
      
      this.isInitialized = true;
      logger.info('Connection pool initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize connection pool:', error);
      throw error;
    }
  }

  /**
   * Get a client from the pool
   */
  async getClient(): Promise<any> {
    try {
      const client = await this.pool.connect();
      return client;
    } catch (error) {
      logger.error('Failed to get client from pool:', error);
      throw error;
    }
  }

  /**
   * Release a client back to the pool
   */
  releaseClient(client: any): void {
    try {
      client.release();
    } catch (error) {
      logger.error('Failed to release client to pool:', error);
    }
  }

  /**
   * Execute a query using a client from the pool
   */
  async query(text: string, params?: any[]): Promise<any> {
    const client = await this.getClient();
    
    try {
      const result = await client.query(text, params);
      return result;
    } catch (error) {
      logger.error('Query execution failed:', error);
      throw error;
    } finally {
      this.releaseClient(client);
    }
  }

  /**
   * Execute a transaction using a client from the pool
   */
  async transaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Transaction failed:', error);
      throw error;
    } finally {
      this.releaseClient(client);
    }
  }

  /**
   * Start collecting pool metrics
   */
  private startMetricsCollection(): void {
    // Collect metrics every minute
    setInterval(async () => {
      try {
        const metrics = await this.collectPoolMetrics();
        this.metrics.push(metrics);
        
        // Keep only the last 24 hours of metrics
        const oneDayAgo = new Date();
        oneDayAgo.setDate(oneDayAgo.getDate() - 1);
        
        this.metrics = this.metrics.filter(m => m.timestamp >= oneDayAgo);
      } catch (error) {
        logger.error('Failed to collect pool metrics:', error);
      }
    }, 60000);
  }

  /**
   * Collect metrics about the pool
   */
  private async collectPoolMetrics(): Promise<PoolMetrics> {
    try {
      // Get pool statistics
      const totalCount = this.pool.totalCount;
      const idleCount = this.pool.idleCount;
      const waitingCount = this.pool.waitingCount;
      const activeCount = totalCount - idleCount;
      
      // Calculate wait times
      const maxWaitTime = this.pool.options.connectionTimeoutMillis || 0;
      const avgWaitTime = maxWaitTime / 2; // Simplified calculation
      
      return {
        totalCount,
        idleCount,
        waitingCount,
        activeCount,
        maxWaitTime,
        avgWaitTime,
        timestamp: new Date()
      };
    } catch (error) {
      logger.error('Failed to collect pool metrics:', error);
      throw error;
    }
  }

  /**
   * Start health checks for the pool
   */
  private startHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.checkPoolHealth();
      } catch (error) {
        logger.error('Pool health check failed:', error);
      }
    }, this.config.healthCheckInterval || 30000);
  }

  /**
   * Check the health of the pool
   */
  private async checkPoolHealth(): Promise<void> {
    try {
      const client = await this.getClient();
      
      try {
        // Execute a simple query to check if the connection is alive
        await client.query('SELECT 1');
        logger.debug('Pool health check passed');
      } finally {
        this.releaseClient(client);
      }
    } catch (error) {
      logger.error('Pool health check failed:', error);
      
      // If the health check fails, try to restart the pool
      await this.restartPool();
    }
  }

  /**
   * Restart the pool
   */
  private async restartPool(): Promise<void> {
    try {
      logger.info('Restarting connection pool');
      
      // End the current pool
      await this.pool.end();
      
      // Create a new pool with the same configuration
      this.pool = new Pool(this.config);
      
      // Set up event listeners
      this.pool.on('connect', () => {
        logger.debug('New client connected to the pool');
      });
      
      this.pool.on('error', (err) => {
        logger.error('Unexpected error on idle client', err);
      });
      
      this.pool.on('remove', () => {
        logger.debug('Client removed from the pool');
      });
      
      // Initialize the new pool
      await this.initialize();
      
      logger.info('Connection pool restarted successfully');
    } catch (error) {
      logger.error('Failed to restart connection pool:', error);
      throw error;
    }
  }

  /**
   * Get the current pool metrics
   */
  async getCurrentMetrics(): Promise<PoolMetrics> {
    return await this.collectPoolMetrics();
  }

  /**
   * Get historical pool metrics
   */
  getHistoricalMetrics(hours: number = 24): PoolMetrics[] {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hours);
    
    return this.metrics.filter(m => m.timestamp >= cutoffTime);
  }

  /**
   * Get pool statistics
   */
  async getPoolStats(): Promise<any> {
    try {
      const metrics = await this.collectPoolMetrics();
      const historicalMetrics = this.getHistoricalMetrics(1); // Last hour
      
      // Calculate average metrics over the last hour
      const avgMetrics = historicalMetrics.reduce((acc, curr) => {
        return {
          totalCount: acc.totalCount + curr.totalCount,
          idleCount: acc.idleCount + curr.idleCount,
          waitingCount: acc.waitingCount + curr.waitingCount,
          activeCount: acc.activeCount + curr.activeCount,
          maxWaitTime: Math.max(acc.maxWaitTime, curr.maxWaitTime),
          avgWaitTime: acc.avgWaitTime + curr.avgWaitTime
        };
      }, {
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
        activeCount: 0,
        maxWaitTime: 0,
        avgWaitTime: 0
      });
      
      const count = historicalMetrics.length || 1;
      
      return {
        current: metrics,
        average: {
          totalCount: Math.round(avgMetrics.totalCount / count),
          idleCount: Math.round(avgMetrics.idleCount / count),
          waitingCount: Math.round(avgMetrics.waitingCount / count),
          activeCount: Math.round(avgMetrics.activeCount / count),
          maxWaitTime: avgMetrics.maxWaitTime,
          avgWaitTime: Math.round(avgMetrics.avgWaitTime / count)
        },
        config: {
          minSize: this.config.minSize,
          maxSize: this.config.maxSize,
          idleTimeoutMillis: this.config.idleTimeoutMillis,
          connectionTimeoutMillis: this.config.connectionTimeoutMillis,
          maxUses: this.config.maxUses
        }
      };
    } catch (error) {
      logger.error('Failed to get pool statistics:', error);
      throw error;
    }
  }

  /**
   * Update the pool configuration
   */
  async updateConfig(newConfig: Partial<PoolConfigOptions>): Promise<void> {
    try {
      logger.info('Updating connection pool configuration');
      
      // Update the configuration
      this.config = {
        ...this.config,
        ...newConfig
      };
      
      // Restart the pool to apply the new configuration
      await this.restartPool();
      
      logger.info('Connection pool configuration updated successfully');
    } catch (error) {
      logger.error('Failed to update connection pool configuration:', error);
      throw error;
    }
  }

  /**
   * End the pool
   */
  async end(): Promise<void> {
    try {
      logger.info('Ending connection pool');
      
      // Stop health checks
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
      
      // End the pool
      await this.pool.end();
      
      this.isInitialized = false;
      logger.info('Connection pool ended successfully');
    } catch (error) {
      logger.error('Failed to end connection pool:', error);
      throw error;
    }
  }
} 