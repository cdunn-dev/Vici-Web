import { Pool } from 'pg';
import { logger } from './logger';
import { ShardingService } from '../services/shardingService';

/**
 * Configuration for shard rebalancing
 */
interface RebalancingConfig {
  /**
   * Minimum load percentage difference to trigger rebalancing
   */
  loadThreshold: number;
  
  /**
   * Maximum number of rows to move in a single batch
   */
  batchSize: number;
  
  /**
   * Delay between batches in milliseconds
   */
  batchDelay: number;
  
  /**
   * Whether to validate data after rebalancing
   */
  validateAfterRebalancing: boolean;
}

interface ShardLoad {
  shardId: number;
  loadPercentage: number;
  rowCount: number;
}

/**
 * Utility for rebalancing data across shards
 */
export class ShardRebalancing {
  private pool: Pool;
  private shardingService: ShardingService;
  private config: RebalancingConfig;
  
  /**
   * Creates a new ShardRebalancing utility
   * @param pool The database connection pool
   * @param shardingService The sharding service
   * @param config Rebalancing configuration
   */
  constructor(
    pool: Pool,
    shardingService: ShardingService,
    config: RebalancingConfig
  ) {
    this.pool = pool;
    this.shardingService = shardingService;
    this.config = config;
  }
  
  /**
   * Rebalances data across all shards
   * @returns Promise that resolves when rebalancing is complete
   */
  public async rebalanceAllShards(): Promise<void> {
    try {
      const shardLoads = await this.calculateShardLoads();
      const { overloadedShards, underloadedShards } = this.identifyShardsForRebalancing(shardLoads);

      for (const sourceShard of overloadedShards) {
        for (const targetShard of underloadedShards) {
          if (sourceShard.loadPercentage - targetShard.loadPercentage > this.config.loadThreshold) {
            await this.moveDataBetweenShards(sourceShard.shardId, targetShard.shardId);
          }
        }
      }

      if (this.config.validateAfterRebalancing) {
        await this.validateRebalancing();
      }
    } catch (error) {
      logger.error('Failed to rebalance shards:', error);
      throw error;
    }
  }
  
  /**
   * Calculates load for each shard
   * @returns Array of ShardLoad objects
   */
  private async calculateShardLoads(): Promise<ShardLoad[]> {
    const shardCount = await this.shardingService.getShardCount();
    const shardLoads: ShardLoad[] = [];

    for (let shardId = 0; shardId < shardCount; shardId++) {
      const result = await this.pool.query(
        'SELECT COUNT(*) as count FROM shard_data WHERE shard_id = $1',
        [shardId]
      );
      const rowCount = parseInt(result.rows[0].count);
      const loadPercentage = (rowCount / 1000000) * 100; // Assuming max 1M rows per shard

      shardLoads.push({
        shardId,
        loadPercentage,
        rowCount
      });
    }

    return shardLoads;
  }
  
  /**
   * Identifies shards that need rebalancing
   * @param shardLoads Array of ShardLoad objects
   * @returns Object containing overloaded and underloaded shards
   */
  private identifyShardsForRebalancing(shardLoads: ShardLoad[]): {
    overloadedShards: ShardLoad[];
    underloadedShards: ShardLoad[];
  } {
    const sortedLoads = [...shardLoads].sort((a, b) => b.loadPercentage - a.loadPercentage);
    const medianLoad = sortedLoads[Math.floor(sortedLoads.length / 2)].loadPercentage;

    return {
      overloadedShards: sortedLoads.filter(shard => shard.loadPercentage > medianLoad + this.config.loadThreshold),
      underloadedShards: sortedLoads.filter(shard => shard.loadPercentage < medianLoad - this.config.loadThreshold)
    };
  }
  
  /**
   * Moves data from one shard to another
   * @param sourceShardId Source shard ID
   * @param targetShardId Target shard ID
   * @returns Promise that resolves when data movement is complete
   */
  private async moveDataBetweenShards(sourceShardId: number, targetShardId: number): Promise<void> {
    try {
      const result = await this.pool.query(
        `SELECT id FROM shard_data 
         WHERE shard_id = $1 
         ORDER BY id 
         LIMIT $2`,
        [sourceShardId, this.config.batchSize]
      );

      if (result.rows.length === 0) {
        return;
      }

      const ids = result.rows.map(row => row.id);
      await this.pool.query(
        `UPDATE shard_data 
         SET shard_id = $1 
         WHERE id = ANY($2)`,
        [targetShardId, ids]
      );

      await new Promise(resolve => setTimeout(resolve, this.config.batchDelay));
    } catch (error) {
      logger.error(`Failed to move data from shard ${sourceShardId} to ${targetShardId}:`, error);
      throw error;
    }
  }
  
  /**
   * Validates the rebalancing operation
   * @returns Promise that resolves when validation is complete
   */
  private async validateRebalancing(): Promise<void> {
    const shardLoads = await this.calculateShardLoads();
    const { overloadedShards, underloadedShards } = this.identifyShardsForRebalancing(shardLoads);

    if (overloadedShards.length > 0 || underloadedShards.length > 0) {
      logger.warn('Rebalancing validation failed: Some shards are still imbalanced');
    } else {
      logger.info('Rebalancing validation successful: All shards are balanced');
    }
  }
} 