import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { ShardingService, ShardingConfig } from './sharding';

/**
 * Shard key component for composite sharding
 */
export interface ShardKeyComponent {
  /**
   * Name of the component
   */
  name: string;
  
  /**
   * Weight of the component in the shard key calculation
   */
  weight: number;
  
  /**
   * Function to extract the component value from an entity
   */
  extractValue: (entity: any) => any;
}

/**
 * Configuration for composite sharding
 */
export interface CompositeShardingConfig extends ShardingConfig {
  /**
   * Components of the shard key
   */
  shardKeyComponents: ShardKeyComponent[];
  
  /**
   * Default shard ID for entities that don't match any shard key
   */
  defaultShardId: number;
}

/**
 * Service for managing composite-based database sharding
 * Extends the base ShardingService with multi-dimensional shard key selection
 */
export class CompositeShardingService extends ShardingService {
  private compositeConfig: CompositeShardingConfig;
  
  /**
   * Creates a new CompositeShardingService
   * @param config Sharding configuration
   */
  constructor(config: CompositeShardingConfig) {
    super(config);
    this.compositeConfig = config;
  }
  
  /**
   * Calculates the shard key for an entity
   * @param entity The entity to calculate the shard key for
   * @returns The shard key
   */
  private calculateShardKey(entity: any): number {
    let shardKey = 0;
    
    // Calculate the weighted sum of the shard key components
    for (const component of this.compositeConfig.shardKeyComponents) {
      const value = component.extractValue(entity);
      
      // Skip if the value is undefined or null
      if (value === undefined || value === null) {
        continue;
      }
      
      // Convert the value to a number
      let numericValue: number;
      
      if (typeof value === 'number') {
        numericValue = value;
      } else if (typeof value === 'string') {
        // Use a simple hash function for strings
        numericValue = this.hashString(value);
      } else if (value instanceof Date) {
        // Use the timestamp for dates
        numericValue = value.getTime();
      } else {
        // Skip if the value is not a supported type
        logger.warn(`Unsupported value type for shard key component ${component.name}`, { value });
        continue;
      }
      
      // Add the weighted value to the shard key
      shardKey += numericValue * component.weight;
    }
    
    // Map the shard key to a shard ID using modulo
    return Math.abs(shardKey) % this.config.shardCount;
  }
  
  /**
   * Simple hash function for strings
   * @param str The string to hash
   * @returns The hash value
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }
  
  /**
   * Gets the shard ID for an entity
   * @param entity The entity to get the shard for
   * @returns The shard ID
   */
  public getShardForEntity(entity: any): number {
    // Calculate the shard key
    const shardKey = this.calculateShardKey(entity);
    
    // If the shard key is invalid, use the default shard
    if (shardKey < 0 || shardKey >= this.config.shardCount) {
      logger.warn('Invalid shard key, using default shard', { shardKey });
      return this.compositeConfig.defaultShardId;
    }
    
    return shardKey;
  }
  
  /**
   * Gets the shard pool for an entity
   * @param entity The entity to get the shard for
   * @returns The shard pool
   */
  public getShardPoolForEntity(entity: any): Pool {
    const shardId = this.getShardForEntity(entity);
    return this.getShardPool(shardId);
  }
  
  /**
   * Gets all shard pools that might contain data for a query
   * @param queryParams Query parameters
   * @returns Array of shard pools that might contain data for the query
   */
  public getShardPoolsForQuery(queryParams: any): Pool[] {
    const shardIds = new Set<number>();
    
    // Add the default shard
    shardIds.add(this.compositeConfig.defaultShardId);
    
    // For each shard key component, check if it's in the query parameters
    for (const component of this.compositeConfig.shardKeyComponents) {
      if (queryParams[component.name] !== undefined) {
        // Create a mock entity with just this component
        const mockEntity = {
          [component.name]: queryParams[component.name]
        };
        
        // Get the shard for this mock entity
        const shardId = this.getShardForEntity(mockEntity);
        shardIds.add(shardId);
      }
    }
    
    // Convert shard IDs to pools
    return Array.from(shardIds).map(shardId => this.getShardPool(shardId));
  }
  
  /**
   * Migrates an entity to the appropriate shard
   * @param entityType The type of entity to migrate
   * @param entityId The ID of the entity to migrate
   * @param sourcePool Source database pool
   * @returns Promise that resolves when migration is complete
   */
  public async migrateEntity(
    entityType: string,
    entityId: number,
    sourcePool: Pool
  ): Promise<void> {
    logger.info(`Migrating ${entityType} ${entityId}`);
    
    // Get the entity from the source database
    const entityResult = await sourcePool.query(
      `SELECT * FROM ${entityType} WHERE id = $1`,
      [entityId]
    );
    
    if (entityResult.rows.length === 0) {
      logger.warn(`${entityType} ${entityId} not found`);
      return;
    }
    
    const entity = entityResult.rows[0];
    
    // Get the target shard for the entity
    const targetShardId = this.getShardForEntity(entity);
    const targetPool = this.getShardPool(targetShardId);
    
    logger.info(`Migrating ${entityType} ${entityId} to shard ${targetShardId}`);
    
    // Start a transaction on both pools
    const sourceClient = await sourcePool.connect();
    const targetClient = await targetPool.connect();
    
    try {
      await sourceClient.query('BEGIN');
      await targetClient.query('BEGIN');
      
      // Migrate the entity
      await this.migrateEntityData(entityType, entity, sourceClient, targetClient);
      
      // Commit transactions
      await sourceClient.query('COMMIT');
      await targetClient.query('COMMIT');
      
      logger.info(`${entityType} ${entityId} migration completed successfully`);
    } catch (error) {
      // Rollback transactions on error
      await sourceClient.query('ROLLBACK');
      await targetClient.query('ROLLBACK');
      
      logger.error(`${entityType} ${entityId} migration failed`, { error });
      throw error;
    } finally {
      // Release clients
      sourceClient.release();
      targetClient.release();
    }
  }
  
  /**
   * Migrates entity data from one pool to another
   * @param entityType The type of entity to migrate
   * @param entity The entity to migrate
   * @param sourceClient Source database client
   * @param targetClient Target database client
   * @returns Promise that resolves when migration is complete
   */
  private async migrateEntityData(
    entityType: string,
    entity: any,
    sourceClient: any,
    targetClient: any
  ): Promise<void> {
    // Get the column names for the entity
    const columnsResult = await sourceClient.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_name = $1`,
      [entityType]
    );
    
    const columns = columnsResult.rows.map(row => row.column_name);
    
    // Build the column list and value placeholders for the INSERT statement
    const columnList = columns.join(', ');
    const valuePlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    
    // Build the values array for the INSERT statement
    const values = columns.map(column => entity[column]);
    
    // Insert the entity into the target
    await targetClient.query(
      `INSERT INTO ${entityType} (${columnList}) 
       VALUES (${valuePlaceholders})
       ON CONFLICT (id) DO NOTHING`,
      values
    );
    
    // If this is a user, also migrate related data
    if (entityType === 'users') {
      // Migrate training plans
      const trainingPlansResult = await sourceClient.query(
        `SELECT * FROM training_plans WHERE user_id = $1`,
        [entity.id]
      );
      
      const trainingPlans = trainingPlansResult.rows;
      logger.info(`Found ${trainingPlans.length} training plans to migrate`);
      
      for (const plan of trainingPlans) {
        await this.migrateEntityData('training_plans', plan, sourceClient, targetClient);
      }
      
      // Migrate workout notes
      const workoutNotesResult = await sourceClient.query(
        `SELECT * FROM workout_notes WHERE user_id = $1`,
        [entity.id]
      );
      
      const workoutNotes = workoutNotesResult.rows;
      logger.info(`Found ${workoutNotes.length} workout notes to migrate`);
      
      for (const note of workoutNotes) {
        await this.migrateEntityData('workout_notes', note, sourceClient, targetClient);
      }
    }
  }
} 