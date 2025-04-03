import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { TimeSeriesShardingService, TimeSeriesShardingConfig } from '../services/timeSeriesSharding';
import { TimeSeriesMigration } from '../utils/timeSeriesMigration';

/**
 * Sets up time-series sharding for the database
 */
async function setupTimeSeriesSharding() {
  logger.info('Setting up time-series sharding');
  
  // Define sharding configuration
  const shardingConfig: TimeSeriesShardingConfig = {
    shardCount: 12, // 12 shards for monthly data
    timeInterval: 'month',
    retentionPeriod: 24, // Keep 24 months of data
    createFutureShards: true,
    futureShardCount: 12, // Create 12 months of future shards
    shardConfigs: [
      { id: 0, host: 'localhost', port: 5432, database: 'vici_shard_0', user: 'postgres', password: 'postgres' },
      { id: 1, host: 'localhost', port: 5432, database: 'vici_shard_1', user: 'postgres', password: 'postgres' },
      { id: 2, host: 'localhost', port: 5432, database: 'vici_shard_2', user: 'postgres', password: 'postgres' },
      { id: 3, host: 'localhost', port: 5432, database: 'vici_shard_3', user: 'postgres', password: 'postgres' },
      { id: 4, host: 'localhost', port: 5432, database: 'vici_shard_4', user: 'postgres', password: 'postgres' },
      { id: 5, host: 'localhost', port: 5432, database: 'vici_shard_5', user: 'postgres', password: 'postgres' },
      { id: 6, host: 'localhost', port: 5432, database: 'vici_shard_6', user: 'postgres', password: 'postgres' },
      { id: 7, host: 'localhost', port: 5432, database: 'vici_shard_7', user: 'postgres', password: 'postgres' },
      { id: 8, host: 'localhost', port: 5432, database: 'vici_shard_8', user: 'postgres', password: 'postgres' },
      { id: 9, host: 'localhost', port: 5432, database: 'vici_shard_9', user: 'postgres', password: 'postgres' },
      { id: 10, host: 'localhost', port: 5432, database: 'vici_shard_10', user: 'postgres', password: 'postgres' },
      { id: 11, host: 'localhost', port: 5432, database: 'vici_shard_11', user: 'postgres', password: 'postgres' }
    ]
  };
  
  // Initialize sharding service
  const shardingService = new TimeSeriesShardingService(shardingConfig);
  
  // Connect to the source database
  const sourcePool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'vici',
    user: 'postgres',
    password: 'postgres'
  });
  
  try {
    // Create shards for the past 24 months and future 12 months
    const now = new Date();
    const startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - 24);
    
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + 12);
    
    logger.info(`Creating shards from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    await shardingService.createShardsForTimeRange(startDate, endDate);
    
    // Create migration utility
    const migration = new TimeSeriesMigration(shardingService);
    
    // Migrate data for each month
    let currentDate = new Date(startDate);
    while (currentDate <= now) {
      const monthStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const monthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59, 999);
      
      // Get the target shard for this month
      const targetShardId = shardingService.getShardForTimestamp(monthStart);
      const targetPool = shardingService.getShardPool(targetShardId);
      
      logger.info(`Migrating data for ${monthStart.toISOString()} to shard ${targetShardId}`);
      
      // Migrate data for this month
      await migration.migrateTimeRange(monthStart, monthEnd, sourcePool, targetPool);
      
      // Verify migration
      const verified = await migration.verifyMigration(monthStart, monthEnd, sourcePool, targetPool);
      if (!verified) {
        logger.error(`Migration verification failed for ${monthStart.toISOString()}`);
        throw new Error(`Migration verification failed for ${monthStart.toISOString()}`);
      }
      
      // Move to the next month
      currentDate.setMonth(currentDate.getMonth() + 1);
    }
    
    // Create future shards
    logger.info('Creating future shards');
    await shardingService.createFutureShards();
    
    logger.info('Time-series sharding setup completed successfully');
  } catch (error) {
    logger.error('Time-series sharding setup failed', { error });
    throw error;
  } finally {
    // Close database connections
    await sourcePool.end();
    await shardingService.closeAllConnections();
  }
}

// Run the setup
setupTimeSeriesSharding()
  .then(() => {
    logger.info('Time-series sharding setup completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Time-series sharding setup failed', { error });
    process.exit(1);
  }); 