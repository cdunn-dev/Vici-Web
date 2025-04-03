import { Pool, PoolConfig } from 'pg';
import { logger } from '../utils/logger';

interface ShardConfig {
  id: number;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface ShardingConfig {
  shards: ShardConfig[];
  shardCount: number;
  defaultShard: number;
}

export class ShardingService {
  private static instance: ShardingService;
  private shardPools: Map<number, Pool>;
  private config: ShardingConfig;
  private isInitialized: boolean = false;

  private constructor() {
    this.shardPools = new Map();
    this.config = {
      shards: [],
      shardCount: 0,
      defaultShard: 0
    };
  }

  public static getInstance(): ShardingService {
    if (!ShardingService.instance) {
      ShardingService.instance = new ShardingService();
    }
    return ShardingService.instance;
  }

  public async initialize(config: ShardingConfig): Promise<void> {
    if (this.isInitialized) {
      logger.warn('ShardingService is already initialized');
      return;
    }

    try {
      this.config = config;
      
      // Initialize connection pools for each shard
      for (const shard of config.shards) {
        const poolConfig: PoolConfig = {
          host: shard.host,
          port: shard.port,
          database: shard.database,
          user: shard.user,
          password: shard.password,
          max: 20, // Maximum number of clients in the pool
          idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
          connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
        };

        const pool = new Pool(poolConfig);
        
        // Test the connection
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();

        this.shardPools.set(shard.id, pool);
        logger.info(`Initialized connection pool for shard ${shard.id}`);
      }

      this.isInitialized = true;
      logger.info('ShardingService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize ShardingService:', error);
      throw new Error('Failed to initialize sharding service');
    }
  }

  public getShardKey(userId: number): number {
    if (!this.isInitialized) {
      throw new Error('ShardingService not initialized');
    }

    // Simple modulo-based sharding
    return userId % this.config.shardCount;
  }

  public async getShardPool(userId: number): Promise<Pool> {
    if (!this.isInitialized) {
      throw new Error('ShardingService not initialized');
    }

    const shardId = this.getShardKey(userId);
    const pool = this.shardPools.get(shardId);

    if (!pool) {
      logger.error(`No connection pool found for shard ${shardId}`);
      throw new Error(`No connection pool found for shard ${shardId}`);
    }

    return pool;
  }

  public async executeQuery<T>(
    userId: number,
    query: string,
    params?: any[]
  ): Promise<T[]> {
    const pool = await this.getShardPool(userId);
    
    try {
      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error(`Query execution failed on shard ${this.getShardKey(userId)}:`, error);
      throw error;
    }
  }

  public async executeTransaction<T>(
    userId: number,
    callback: (client: any) => Promise<T>
  ): Promise<T> {
    const pool = await this.getShardPool(userId);
    const client = await pool.connect();

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

  public async healthCheck(): Promise<Map<number, boolean>> {
    const healthStatus = new Map<number, boolean>();

    for (const [shardId, pool] of this.shardPools) {
      try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        healthStatus.set(shardId, true);
      } catch (error) {
        logger.error(`Health check failed for shard ${shardId}:`, error);
        healthStatus.set(shardId, false);
      }
    }

    return healthStatus;
  }

  public async cleanup(): Promise<void> {
    for (const [shardId, pool] of this.shardPools) {
      try {
        await pool.end();
        logger.info(`Closed connection pool for shard ${shardId}`);
      } catch (error) {
        logger.error(`Failed to close connection pool for shard ${shardId}:`, error);
      }
    }

    this.shardPools.clear();
    this.isInitialized = false;
  }
} 