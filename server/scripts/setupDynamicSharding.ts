import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { DynamicShardingService, DynamicShardingConfig } from '../services/dynamicSharding';

/**
 * Sets up dynamic sharding for the database with automatic scaling
 */
async function setupDynamicSharding() {
  logger.info('Setting up dynamic sharding');
  
  // Define initial sharding configuration
  const shardingConfig: DynamicShardingConfig = {
    initialShardCount: 4,
    maxShardCount: 16,
    minShardCount: 2,
    loadThreshold: 0.8, // 80% load threshold for scaling
    shardConfigs: [
      { id: 0, host: 'localhost', port: 5432, database: 'vici_dyn_0', user: 'postgres', password: 'postgres' },
      { id: 1, host: 'localhost', port: 5432, database: 'vici_dyn_1', user: 'postgres', password: 'postgres' },
      { id: 2, host: 'localhost', port: 5432, database: 'vici_dyn_2', user: 'postgres', password: 'postgres' },
      { id: 3, host: 'localhost', port: 5432, database: 'vici_dyn_3', user: 'postgres', password: 'postgres' }
    ],
    monitoringInterval: 300000, // 5 minutes
    rebalanceThreshold: 0.2 // 20% imbalance threshold
  };
  
  // Initialize dynamic sharding service
  const shardingService = new DynamicShardingService(shardingConfig);
  
  // Connect to the source database
  const sourcePool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'vici',
    user: 'postgres',
    password: 'postgres'
  });
  
  try {
    // Initialize shards
    logger.info('Initializing shards');
    await shardingService.initializeShards();
    
    // Start monitoring service
    logger.info('Starting shard monitoring');
    await shardingService.startMonitoring();
    
    // Get all users from the source database
    const usersResult = await sourcePool.query(
      `SELECT * FROM users`
    );
    
    const users = usersResult.rows;
    logger.info(`Found ${users.length} users to migrate`);
    
    // Migrate users with automatic load balancing
    for (const user of users) {
      try {
        await shardingService.migrateEntity('users', user.id, sourcePool);
      } catch (error) {
        logger.error(`Failed to migrate user ${user.id}`, { error });
        // Continue with the next user
      }
    }
    
    // Get all training plans
    const trainingPlansResult = await sourcePool.query(
      `SELECT * FROM training_plans`
    );
    
    const trainingPlans = trainingPlansResult.rows;
    logger.info(`Found ${trainingPlans.length} training plans to migrate`);
    
    // Migrate training plans with automatic load balancing
    for (const plan of trainingPlans) {
      try {
        await shardingService.migrateEntity('training_plans', plan.id, sourcePool);
      } catch (error) {
        logger.error(`Failed to migrate training plan ${plan.id}`, { error });
        // Continue with the next training plan
      }
    }
    
    // Get all workout notes
    const workoutNotesResult = await sourcePool.query(
      `SELECT * FROM workout_notes`
    );
    
    const workoutNotes = workoutNotesResult.rows;
    logger.info(`Found ${workoutNotes.length} workout notes to migrate`);
    
    // Migrate workout notes with automatic load balancing
    for (const note of workoutNotes) {
      try {
        await shardingService.migrateEntity('workout_notes', note.id, sourcePool);
      } catch (error) {
        logger.error(`Failed to migrate workout note ${note.id}`, { error });
        // Continue with the next workout note
      }
    }
    
    // Start automatic scaling
    logger.info('Starting automatic scaling');
    await shardingService.startAutoScaling();
    
    logger.info('Dynamic sharding setup completed successfully');
  } catch (error) {
    logger.error('Dynamic sharding setup failed', { error });
    throw error;
  } finally {
    // Close source database connection
    await sourcePool.end();
  }
}

// Run the setup
setupDynamicSharding()
  .then(() => {
    logger.info('Dynamic sharding setup completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Dynamic sharding setup failed', { error });
    process.exit(1);
  }); 