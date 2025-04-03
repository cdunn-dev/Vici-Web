import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { ShardingService, ShardingConfig } from './sharding';

/**
 * Configuration for geographic sharding
 */
export interface GeographicShardingConfig extends ShardingConfig {
  /**
   * Mapping of regions to shard IDs
   */
  regionShardMap: Record<string, number>;
  
  /**
   * Default shard ID for regions not in the map
   */
  defaultShardId: number;
  
  /**
   * Whether to use country, region, or city for sharding
   */
  shardingLevel: 'country' | 'region' | 'city';
}

/**
 * Service for managing geographic-based database sharding
 * Extends the base ShardingService with geographic shard key selection
 */
export class GeographicShardingService extends ShardingService {
  private geoConfig: GeographicShardingConfig;
  
  /**
   * Creates a new GeographicShardingService
   * @param config Sharding configuration
   */
  constructor(config: GeographicShardingConfig) {
    super(config);
    this.geoConfig = config;
  }
  
  /**
   * Gets the shard ID for a given location
   * @param country Country code
   * @param region Region name
   * @param city City name
   * @returns The shard ID
   */
  public getShardForLocation(
    country?: string,
    region?: string,
    city?: string
  ): number {
    const shardingLevel = this.geoConfig.shardingLevel;
    
    // Determine the location key based on the sharding level
    let locationKey: string | undefined;
    
    switch (shardingLevel) {
      case 'country':
        locationKey = country;
        break;
      case 'region':
        locationKey = region;
        break;
      case 'city':
        locationKey = city;
        break;
    }
    
    // If no location key is available, use the default shard
    if (!locationKey) {
      logger.warn('No location key available, using default shard', {
        country,
        region,
        city,
        shardingLevel
      });
      return this.geoConfig.defaultShardId;
    }
    
    // Check if the location is in the region shard map
    if (this.geoConfig.regionShardMap[locationKey] !== undefined) {
      return this.geoConfig.regionShardMap[locationKey];
    }
    
    // If the location is not in the map, use the default shard
    logger.warn('Location not in shard map, using default shard', {
      locationKey,
      shardingLevel
    });
    return this.geoConfig.defaultShardId;
  }
  
  /**
   * Gets the shard pool for a given location
   * @param country Country code
   * @param region Region name
   * @param city City name
   * @returns The shard pool
   */
  public getShardPoolForLocation(
    country?: string,
    region?: string,
    city?: string
  ): Pool {
    const shardId = this.getShardForLocation(country, region, city);
    return this.getShardPool(shardId);
  }
  
  /**
   * Gets all shard pools for a given region
   * @param region Region name
   * @returns Array of shard pools for the region
   */
  public getShardPoolsForRegion(region: string): Pool[] {
    const shardIds = new Set<number>();
    
    // Add the shard for the region
    const regionShardId = this.geoConfig.regionShardMap[region];
    if (regionShardId !== undefined) {
      shardIds.add(regionShardId);
    }
    
    // Add the default shard
    shardIds.add(this.geoConfig.defaultShardId);
    
    // Convert shard IDs to pools
    return Array.from(shardIds).map(shardId => this.getShardPool(shardId));
  }
  
  /**
   * Creates shards for a given region
   * @param region Region name
   * @returns Promise that resolves when all shards are created
   */
  public async createShardsForRegion(region: string): Promise<void> {
    const shardIds = new Set<number>();
    
    // Add the shard for the region
    const regionShardId = this.geoConfig.regionShardMap[region];
    if (regionShardId !== undefined) {
      shardIds.add(regionShardId);
    }
    
    // Add the default shard
    shardIds.add(this.geoConfig.defaultShardId);
    
    // Create all shards
    for (const shardId of shardIds) {
      await this.createShard(shardId);
    }
  }
  
  /**
   * Migrates data for a user to the appropriate shard based on their location
   * @param userId User ID
   * @param sourcePool Source database pool
   * @returns Promise that resolves when migration is complete
   */
  public async migrateUserByLocation(
    userId: number,
    sourcePool: Pool
  ): Promise<void> {
    logger.info(`Migrating user ${userId} by location`);
    
    // Get user location from the source database
    const userResult = await sourcePool.query(
      `SELECT country, region, city FROM users WHERE id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      logger.warn(`User ${userId} not found`);
      return;
    }
    
    const user = userResult.rows[0];
    const { country, region, city } = user;
    
    // Get the target shard for the user's location
    const targetShardId = this.getShardForLocation(country, region, city);
    const targetPool = this.getShardPool(targetShardId);
    
    logger.info(`Migrating user ${userId} to shard ${targetShardId}`, {
      country,
      region,
      city
    });
    
    // Start a transaction on both pools
    const sourceClient = await sourcePool.connect();
    const targetClient = await targetPool.connect();
    
    try {
      await sourceClient.query('BEGIN');
      await targetClient.query('BEGIN');
      
      // Migrate user data
      await this.migrateUserData(userId, sourceClient, targetClient);
      
      // Commit transactions
      await sourceClient.query('COMMIT');
      await targetClient.query('COMMIT');
      
      logger.info(`User ${userId} migration completed successfully`);
    } catch (error) {
      // Rollback transactions on error
      await sourceClient.query('ROLLBACK');
      await targetClient.query('ROLLBACK');
      
      logger.error(`User ${userId} migration failed`, { error });
      throw error;
    } finally {
      // Release clients
      sourceClient.release();
      targetClient.release();
    }
  }
  
  /**
   * Migrates user data from one pool to another
   * @param userId User ID
   * @param sourceClient Source database client
   * @param targetClient Target database client
   * @returns Promise that resolves when migration is complete
   */
  private async migrateUserData(
    userId: number,
    sourceClient: any,
    targetClient: any
  ): Promise<void> {
    // Get user data from the source
    const userResult = await sourceClient.query(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      logger.warn(`User ${userId} not found`);
      return;
    }
    
    const user = userResult.rows[0];
    
    // Insert user into the target
    await targetClient.query(
      `INSERT INTO users (
        id, email, password, email_verified, reset_token, reset_token_expires,
        country, region, city, latitude, longitude, timezone,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO NOTHING`,
      [
        user.id,
        user.email,
        user.password,
        user.email_verified,
        user.reset_token,
        user.reset_token_expires,
        user.country,
        user.region,
        user.city,
        user.latitude,
        user.longitude,
        user.timezone,
        user.created_at,
        user.updated_at
      ]
    );
    
    // Get training plans for the user
    const trainingPlansResult = await sourceClient.query(
      `SELECT * FROM training_plans WHERE user_id = $1`,
      [userId]
    );
    
    const trainingPlans = trainingPlansResult.rows;
    logger.info(`Found ${trainingPlans.length} training plans to migrate`);
    
    // Insert training plans into the target
    for (const plan of trainingPlans) {
      await targetClient.query(
        `INSERT INTO training_plans (
          id, user_id, name, description, start_date, end_date,
          status, type, difficulty, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO NOTHING`,
        [
          plan.id,
          plan.user_id,
          plan.name,
          plan.description,
          plan.start_date,
          plan.end_date,
          plan.status,
          plan.type,
          plan.difficulty,
          plan.created_at,
          plan.updated_at
        ]
      );
    }
    
    // Get workout notes for the user
    const workoutNotesResult = await sourceClient.query(
      `SELECT * FROM workout_notes WHERE user_id = $1`,
      [userId]
    );
    
    const workoutNotes = workoutNotesResult.rows;
    logger.info(`Found ${workoutNotes.length} workout notes to migrate`);
    
    // Insert workout notes into the target
    for (const note of workoutNotes) {
      await targetClient.query(
        `INSERT INTO workout_notes (
          id, user_id, workout_id, content, type, rating, tags, metrics,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING`,
        [
          note.id,
          note.user_id,
          note.workout_id,
          note.content,
          note.type,
          note.rating,
          note.tags,
          note.metrics,
          note.created_at,
          note.updated_at
        ]
      );
    }
  }
} 