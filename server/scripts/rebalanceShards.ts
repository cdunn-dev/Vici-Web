import { logger } from '../utils/logger';
import { ShardingService } from '../services/sharding';
import { ShardRebalancing, RebalancingConfig } from '../utils/shardRebalancing';

/**
 * Rebalances data across all shards
 */
async function rebalanceShards() {
  logger.info('Starting shard rebalancing process');
  
  try {
    // Initialize sharding service
    const shardingService = ShardingService.getInstance();
    
    // Define rebalancing configuration
    const rebalancingConfig: RebalancingConfig = {
      loadThreshold: 10, // 10% load difference threshold
      batchSize: 1000, // Move 1000 rows at a time
      batchDelay: 100, // 100ms delay between batches
      validateAfterRebalancing: true // Validate data after rebalancing
    };
    
    // Initialize rebalancing utility
    const rebalancing = new ShardRebalancing(shardingService, rebalancingConfig);
    
    // Perform rebalancing
    await rebalancing.rebalanceAllShards();
    
    logger.info('Shard rebalancing completed successfully');
  } catch (error) {
    logger.error('Shard rebalancing failed', { error });
    process.exit(1);
  }
}

// Run the rebalancing
rebalanceShards()
  .then(() => {
    logger.info('Shard rebalancing process completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Shard rebalancing process failed', { error });
    process.exit(1);
  }); 