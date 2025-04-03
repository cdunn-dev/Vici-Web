import { logger } from '../utils/logger';
import ReadReplicaManager from './readReplicaManager';
import { TimeSeriesOptimizationService } from './timeSeriesOptimizationService';

export interface RangeShardConfig {
  /**
   * The name of the shard
   */
  name: string;
  
  /**
   * The start of the range (inclusive)
   */
  rangeStart: Date;
  
  /**
   * The end of the range (exclusive)
   */
  rangeEnd: Date;
  
  /**
   * The database connection details for this shard
   */
  connection: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  
  /**
   * Whether this shard is active
   */
  isActive: boolean;
  
  /**
   * The last time this shard was checked
   */
  lastChecked?: Date;
  
  /**
   * The response time of this shard in milliseconds
   */
  responseTime?: number;
  
  /**
   * The number of errors encountered with this shard
   */
  errorCount?: number;
  
  /**
   * The number of queries executed on this shard
   */
  queryCount?: number;
}

export interface RangeShardingOptions {
  /**
   * The interval for creating new shards
   */
  shardInterval: 'day' | 'week' | 'month' | 'quarter' | 'year';
  
  /**
   * The number of shards to keep in memory
   */
  maxShardsInMemory: number;
  
  /**
   * The time to live for shard metadata in milliseconds
   */
  shardMetadataTTL: number;
  
  /**
   * Whether to automatically create new shards
   */
  autoCreateShards: boolean;
  
  /**
   * The time series optimization service to use
   */
  timeSeriesService: TimeSeriesOptimizationService;
  
  /**
   * The table name for tracking shards
   */
  shardsTable: string;
  
  /**
   * The table name for tracking shard metadata
   */
  shardMetadataTable: string;
  
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

export class RangeShardingService {
  private options: RangeShardingOptions;
  private isInitialized = false;
  private shards: Map<string, RangeShardConfig> = new Map();
  private shardMetadata: Map<string, any> = new Map();

  constructor(options: Partial<RangeShardingOptions>) {
    this.options = {
      shardInterval: 'month',
      maxShardsInMemory: 10,
      shardMetadataTTL: 3600000, // 1 hour
      autoCreateShards: true,
      timeSeriesService: new TimeSeriesOptimizationService(),
      shardsTable: 'range_shards',
      shardMetadataTable: 'range_shard_metadata',
      useTransactions: true,
      timeout: 30000,
      validateBeforeUse: true,
      createBackup: true,
      backupDir: 'backups/range_shards',
      logShards: true,
      ...options
    };
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Create shards table if it doesn't exist
      await this.createShardsTable();

      // Create shard metadata table if it doesn't exist
      await this.createShardMetadataTable();

      // Load shards from the database
      await this.loadShards();

      // Load shard metadata from the database
      await this.loadShardMetadata();

      // Create initial shards if needed
      if (this.options.autoCreateShards) {
        await this.createInitialShards();
      }

      this.isInitialized = true;
      logger.info('Range sharding service initialized');
    } catch (error) {
      logger.error('Failed to initialize range sharding service', error);
      throw error;
    }
  }

  private async createShardsTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS ${this.options.shardsTable} (
        name VARCHAR(255) PRIMARY KEY,
        range_start TIMESTAMP NOT NULL,
        range_end TIMESTAMP NOT NULL,
        connection JSONB NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        last_checked TIMESTAMP,
        response_time INTEGER,
        error_count INTEGER DEFAULT 0,
        query_count INTEGER DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await ReadReplicaManager.getInstance().query(query);
    logger.info(`Created shards table ${this.options.shardsTable}`);
  }

  private async createShardMetadataTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS ${this.options.shardMetadataTable} (
        shard_name VARCHAR(255) PRIMARY KEY,
        metadata JSONB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (shard_name) REFERENCES ${this.options.shardsTable} (name) ON DELETE CASCADE
      )
    `;

    await ReadReplicaManager.getInstance().query(query);
    logger.info(`Created shard metadata table ${this.options.shardMetadataTable}`);
  }

  private async loadShards(): Promise<void> {
    const query = `
      SELECT * FROM ${this.options.shardsTable}
      ORDER BY range_start ASC
    `;

    const result = await ReadReplicaManager.getInstance().query(query);
    
    this.shards.clear();
    
    for (const row of result.rows) {
      this.shards.set(row.name, {
        name: row.name,
        rangeStart: new Date(row.range_start),
        rangeEnd: new Date(row.range_end),
        connection: row.connection,
        isActive: row.is_active,
        lastChecked: row.last_checked ? new Date(row.last_checked) : undefined,
        responseTime: row.response_time,
        errorCount: row.error_count,
        queryCount: row.query_count
      });
    }
    
    logger.info(`Loaded ${this.shards.size} shards from database`);
  }

  private async loadShardMetadata(): Promise<void> {
    const query = `
      SELECT * FROM ${this.options.shardMetadataTable}
      WHERE updated_at > NOW() - INTERVAL '1 hour'
    `;

    const result = await ReadReplicaManager.getInstance().query(query);
    
    this.shardMetadata.clear();
    
    for (const row of result.rows) {
      this.shardMetadata.set(row.shard_name, row.metadata);
    }
    
    logger.info(`Loaded ${this.shardMetadata.size} shard metadata entries from database`);
  }

  private async createInitialShards(): Promise<void> {
    // Get the current time
    const now = new Date();
    
    // Calculate the start of the current interval
    const intervalStart = this.getIntervalStart(now);
    
    // Calculate the end of the current interval
    const intervalEnd = this.getIntervalEnd(intervalStart);
    
    // Create shards for the current and next interval
    await this.createShard(intervalStart, intervalEnd);
    await this.createShard(intervalEnd, this.getIntervalEnd(intervalEnd));
    
    logger.info('Created initial shards');
  }

  private getIntervalStart(date: Date): Date {
    const start = new Date(date);
    
    switch (this.options.shardInterval) {
      case 'day':
        start.setHours(0, 0, 0, 0);
        break;
      case 'week':
        start.setDate(start.getDate() - start.getDay());
        start.setHours(0, 0, 0, 0);
        break;
      case 'month':
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        break;
      case 'quarter':
        start.setMonth(Math.floor(start.getMonth() / 3) * 3);
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        break;
      case 'year':
        start.setMonth(0);
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        break;
    }
    
    return start;
  }

  private getIntervalEnd(start: Date): Date {
    const end = new Date(start);
    
    switch (this.options.shardInterval) {
      case 'day':
        end.setDate(end.getDate() + 1);
        break;
      case 'week':
        end.setDate(end.getDate() + 7);
        break;
      case 'month':
        end.setMonth(end.getMonth() + 1);
        break;
      case 'quarter':
        end.setMonth(end.getMonth() + 3);
        break;
      case 'year':
        end.setFullYear(end.getFullYear() + 1);
        break;
    }
    
    return end;
  }

  private async createShard(rangeStart: Date, rangeEnd: Date): Promise<RangeShardConfig> {
    // Generate a name for the shard
    const name = `shard_${rangeStart.toISOString().replace(/[-:T]/g, '').replace(/\..+/, '')}`;
    
    // Get the connection details for the shard
    const connection = await this.getShardConnection(name);
    
    // Create the shard configuration
    const shard: RangeShardConfig = {
      name,
      rangeStart,
      rangeEnd,
      connection,
      isActive: true
    };
    
    // Insert the shard into the database
    await this.insertShard(shard);
    
    // Add the shard to the map
    this.shards.set(name, shard);
    
    logger.info(`Created shard ${name}`);
    
    return shard;
  }

  private async getShardConnection(shardName: string): Promise<RangeShardConfig['connection']> {
    // This is a simplified implementation
    // In a real-world scenario, you would need to implement a more sophisticated connection management system
    return {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'vici',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres'
    };
  }

  private async insertShard(shard: RangeShardConfig): Promise<void> {
    const query = `
      INSERT INTO ${this.options.shardsTable} (
        name, range_start, range_end, connection, is_active
      ) VALUES ($1, $2, $3, $4, $5)
    `;
    
    await ReadReplicaManager.getInstance().query(query, [
      shard.name,
      shard.rangeStart,
      shard.rangeEnd,
      shard.connection,
      shard.isActive
    ]);
    
    logger.info(`Inserted shard ${shard.name} into database`);
  }

  private async updateShard(shard: RangeShardConfig): Promise<void> {
    const query = `
      UPDATE ${this.options.shardsTable}
      SET is_active = $1, last_checked = $2, response_time = $3, error_count = $4, query_count = $5, updated_at = CURRENT_TIMESTAMP
      WHERE name = $6
    `;
    
    await ReadReplicaManager.getInstance().query(query, [
      shard.isActive,
      shard.lastChecked,
      shard.responseTime,
      shard.errorCount,
      shard.queryCount,
      shard.name
    ]);
    
    logger.info(`Updated shard ${shard.name} in database`);
  }

  private async insertShardMetadata(shardName: string, metadata: any): Promise<void> {
    const query = `
      INSERT INTO ${this.options.shardMetadataTable} (
        shard_name, metadata
      ) VALUES ($1, $2)
      ON CONFLICT (shard_name) DO UPDATE
      SET metadata = $2, updated_at = CURRENT_TIMESTAMP
    `;
    
    await ReadReplicaManager.getInstance().query(query, [
      shardName,
      metadata
    ]);
    
    logger.info(`Inserted metadata for shard ${shardName} into database`);
  }

  public async getShardForTimestamp(timestamp: Date): Promise<RangeShardConfig> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Find the shard that contains the timestamp
    const shard = Array.from(this.shards.values()).find(
      s => s.isActive && s.rangeStart <= timestamp && s.rangeEnd > timestamp
    );
    
    if (shard) {
      return shard;
    }
    
    // If no shard is found, create a new one
    if (this.options.autoCreateShards) {
      const intervalStart = this.getIntervalStart(timestamp);
      const intervalEnd = this.getIntervalEnd(intervalStart);
      
      return await this.createShard(intervalStart, intervalEnd);
    }
    
    throw new Error(`No shard found for timestamp ${timestamp.toISOString()}`);
  }

  public async queryShard(shardName: string, query: string, params?: any[]): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Get the shard
    const shard = this.shards.get(shardName);
    
    if (!shard) {
      throw new Error(`Shard ${shardName} not found`);
    }
    
    if (!shard.isActive) {
      throw new Error(`Shard ${shardName} is not active`);
    }
    
    // Update the shard's last checked time
    shard.lastChecked = new Date();
    
    // Execute the query
    const startTime = Date.now();
    
    try {
      const result = await ReadReplicaManager.getInstance().query(query, params);
      
      // Update the shard's response time and query count
      shard.responseTime = Date.now() - startTime;
      shard.queryCount = (shard.queryCount || 0) + 1;
      
      // Update the shard in the database
      await this.updateShard(shard);
      
      return result;
    } catch (error) {
      // Update the shard's error count
      shard.errorCount = (shard.errorCount || 0) + 1;
      
      // Update the shard in the database
      await this.updateShard(shard);
      
      throw error;
    }
  }

  public async getShardMetadata(shardName: string): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Check if the metadata is in memory
    const metadata = this.shardMetadata.get(shardName);
    
    if (metadata) {
      return metadata;
    }
    
    // Load the metadata from the database
    const query = `
      SELECT metadata FROM ${this.options.shardMetadataTable}
      WHERE shard_name = $1
    `;
    
    const result = await ReadReplicaManager.getInstance().query(query, [shardName]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    // Add the metadata to memory
    this.shardMetadata.set(shardName, result.rows[0].metadata);
    
    return result.rows[0].metadata;
  }

  public async setShardMetadata(shardName: string, metadata: any): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Insert the metadata into the database
    await this.insertShardMetadata(shardName, metadata);
    
    // Add the metadata to memory
    this.shardMetadata.set(shardName, metadata);
  }

  public async getShards(): Promise<RangeShardConfig[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    return Array.from(this.shards.values());
  }

  public async getActiveShards(): Promise<RangeShardConfig[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    return Array.from(this.shards.values()).filter(s => s.isActive);
  }

  public async end(): Promise<void> {
    this.isInitialized = false;
    this.shards.clear();
    this.shardMetadata.clear();
    logger.info('Range sharding service ended');
  }
} 