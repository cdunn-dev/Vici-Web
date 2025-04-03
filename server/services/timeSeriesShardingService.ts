import { logger } from '../utils/logger';
import { RangeShardingService, RangeShardConfig } from './rangeShardingService';
import { TimeSeriesOptimizationService } from './timeSeriesOptimizationService';

export interface TimeSeriesShardingOptions {
  /**
   * The range sharding service to use
   */
  rangeShardingService: RangeShardingService;
  
  /**
   * The time series optimization service to use
   */
  timeSeriesService: TimeSeriesOptimizationService;
  
  /**
   * Whether to automatically create new shards
   */
  autoCreateShards: boolean;
  
  /**
   * Whether to automatically optimize time series data
   */
  autoOptimizeTimeSeries: boolean;
  
  /**
   * The interval for optimizing time series data
   */
  optimizationInterval: 'hour' | 'day' | 'week' | 'month';
  
  /**
   * The compression level to use for time series data
   */
  compressionLevel: number;
  
  /**
   * The retention period for time series data in days
   */
  retentionPeriod: number;
  
  /**
   * Whether to use transactions for shard operations
   */
  useTransactions: boolean;
  
  /**
   * The timeout for shard operations in milliseconds
   */
  timeout: number;
  
  /**
   * Whether to validate shard data before using it
   */
  validateBeforeUse: boolean;
  
  /**
   * Whether to create a backup before shard operations
   */
  createBackup: boolean;
  
  /**
   * The directory for backup files
   */
  backupDir: string;
  
  /**
   * Whether to log shard details
   */
  logShards: boolean;
}

export class TimeSeriesShardingService {
  private options: TimeSeriesShardingOptions;
  private isInitialized = false;

  constructor(options: Partial<TimeSeriesShardingOptions>) {
    this.options = {
      rangeShardingService: new RangeShardingService({}),
      timeSeriesService: new TimeSeriesOptimizationService(),
      autoCreateShards: true,
      autoOptimizeTimeSeries: true,
      optimizationInterval: 'day',
      compressionLevel: 6,
      retentionPeriod: 365,
      useTransactions: true,
      timeout: 30000,
      validateBeforeUse: true,
      createBackup: true,
      backupDir: 'backups/time_series_shards',
      logShards: true,
      ...options
    };
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Initialize the range sharding service
      await this.options.rangeShardingService.initialize();

      // Initialize the time series optimization service
      await this.options.timeSeriesService.initialize();

      this.isInitialized = true;
      logger.info('Time series sharding service initialized');
    } catch (error) {
      logger.error('Failed to initialize time series sharding service', error);
      throw error;
    }
  }

  public async getShardForTimestamp(timestamp: Date): Promise<RangeShardConfig> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return await this.options.rangeShardingService.getShardForTimestamp(timestamp);
  }

  public async queryTimeSeriesData(
    startTime: Date,
    endTime: Date,
    query: string,
    params?: any[]
  ): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Get all shards that overlap with the time range
    const shards = await this.getShardsInRange(startTime, endTime);

    // Execute the query on each shard and combine the results
    const results = await Promise.all(
      shards.map(shard => this.options.rangeShardingService.queryShard(shard.name, query, params))
    );

    // Combine the results
    return this.combineResults(results);
  }

  private async getShardsInRange(startTime: Date, endTime: Date): Promise<RangeShardConfig[]> {
    const allShards = await this.options.rangeShardingService.getShards();

    return allShards.filter(
      shard =>
        shard.isActive &&
        ((shard.rangeStart <= startTime && shard.rangeEnd > startTime) ||
          (shard.rangeStart < endTime && shard.rangeEnd >= endTime) ||
          (shard.rangeStart >= startTime && shard.rangeEnd <= endTime))
    );
  }

  private combineResults(results: any[]): any {
    // This is a simplified implementation
    // In a real-world scenario, you would need to implement a more sophisticated result combination strategy
    return results.reduce((combined, result) => {
      if (Array.isArray(result)) {
        return [...combined, ...result];
      }
      return { ...combined, ...result };
    }, Array.isArray(results[0]) ? [] : {});
  }

  public async optimizeTimeSeriesData(shardName: string): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Get the shard
    const shard = (await this.options.rangeShardingService.getShards()).find(s => s.name === shardName);

    if (!shard) {
      throw new Error(`Shard ${shardName} not found`);
    }

    // Optimize the time series data in the shard
    await this.options.timeSeriesService.optimizeData(
      shard.rangeStart,
      shard.rangeEnd,
      this.options.compressionLevel
    );

    logger.info(`Optimized time series data in shard ${shardName}`);
  }

  public async cleanupOldData(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Calculate the cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.options.retentionPeriod);

    // Get all shards
    const shards = await this.options.rangeShardingService.getShards();

    // Clean up old data in each shard
    for (const shard of shards) {
      if (shard.rangeEnd < cutoffDate) {
        await this.options.timeSeriesService.cleanupData(shard.rangeStart, shard.rangeEnd);
        logger.info(`Cleaned up old data in shard ${shard.name}`);
      }
    }
  }

  public async end(): Promise<void> {
    this.isInitialized = false;
    await this.options.rangeShardingService.end();
    logger.info('Time series sharding service ended');
  }
} 