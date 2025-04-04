import { Pool, PoolConfig } from 'pg';
import { logger } from '../utils/logger';

export type ShardingStrategy = 'modulo' | 'range' | 'geographic' | 'composite' | 'dynamic';

interface ShardConfig {
  id: number;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  region?: string; // For geographic sharding
  rangeStart?: number; // For range sharding
  rangeEnd?: number; // For range sharding
}

export interface ShardingConfig {
  shards: ShardConfig[];
  shardCount: number;
  defaultShard: number;
  strategy: ShardingStrategy;
  // Additional configuration based on strategy
  moduloConfig?: {
    // No additional config needed for modulo
  };
  rangeConfig?: {
    ranges: Array<{ start: number; end: number; shardId: number }>;
  };
  geographicConfig?: {
    regions: Record<string, number[]>; // region -> shardIds
  };
  compositeConfig?: {
    primaryStrategy: ShardingStrategy;
    secondaryStrategy: ShardingStrategy;
  };
  dynamicConfig?: {
    rebalanceThreshold: number;
    minShardSize: number;
    maxShardSize: number;
  };
}

export class ShardingService {
  private static instance: ShardingService;
  private shardPools: Map<number, Pool>;
  private config: ShardingConfig;
  private isInitialized: boolean = false;
  private metrics: {
    queries: Map<number, number>;
    lastRebalance: Date;
  };

  private constructor() {
    this.shardPools = new Map();
    this.config = {
      shards: [],
      shardCount: 0,
      defaultShard: 0,
      strategy: 'modulo'
    };
    this.metrics = {
      queries: new Map(),
      lastRebalance: new Date()
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
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000,
        };

        const pool = new Pool(poolConfig);
        
        // Test the connection
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();

        this.shardPools.set(shard.id, pool);
        this.metrics.queries.set(shard.id, 0);
        logger.info(`Initialized connection pool for shard ${shard.id}`);
      }

      this.isInitialized = true;
      logger.info('ShardingService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize ShardingService:', error);
      throw new Error('Failed to initialize sharding service');
    }
  }

  private getShardKeyModulo(userId: number): number {
    return userId % this.config.shardCount;
  }

  private getShardKeyRange(userId: number): number {
    if (!this.config.rangeConfig) {
      throw new Error('Range configuration not provided');
    }

    for (const range of this.config.rangeConfig.ranges) {
      if (userId >= range.start && userId <= range.end) {
        return range.shardId;
      }
    }

    return this.config.defaultShard;
  }

  private getShardKeyGeographic(region: string): number {
    if (!this.config.geographicConfig) {
      throw new Error('Geographic configuration not provided');
    }

    const shardIds = this.config.geographicConfig.regions[region];
    if (!shardIds || shardIds.length === 0) {
      return this.config.defaultShard;
    }

    // Simple round-robin for now, could be enhanced
    return shardIds[0];
  }

  private getShardKeyComposite(userId: number, region?: string): number {
    if (!this.config.compositeConfig) {
      throw new Error('Composite configuration not provided');
    }

    const primaryKey = this.getShardKey(userId, region);
    const secondaryKey = this.getShardKey(userId, region);

    // Combine keys in a way that ensures even distribution
    return (primaryKey + secondaryKey) % this.config.shardCount;
  }

  public getShardKey(userId: number, region?: string): number {
    if (!this.isInitialized) {
      throw new Error('ShardingService not initialized');
    }

    switch (this.config.strategy) {
      case 'modulo':
        return this.getShardKeyModulo(userId);
      case 'range':
        return this.getShardKeyRange(userId);
      case 'geographic':
        if (!region) {
          throw new Error('Region required for geographic sharding');
        }
        return this.getShardKeyGeographic(region);
      case 'composite':
        return this.getShardKeyComposite(userId, region);
      case 'dynamic':
        // Dynamic sharding would involve more complex logic
        // For now, fall back to modulo
        return this.getShardKeyModulo(userId);
      default:
        return this.config.defaultShard;
    }
  }

  public async getShardPool(userId: number, region?: string): Promise<Pool> {
    if (!this.isInitialized) {
      throw new Error('ShardingService not initialized');
    }

    const shardId = this.getShardKey(userId, region);
    const pool = this.shardPools.get(shardId);

    if (!pool) {
      logger.error(`No connection pool found for shard ${shardId}`);
      throw new Error(`No connection pool found for shard ${shardId}`);
    }

    // Update metrics
    const currentQueries = this.metrics.queries.get(shardId) || 0;
    this.metrics.queries.set(shardId, currentQueries + 1);

    return pool;
  }

  public async executeQuery<T extends Record<string, any>>(
    userId: number,
    query: string,
    params?: any[],
    region?: string
  ): Promise<T[]> {
    const pool = await this.getShardPool(userId, region);
    const result = await pool.query<T>(query, params);
    return result.rows;
  }

  public async executeTransaction<T>(
    userId: number,
    callback: (client: any) => Promise<T>,
    region?: string
  ): Promise<T> {
    const pool = await this.getShardPool(userId, region);
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
    const results = new Map<number, boolean>();

    for (const [shardId, pool] of this.shardPools) {
      try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        results.set(shardId, true);
      } catch (error) {
        logger.error(`Health check failed for shard ${shardId}:`, error);
        results.set(shardId, false);
      }
    }

    return results;
  }

  public getMetrics(): { queries: Map<number, number>; lastRebalance: Date } {
    return this.metrics;
  }

  public async cleanup(): Promise<void> {
    for (const pool of this.shardPools.values()) {
      await pool.end();
    }
    this.shardPools.clear();
    this.isInitialized = false;
  }
} 