import { logger } from '../utils/logger';
import ReadReplicaManager from './readReplicaManager';
import { RangeShardingService } from './rangeShardingService';
import { GeographicShardingService } from './geographicShardingService';
import { CompositeShardingService } from './compositeShardingService';

export interface LoadMetrics {
  /**
   * The number of queries executed in the last minute
   */
  queriesPerMinute: number;
  
  /**
   * The average response time in milliseconds
   */
  averageResponseTime: number;
  
  /**
   * The number of active connections
   */
  activeConnections: number;
  
  /**
   * The CPU usage percentage
   */
  cpuUsage: number;
  
  /**
   * The memory usage percentage
   */
  memoryUsage: number;
  
  /**
   * The disk usage percentage
   */
  diskUsage: number;
  
  /**
   * The timestamp when these metrics were collected
   */
  timestamp: Date;
}

export interface DynamicShardConfig {
  /**
   * The name of the shard
   */
  name: string;
  
  /**
   * The type of sharding strategy used
   */
  strategy: 'range' | 'geographic' | 'composite';
  
  /**
   * The shard key or configuration
   */
  config: any;
  
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
   * The load metrics for this shard
   */
  loadMetrics?: LoadMetrics;
  
  /**
   * The number of errors encountered with this shard
   */
  errorCount?: number;
  
  /**
   * The number of queries executed on this shard
   */
  queryCount?: number;
}

export interface DynamicShardingOptions {
  /**
   * The range sharding service to use
   */
  rangeShardingService: RangeShardingService;
  
  /**
   * The geographic sharding service to use
   */
  geographicShardingService: GeographicShardingService;
  
  /**
   * The composite sharding service to use
   */
  compositeShardingService: CompositeShardingService;
  
  /**
   * The table name for tracking shards
   */
  shardsTable: string;
  
  /**
   * The table name for tracking shard metadata
   */
  shardMetadataTable: string;
  
  /**
   * The interval for collecting load metrics in milliseconds
   */
  metricsInterval: number;
  
  /**
   * The threshold for CPU usage that triggers shard creation
   */
  cpuThreshold: number;
  
  /**
   * The threshold for memory usage that triggers shard creation
   */
  memoryThreshold: number;
  
  /**
   * The threshold for disk usage that triggers shard creation
   */
  diskThreshold: number;
  
  /**
   * The threshold for queries per minute that triggers shard creation
   */
  queriesPerMinuteThreshold: number;
  
  /**
   * The threshold for response time that triggers shard creation
   */
  responseTimeThreshold: number;
  
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

export class DynamicShardingService {
  private options: DynamicShardingOptions;
  private isInitialized = false;
  private shards: Map<string, DynamicShardConfig> = new Map();
  private shardMetadata: Map<string, any> = new Map();
  private metricsInterval: NodeJS.Timeout | null = null;

  constructor(options: Partial<DynamicShardingOptions>) {
    this.options = {
      rangeShardingService: new RangeShardingService({}),
      geographicShardingService: new GeographicShardingService({}),
      compositeShardingService: new CompositeShardingService({}),
      shardsTable: 'dynamic_shards',
      shardMetadataTable: 'dynamic_shard_metadata',
      metricsInterval: 60000, // 1 minute
      cpuThreshold: 80, // 80%
      memoryThreshold: 80, // 80%
      diskThreshold: 80, // 80%
      queriesPerMinuteThreshold: 1000,
      responseTimeThreshold: 1000, // 1 second
      useTransactions: true,
      timeout: 30000,
      validateBeforeUse: true,
      createBackup: true,
      backupDir: 'backups/dynamic_shards',
      logShards: true,
      ...options
    };
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Initialize the sharding services
      await this.options.rangeShardingService.initialize();
      await this.options.geographicShardingService.initialize();
      await this.options.compositeShardingService.initialize();

      // Create shards table if it doesn't exist
      await this.createShardsTable();

      // Create shard metadata table if it doesn't exist
      await this.createShardMetadataTable();

      // Load shards from the database
      await this.loadShards();

      // Load shard metadata from the database
      await this.loadShardMetadata();

      // Start collecting metrics
      this.startMetricsCollection();

      this.isInitialized = true;
      logger.info('Dynamic sharding service initialized');
    } catch (error) {
      logger.error('Failed to initialize dynamic sharding service', error);
      throw error;
    }
  }

  private async createShardsTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS ${this.options.shardsTable} (
        name VARCHAR(255) PRIMARY KEY,
        strategy VARCHAR(50) NOT NULL,
        config JSONB NOT NULL,
        connection JSONB NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        last_checked TIMESTAMP,
        load_metrics JSONB,
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
        strategy: row.strategy,
        config: row.config,
        connection: row.connection,
        isActive: row.is_active,
        lastChecked: row.last_checked ? new Date(row.last_checked) : undefined,
        loadMetrics: row.load_metrics,
        errorCount: row.error_count,
        queryCount: row.query_count
      });
    }
    
    logger.info(`Loaded ${this.shards.size} dynamic shards from database`);
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
    
    logger.info(`Loaded ${this.shardMetadata.size} dynamic shard metadata entries from database`);
  }

  private startMetricsCollection(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }

    this.metricsInterval = setInterval(async () => {
      try {
        await this.collectMetrics();
      } catch (error) {
        logger.error('Failed to collect metrics', error);
      }
    }, this.options.metricsInterval);
  }

  private async collectMetrics(): Promise<void> {
    for (const shard of this.shards.values()) {
      if (!shard.isActive) {
        continue;
      }

      try {
        // Collect metrics from the shard
        const metrics = await this.getShardMetrics(shard);

        // Update the shard's metrics
        shard.loadMetrics = metrics;

        // Check if we need to create a new shard
        if (this.shouldCreateNewShard(metrics)) {
          await this.createNewShard(shard);
        }

        // Update the shard in the database
        await this.updateShard(shard);
      } catch (error) {
        logger.error(`Failed to collect metrics for shard ${shard.name}`, error);
      }
    }
  }

  private async getShardMetrics(shard: DynamicShardConfig): Promise<LoadMetrics> {
    // This is a simplified implementation
    // In a real-world scenario, you would need to implement a more sophisticated metrics collection system
    const query = `
      SELECT
        COUNT(*) as query_count,
        AVG(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000) as avg_response_time,
        COUNT(DISTINCT pid) as active_connections
      FROM pg_stat_activity
      WHERE datname = $1
      AND state = 'active'
      AND started_at > NOW() - INTERVAL '1 minute'
    `;

    const result = await ReadReplicaManager.getInstance().query(query, [shard.connection.database]);

    return {
      queriesPerMinute: parseInt(result.rows[0].query_count) || 0,
      averageResponseTime: parseFloat(result.rows[0].avg_response_time) || 0,
      activeConnections: parseInt(result.rows[0].active_connections) || 0,
      cpuUsage: 0, // This would require a system-level metric collection
      memoryUsage: 0, // This would require a system-level metric collection
      diskUsage: 0, // This would require a system-level metric collection
      timestamp: new Date()
    };
  }

  private shouldCreateNewShard(metrics: LoadMetrics): boolean {
    return (
      metrics.cpuUsage > this.options.cpuThreshold ||
      metrics.memoryUsage > this.options.memoryThreshold ||
      metrics.diskUsage > this.options.diskThreshold ||
      metrics.queriesPerMinute > this.options.queriesPerMinuteThreshold ||
      metrics.averageResponseTime > this.options.responseTimeThreshold
    );
  }

  private async createNewShard(baseShard: DynamicShardConfig): Promise<void> {
    // This is a simplified implementation
    // In a real-world scenario, you would need to implement a more sophisticated shard creation strategy
    const newShard: Omit<DynamicShardConfig, 'name'> = {
      strategy: baseShard.strategy,
      config: { ...baseShard.config },
      connection: { ...baseShard.connection },
      isActive: true
    };

    // Generate a name for the new shard
    const name = `dynamic_${baseShard.strategy}_${Date.now()}`;

    // Create the shard
    const shard: DynamicShardConfig = {
      name,
      ...newShard
    };

    // Insert the shard into the database
    await this.insertShard(shard);

    // Add the shard to the map
    this.shards.set(name, shard);

    logger.info(`Created new dynamic shard ${name} based on load`);
  }

  private async insertShard(shard: DynamicShardConfig): Promise<void> {
    const query = `
      INSERT INTO ${this.options.shardsTable} (
        name, strategy, config, connection, is_active
      ) VALUES ($1, $2, $3, $4, $5)
    `;
    
    await ReadReplicaManager.getInstance().query(query, [
      shard.name,
      shard.strategy,
      shard.config,
      shard.connection,
      shard.isActive
    ]);
    
    logger.info(`Inserted dynamic shard ${shard.name} into database`);
  }

  private async updateShard(shard: DynamicShardConfig): Promise<void> {
    const query = `
      UPDATE ${this.options.shardsTable}
      SET is_active = $1, last_checked = $2, load_metrics = $3, error_count = $4, query_count = $5, updated_at = CURRENT_TIMESTAMP
      WHERE name = $6
    `;

    await ReadReplicaManager.getInstance().query(query, [
      shard.isActive,
      shard.lastChecked,
      shard.loadMetrics,
      shard.errorCount,
      shard.queryCount,
      shard.name
    ]);

    logger.info(`Updated dynamic shard ${shard.name} in database`);
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

    logger.info(`Inserted metadata for dynamic shard ${shardName} into database`);
  }

  public async getShards(): Promise<DynamicShardConfig[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return Array.from(this.shards.values());
  }

  public async getActiveShards(): Promise<DynamicShardConfig[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return Array.from(this.shards.values()).filter(s => s.isActive);
  }

  public async end(): Promise<void> {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    this.isInitialized = false;
    this.shards.clear();
    this.shardMetadata.clear();
    logger.info('Dynamic sharding service ended');
  }
} 