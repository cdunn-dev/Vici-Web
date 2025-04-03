import { logger } from '../utils/logger';
import ReadReplicaManager from './readReplicaManager';
import { RangeShardingService, RangeShardConfig } from './rangeShardingService';
import { GeographicShardingService, GeographicShardConfig } from './geographicShardingService';

export type ShardKey = {
  timeRange?: {
    start: Date;
    end: Date;
  };
  location?: {
    latitude: number;
    longitude: number;
  };
  custom?: Record<string, any>;
};

export interface CompositeShardConfig {
  /**
   * The name of the shard
   */
  name: string;
  
  /**
   * The shard key that defines this shard
   */
  shardKey: ShardKey;
  
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

export interface CompositeShardingOptions {
  /**
   * The range sharding service to use
   */
  rangeShardingService: RangeShardingService;
  
  /**
   * The geographic sharding service to use
   */
  geographicShardingService: GeographicShardingService;
  
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

export class CompositeShardingService {
  private options: CompositeShardingOptions;
  private isInitialized = false;
  private shards: Map<string, CompositeShardConfig> = new Map();
  private shardMetadata: Map<string, any> = new Map();

  constructor(options: Partial<CompositeShardingOptions>) {
    this.options = {
      rangeShardingService: new RangeShardingService({}),
      geographicShardingService: new GeographicShardingService({}),
      shardsTable: 'composite_shards',
      shardMetadataTable: 'composite_shard_metadata',
      useTransactions: true,
      timeout: 30000,
      validateBeforeUse: true,
      createBackup: true,
      backupDir: 'backups/composite_shards',
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

      // Initialize the geographic sharding service
      await this.options.geographicShardingService.initialize();

      // Create shards table if it doesn't exist
      await this.createShardsTable();

      // Create shard metadata table if it doesn't exist
      await this.createShardMetadataTable();

      // Load shards from the database
      await this.loadShards();

      // Load shard metadata from the database
      await this.loadShardMetadata();

      this.isInitialized = true;
      logger.info('Composite sharding service initialized');
    } catch (error) {
      logger.error('Failed to initialize composite sharding service', error);
      throw error;
    }
  }

  private async createShardsTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS ${this.options.shardsTable} (
        name VARCHAR(255) PRIMARY KEY,
        shard_key JSONB NOT NULL,
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
    `;

    const result = await ReadReplicaManager.getInstance().query(query);
    
    this.shards.clear();
    
    for (const row of result.rows) {
      this.shards.set(row.name, {
        name: row.name,
        shardKey: row.shard_key,
        connection: row.connection,
        isActive: row.is_active,
        lastChecked: row.last_checked ? new Date(row.last_checked) : undefined,
        responseTime: row.response_time,
        errorCount: row.error_count,
        queryCount: row.query_count
      });
    }
    
    logger.info(`Loaded ${this.shards.size} composite shards from database`);
  }

  private async loadShardMetadata(): Promise<void> {
    const query = `
      SELECT * FROM ${this.options.shardMetadataTable}
    `;

    const result = await ReadReplicaManager.getInstance().query(query);
    
    this.shardMetadata.clear();
    
    for (const row of result.rows) {
      this.shardMetadata.set(row.shard_name, row.metadata);
    }
    
    logger.info(`Loaded ${this.shardMetadata.size} composite shard metadata entries from database`);
  }

  public async createShard(config: Omit<CompositeShardConfig, 'name'>): Promise<CompositeShardConfig> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Generate a name for the shard
    const name = this.generateShardName(config.shardKey);
    
    // Create the shard configuration
    const shard: CompositeShardConfig = {
      name,
      ...config
    };
    
    // Insert the shard into the database
    await this.insertShard(shard);
    
    // Add the shard to the map
    this.shards.set(name, shard);
    
    logger.info(`Created composite shard ${name}`);
    
    return shard;
  }

  private generateShardName(shardKey: ShardKey): string {
    const parts: string[] = [];

    if (shardKey.timeRange) {
      parts.push(`time_${shardKey.timeRange.start.toISOString().split('T')[0]}_${shardKey.timeRange.end.toISOString().split('T')[0]}`);
    }

    if (shardKey.location) {
      parts.push(`loc_${shardKey.location.latitude}_${shardKey.location.longitude}`);
    }

    if (shardKey.custom) {
      parts.push(`custom_${Object.entries(shardKey.custom)
        .map(([key, value]) => `${key}_${value}`)
        .join('_')}`);
    }

    return `composite_${parts.join('_')}`;
  }

  private async insertShard(shard: CompositeShardConfig): Promise<void> {
    const query = `
      INSERT INTO ${this.options.shardsTable} (
        name, shard_key, connection, is_active
      ) VALUES ($1, $2, $3, $4)
    `;
    
    await ReadReplicaManager.getInstance().query(query, [
      shard.name,
      shard.shardKey,
      shard.connection,
      shard.isActive
    ]);
    
    logger.info(`Inserted composite shard ${shard.name} into database`);
  }

  public async getShardForKey(shardKey: ShardKey): Promise<CompositeShardConfig> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Find the shard that matches the key
    const shard = Array.from(this.shards.values()).find(
      s => s.isActive && this.matchesShardKey(s.shardKey, shardKey)
    );

    if (!shard) {
      throw new Error(`No shard found for key ${JSON.stringify(shardKey)}`);
    }

    return shard;
  }

  private matchesShardKey(shardKey1: ShardKey, shardKey2: ShardKey): boolean {
    // Check time range match
    if (shardKey1.timeRange && shardKey2.timeRange) {
      if (shardKey1.timeRange.start > shardKey2.timeRange.end || 
          shardKey1.timeRange.end < shardKey2.timeRange.start) {
        return false;
      }
    }

    // Check location match
    if (shardKey1.location && shardKey2.location) {
      const distance = this.calculateDistance(
        shardKey1.location.latitude,
        shardKey1.location.longitude,
        shardKey2.location.latitude,
        shardKey2.location.longitude
      );

      if (distance > 100) { // 100km threshold
        return false;
      }
    }

    // Check custom key match
    if (shardKey1.custom && shardKey2.custom) {
      for (const [key, value] of Object.entries(shardKey1.custom)) {
        if (shardKey2.custom[key] !== value) {
          return false;
        }
      }
    }

    return true;
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    // Haversine formula to calculate the distance between two points on Earth
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
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

  private async updateShard(shard: CompositeShardConfig): Promise<void> {
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

    logger.info(`Updated composite shard ${shard.name} in database`);
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

    logger.info(`Inserted metadata for composite shard ${shardName} into database`);
  }

  public async getShards(): Promise<CompositeShardConfig[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return Array.from(this.shards.values());
  }

  public async getActiveShards(): Promise<CompositeShardConfig[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return Array.from(this.shards.values()).filter(s => s.isActive);
  }

  public async end(): Promise<void> {
    this.isInitialized = false;
    this.shards.clear();
    this.shardMetadata.clear();
    logger.info('Composite sharding service ended');
  }
} 