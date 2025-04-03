import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { CompositeShardingService, CompositeShardingConfig, ShardKeyComponent } from '../services/compositeSharding';

/**
 * Sets up composite sharding for the database
 */
async function setupCompositeSharding() {
  logger.info('Setting up composite sharding');
  
  // Define shard key components
  const shardKeyComponents: ShardKeyComponent[] = [
    {
      name: 'id',
      weight: 1,
      extractValue: (entity: any) => entity.id
    },
    {
      name: 'country',
      weight: 100,
      extractValue: (entity: any) => entity.country
    },
    {
      name: 'createdAt',
      weight: 1000,
      extractValue: (entity: any) => entity.created_at ? new Date(entity.created_at) : null
    }
  ];
  
  // Define sharding configuration
  const shardingConfig: CompositeShardingConfig = {
    shardCount: 8, // 8 shards for composite data
    defaultShardId: 0,
    shardKeyComponents,
    shardConfigs: [
      { id: 0, host: 'localhost', port: 5432, database: 'vici_comp_0', user: 'postgres', password: 'postgres' },
      { id: 1, host: 'localhost', port: 5432, database: 'vici_comp_1', user: 'postgres', password: 'postgres' },
      { id: 2, host: 'localhost', port: 5432, database: 'vici_comp_2', user: 'postgres', password: 'postgres' },
      { id: 3, host: 'localhost', port: 5432, database: 'vici_comp_3', user: 'postgres', password: 'postgres' },
      { id: 4, host: 'localhost', port: 5432, database: 'vici_comp_4', user: 'postgres', password: 'postgres' },
      { id: 5, host: 'localhost', port: 5432, database: 'vici_comp_5', user: 'postgres', password: 'postgres' },
      { id: 6, host: 'localhost', port: 5432, database: 'vici_comp_6', user: 'postgres', password: 'postgres' },
      { id: 7, host: 'localhost', port: 5432, database: 'vici_comp_7', user: 'postgres', password: 'postgres' }
    ]
  };
  
  // Initialize sharding service
  const shardingService = new CompositeShardingService(shardingConfig);
  
  // Connect to the source database
  const sourcePool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'vici',
    user: 'postgres',
    password: 'postgres'
  });
  
  try {
    // Create shards
    for (let i = 0; i < shardingConfig.shardCount; i++) {
      logger.info(`Creating shard ${i}`);
      await shardingService.createShard(i);
    }
    
    // Get all users from the source database
    const usersResult = await sourcePool.query(
      `SELECT * FROM users`
    );
    
    const users = usersResult.rows;
    logger.info(`Found ${users.length} users to migrate`);
    
    // Migrate each user to the appropriate shard
    for (const user of users) {
      try {
        await shardingService.migrateEntity('users', user.id, sourcePool);
      } catch (error) {
        logger.error(`Failed to migrate user ${user.id}`, { error });
        // Continue with the next user
      }
    }
    
    // Get all training plans from the source database
    const trainingPlansResult = await sourcePool.query(
      `SELECT * FROM training_plans`
    );
    
    const trainingPlans = trainingPlansResult.rows;
    logger.info(`Found ${trainingPlans.length} training plans to migrate`);
    
    // Migrate each training plan to the appropriate shard
    for (const plan of trainingPlans) {
      try {
        await shardingService.migrateEntity('training_plans', plan.id, sourcePool);
      } catch (error) {
        logger.error(`Failed to migrate training plan ${plan.id}`, { error });
        // Continue with the next training plan
      }
    }
    
    // Get all workout notes from the source database
    const workoutNotesResult = await sourcePool.query(
      `SELECT * FROM workout_notes`
    );
    
    const workoutNotes = workoutNotesResult.rows;
    logger.info(`Found ${workoutNotes.length} workout notes to migrate`);
    
    // Migrate each workout note to the appropriate shard
    for (const note of workoutNotes) {
      try {
        await shardingService.migrateEntity('workout_notes', note.id, sourcePool);
      } catch (error) {
        logger.error(`Failed to migrate workout note ${note.id}`, { error });
        // Continue with the next workout note
      }
    }
    
    logger.info('Composite sharding setup completed successfully');
  } catch (error) {
    logger.error('Composite sharding setup failed', { error });
    throw error;
  } finally {
    // Close database connections
    await sourcePool.end();
    await shardingService.closeAllConnections();
  }
}

// Run the setup
setupCompositeSharding()
  .then(() => {
    logger.info('Composite sharding setup completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Composite sharding setup failed', { error });
    process.exit(1);
  }); 