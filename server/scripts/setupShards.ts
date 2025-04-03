import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { ShardingService } from '../services/sharding';
import { ShardMigration } from '../utils/shardMigration';
import { getShardingConfig } from '../config/sharding';

async function setupShards() {
  try {
    // Initialize sharding service
    const shardingService = ShardingService.getInstance();
    const config = getShardingConfig();
    await shardingService.initialize(config);

    // Create shard migration utility
    const shardMigration = new ShardMigration();

    // Create tables in each shard
    for (const shard of config.shards) {
      await shardMigration.createShardTables(shard.id);
    }

    // Connect to the source database (assuming it's the first shard)
    const sourcePool = new Pool({
      host: config.shards[0].host,
      port: config.shards[0].port,
      database: config.shards[0].database,
      user: config.shards[0].user,
      password: config.shards[0].password,
    });

    // Get all users from the source database
    const usersResult = await sourcePool.query('SELECT id FROM users');
    const users = usersResult.rows;

    // Migrate each user's data to their target shard
    for (const user of users) {
      const targetShardId = shardingService.getShardKey(user.id);
      const targetPool = await shardingService.getShardPool(user.id);

      try {
        // Migrate user data
        await shardMigration.migrateUserData(user.id, sourcePool, targetPool);

        // Verify migration
        const isVerified = await shardMigration.verifyMigration(
          user.id,
          sourcePool,
          targetPool
        );

        if (isVerified) {
          logger.info(`Successfully migrated and verified data for user ${user.id}`);
        } else {
          logger.error(`Migration verification failed for user ${user.id}`);
        }
      } catch (error) {
        logger.error(`Failed to migrate data for user ${user.id}:`, error);
      }
    }

    // Clean up
    await sourcePool.end();
    await shardingService.cleanup();

    logger.info('Shard setup completed successfully');
  } catch (error) {
    logger.error('Failed to setup shards:', error);
    process.exit(1);
  }
}

// Run the setup
setupShards(); 