import { Pool } from 'pg';
import { logger } from './logger';
import { TimeSeriesShardingService } from '../services/timeSeriesSharding';

/**
 * Utility for migrating time-series data between shards
 */
export class TimeSeriesMigration {
  private shardingService: TimeSeriesShardingService;
  
  /**
   * Creates a new TimeSeriesMigration utility
   * @param shardingService The time-series sharding service
   */
  constructor(shardingService: TimeSeriesShardingService) {
    this.shardingService = shardingService;
  }
  
  /**
   * Migrates data for a specific time range from one shard to another
   * @param startTime Start of the time range
   * @param endTime End of the time range
   * @param sourcePool Source database pool
   * @param targetPool Target database pool
   * @returns Promise that resolves when migration is complete
   */
  public async migrateTimeRange(
    startTime: Date,
    endTime: Date,
    sourcePool: Pool,
    targetPool: Pool
  ): Promise<void> {
    logger.info(`Migrating data from ${startTime.toISOString()} to ${endTime.toISOString()}`);
    
    // Start a transaction on both pools
    const sourceClient = await sourcePool.connect();
    const targetClient = await targetPool.connect();
    
    try {
      await sourceClient.query('BEGIN');
      await targetClient.query('BEGIN');
      
      // Migrate workout notes
      await this.migrateWorkoutNotes(startTime, endTime, sourceClient, targetClient);
      
      // Migrate performance metrics
      await this.migratePerformanceMetrics(startTime, endTime, sourceClient, targetClient);
      
      // Commit transactions
      await sourceClient.query('COMMIT');
      await targetClient.query('COMMIT');
      
      logger.info('Migration completed successfully');
    } catch (error) {
      // Rollback transactions on error
      await sourceClient.query('ROLLBACK');
      await targetClient.query('ROLLBACK');
      
      logger.error('Migration failed', { error });
      throw error;
    } finally {
      // Release clients
      sourceClient.release();
      targetClient.release();
    }
  }
  
  /**
   * Migrates workout notes for a specific time range
   * @param startTime Start of the time range
   * @param endTime End of the time range
   * @param sourceClient Source database client
   * @param targetClient Target database client
   * @returns Promise that resolves when migration is complete
   */
  private async migrateWorkoutNotes(
    startTime: Date,
    endTime: Date,
    sourceClient: any,
    targetClient: any
  ): Promise<void> {
    logger.info('Migrating workout notes');
    
    // Query workout notes from the source
    const result = await sourceClient.query(
      `SELECT * FROM workout_notes 
       WHERE created_at >= $1 AND created_at < $2`,
      [startTime, endTime]
    );
    
    const workoutNotes = result.rows;
    logger.info(`Found ${workoutNotes.length} workout notes to migrate`);
    
    // Insert workout notes into the target
    for (const note of workoutNotes) {
      await targetClient.query(
        `INSERT INTO workout_notes (
          id, user_id, workout_id, content, type, rating, tags, metrics, created_at, updated_at
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
    
    logger.info('Workout notes migration completed');
  }
  
  /**
   * Migrates performance metrics for a specific time range
   * @param startTime Start of the time range
   * @param endTime End of the time range
   * @param sourceClient Source database client
   * @param targetClient Target database client
   * @returns Promise that resolves when migration is complete
   */
  private async migratePerformanceMetrics(
    startTime: Date,
    endTime: Date,
    sourceClient: any,
    targetClient: any
  ): Promise<void> {
    logger.info('Migrating performance metrics');
    
    // Query performance metrics from the source
    const result = await sourceClient.query(
      `SELECT * FROM performance_metrics 
       WHERE recorded_at >= $1 AND recorded_at < $2`,
      [startTime, endTime]
    );
    
    const metrics = result.rows;
    logger.info(`Found ${metrics.length} performance metrics to migrate`);
    
    // Insert performance metrics into the target
    for (const metric of metrics) {
      await targetClient.query(
        `INSERT INTO performance_metrics (
          id, user_id, metric_type, value, recorded_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO NOTHING`,
        [
          metric.id,
          metric.user_id,
          metric.metric_type,
          metric.value,
          metric.recorded_at,
          metric.created_at,
          metric.updated_at
        ]
      );
    }
    
    logger.info('Performance metrics migration completed');
  }
  
  /**
   * Verifies that the migration was successful
   * @param startTime Start of the time range
   * @param endTime End of the time range
   * @param sourcePool Source database pool
   * @param targetPool Target database pool
   * @returns Promise that resolves with the verification result
   */
  public async verifyMigration(
    startTime: Date,
    endTime: Date,
    sourcePool: Pool,
    targetPool: Pool
  ): Promise<boolean> {
    logger.info('Verifying migration');
    
    // Query counts from both sources
    const sourceWorkoutNotesResult = await sourcePool.query(
      `SELECT COUNT(*) FROM workout_notes 
       WHERE created_at >= $1 AND created_at < $2`,
      [startTime, endTime]
    );
    
    const targetWorkoutNotesResult = await targetPool.query(
      `SELECT COUNT(*) FROM workout_notes 
       WHERE created_at >= $1 AND created_at < $2`,
      [startTime, endTime]
    );
    
    const sourceMetricsResult = await sourcePool.query(
      `SELECT COUNT(*) FROM performance_metrics 
       WHERE recorded_at >= $1 AND recorded_at < $2`,
      [startTime, endTime]
    );
    
    const targetMetricsResult = await targetPool.query(
      `SELECT COUNT(*) FROM performance_metrics 
       WHERE recorded_at >= $1 AND recorded_at < $2`,
      [startTime, endTime]
    );
    
    const sourceWorkoutNotesCount = parseInt(sourceWorkoutNotesResult.rows[0].count);
    const targetWorkoutNotesCount = parseInt(targetWorkoutNotesResult.rows[0].count);
    const sourceMetricsCount = parseInt(sourceMetricsResult.rows[0].count);
    const targetMetricsCount = parseInt(targetMetricsResult.rows[0].count);
    
    logger.info('Migration verification results', {
      sourceWorkoutNotesCount,
      targetWorkoutNotesCount,
      sourceMetricsCount,
      targetMetricsCount
    });
    
    // Check if counts match
    const workoutNotesMatch = sourceWorkoutNotesCount === targetWorkoutNotesCount;
    const metricsMatch = sourceMetricsCount === targetMetricsCount;
    
    if (!workoutNotesMatch || !metricsMatch) {
      logger.warn('Migration verification failed', {
        workoutNotesMatch,
        metricsMatch
      });
      return false;
    }
    
    logger.info('Migration verification successful');
    return true;
  }
} 