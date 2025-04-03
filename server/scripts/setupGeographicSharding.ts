import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { GeographicShardingService, GeographicShardingConfig } from '../services/geographicSharding';

/**
 * Sets up geographic sharding for the database
 */
async function setupGeographicSharding() {
  logger.info('Setting up geographic sharding');
  
  // Define sharding configuration
  const shardingConfig: GeographicShardingConfig = {
    shardCount: 5, // 5 shards for different regions
    shardingLevel: 'region',
    defaultShardId: 0,
    regionShardMap: {
      'North America': 0,
      'Europe': 1,
      'Asia': 2,
      'South America': 3,
      'Africa': 4
    },
    shardConfigs: [
      { id: 0, host: 'localhost', port: 5432, database: 'vici_na', user: 'postgres', password: 'postgres' },
      { id: 1, host: 'localhost', port: 5432, database: 'vici_eu', user: 'postgres', password: 'postgres' },
      { id: 2, host: 'localhost', port: 5432, database: 'vici_as', user: 'postgres', password: 'postgres' },
      { id: 3, host: 'localhost', port: 5432, database: 'vici_sa', user: 'postgres', password: 'postgres' },
      { id: 4, host: 'localhost', port: 5432, database: 'vici_af', user: 'postgres', password: 'postgres' }
    ]
  };
  
  // Initialize sharding service
  const shardingService = new GeographicShardingService(shardingConfig);
  
  // Connect to the source database
  const sourcePool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'vici',
    user: 'postgres',
    password: 'postgres'
  });
  
  try {
    // Create shards for each region
    for (const region of Object.keys(shardingConfig.regionShardMap)) {
      logger.info(`Creating shards for region ${region}`);
      await shardingService.createShardsForRegion(region);
    }
    
    // Create shard for the default region
    logger.info('Creating shard for default region');
    await shardingService.createShardsForRegion('default');
    
    // Get all users from the source database
    const usersResult = await sourcePool.query(
      `SELECT id, country, region, city FROM users`
    );
    
    const users = usersResult.rows;
    logger.info(`Found ${users.length} users to migrate`);
    
    // Migrate each user to the appropriate shard
    for (const user of users) {
      try {
        await shardingService.migrateUserByLocation(user.id, sourcePool);
      } catch (error) {
        logger.error(`Failed to migrate user ${user.id}`, { error });
        // Continue with the next user
      }
    }
    
    logger.info('Geographic sharding setup completed successfully');
  } catch (error) {
    logger.error('Geographic sharding setup failed', { error });
    throw error;
  } finally {
    // Close database connections
    await sourcePool.end();
    await shardingService.closeAllConnections();
  }
}

// Run the setup
setupGeographicSharding()
  .then(() => {
    logger.info('Geographic sharding setup completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Geographic sharding setup failed', { error });
    process.exit(1);
  }); 