import { logger } from '../utils/logger';
import ReadReplicaManager from './readReplicaManager';

export interface GeographicShardConfig {
  /**
   * The name of the shard
   */
  name: string;
  
  /**
   * The region this shard represents
   */
  region: string;
  
  /**
   * The country this shard represents
   */
  country: string;
  
  /**
   * The latitude of the region's center
   */
  latitude: number;
  
  /**
   * The longitude of the region's center
   */
  longitude: number;
  
  /**
   * The radius of the region in kilometers
   */
  radius: number;
  
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

export interface GeographicShardingOptions {
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

export class GeographicShardingService {
  private options: GeographicShardingOptions;
  private isInitialized = false;
  private shards: Map<string, GeographicShardConfig> = new Map();
  private shardMetadata: Map<string, any> = new Map();

  constructor(options: Partial<GeographicShardingOptions>) {
    this.options = {
      shardsTable: 'geographic_shards',
      shardMetadataTable: 'geographic_shard_metadata',
      useTransactions: true,
      timeout: 30000,
      validateBeforeUse: true,
      createBackup: true,
      backupDir: 'backups/geographic_shards',
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

      this.isInitialized = true;
      logger.info('Geographic sharding service initialized');
    } catch (error) {
      logger.error('Failed to initialize geographic sharding service', error);
      throw error;
    }
  }

  private async createShardsTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS ${this.options.shardsTable} (
        name VARCHAR(255) PRIMARY KEY,
        region VARCHAR(255) NOT NULL,
        country VARCHAR(255) NOT NULL,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        radius DOUBLE PRECISION NOT NULL,
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
      ORDER BY region ASC
    `;

    const result = await ReadReplicaManager.getInstance().query(query);
    
    this.shards.clear();
    
    for (const row of result.rows) {
      this.shards.set(row.name, {
        name: row.name,
        region: row.region,
        country: row.country,
        latitude: row.latitude,
        longitude: row.longitude,
        radius: row.radius,
        connection: row.connection,
        isActive: row.is_active,
        lastChecked: row.last_checked ? new Date(row.last_checked) : undefined,
        responseTime: row.response_time,
        errorCount: row.error_count,
        queryCount: row.query_count
      });
    }
    
    logger.info(`Loaded ${this.shards.size} geographic shards from database`);
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
    
    logger.info(`Loaded ${this.shardMetadata.size} geographic shard metadata entries from database`);
  }

  public async createShard(config: Omit<GeographicShardConfig, 'name'>): Promise<GeographicShardConfig> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Generate a name for the shard
    const name = `geo_${config.region.toLowerCase()}_${config.country.toLowerCase()}`;
    
    // Create the shard configuration
    const shard: GeographicShardConfig = {
      name,
      ...config
    };
    
    // Insert the shard into the database
    await this.insertShard(shard);
    
    // Add the shard to the map
    this.shards.set(name, shard);
    
    logger.info(`Created geographic shard ${name}`);
    
    return shard;
  }

  private async insertShard(shard: GeographicShardConfig): Promise<void> {
    const query = `
      INSERT INTO ${this.options.shardsTable} (
        name, region, country, latitude, longitude, radius, connection, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    
    await ReadReplicaManager.getInstance().query(query, [
      shard.name,
      shard.region,
      shard.country,
      shard.latitude,
      shard.longitude,
      shard.radius,
      shard.connection,
      shard.isActive
    ]);
    
    logger.info(`Inserted geographic shard ${shard.name} into database`);
  }

  public async getShardForLocation(latitude: number, longitude: number): Promise<GeographicShardConfig> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Find the shard that contains the location
    const shard = Array.from(this.shards.values()).find(
      s => s.isActive && this.isLocationInShard(latitude, longitude, s)
    );

    if (!shard) {
      throw new Error(`No shard found for location (${latitude}, ${longitude})`);
    }

    return shard;
  }

  private isLocationInShard(latitude: number, longitude: number, shard: GeographicShardConfig): boolean {
    // Calculate the distance between the location and the shard's center
    const distance = this.calculateDistance(
      latitude,
      longitude,
      shard.latitude,
      shard.longitude
    );

    // Check if the location is within the shard's radius
    return distance <= shard.radius;
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

  private async updateShard(shard: GeographicShardConfig): Promise<void> {
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

    logger.info(`Updated geographic shard ${shard.name} in database`);
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

    logger.info(`Inserted metadata for geographic shard ${shardName} into database`);
  }

  public async getShards(): Promise<GeographicShardConfig[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return Array.from(this.shards.values());
  }

  public async getActiveShards(): Promise<GeographicShardConfig[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return Array.from(this.shards.values()).filter(s => s.isActive);
  }

  public async end(): Promise<void> {
    this.isInitialized = false;
    this.shards.clear();
    this.shardMetadata.clear();
    logger.info('Geographic sharding service ended');
  }
} 