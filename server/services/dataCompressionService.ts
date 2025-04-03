import { logger } from '../utils/logger';
import ReadReplicaManager from './readReplicaManager';
import { TimeSeriesOptimizationService } from './timeSeriesOptimizationService';
import { getTableTimeSeriesConfig } from '../config/timeSeriesConfig';

export interface CompressionConfig {
  /**
   * The table name for the data to compress
   */
  tableName: string;
  
  /**
   * The column name for the timestamp
   */
  timestampColumn: string;
  
  /**
   * The age threshold for data to be compressed (e.g., '30 days', '90 days', '1 year')
   */
  compressionThreshold: string;
  
  /**
   * The compression method to use (e.g., 'pg_compression', 'zlib', 'lz4')
   */
  compressionMethod: string;
  
  /**
   * The compression level (1-9 for zlib, 1-22 for lz4)
   */
  compressionLevel: number;
  
  /**
   * Whether to use table partitioning for compressed data
   */
  usePartitioning: boolean;
  
  /**
   * The partitioning interval (e.g., '1 month', '3 months', '1 year')
   */
  partitioningInterval: string;
  
  /**
   * The number of partitions to keep
   */
  partitionCount: number;
  
  /**
   * Whether to create a separate table for compressed data
   */
  useSeparateTable: boolean;
  
  /**
   * The name of the compressed table (if useSeparateTable is true)
   */
  compressedTableName?: string;
  
  /**
   * The columns to include in the compressed data
   */
  columnsToCompress: string[];
  
  /**
   * Whether to keep the original data after compression
   */
  keepOriginalData: boolean;
  
  /**
   * The retention period for compressed data (e.g., '1 year', '5 years', '10 years')
   */
  compressedDataRetention: string;
}

export class DataCompressionService {
  private config: CompressionConfig;
  private isInitialized = false;
  private maintenanceInterval: NodeJS.Timeout | null = null;
  private timeSeriesService: TimeSeriesOptimizationService | null = null;

  constructor(config: Partial<CompressionConfig>) {
    this.config = {
      tableName: '',
      timestampColumn: 'timestamp',
      compressionThreshold: '30 days',
      compressionMethod: 'pg_compression',
      compressionLevel: 6,
      usePartitioning: true,
      partitioningInterval: '1 month',
      partitionCount: 12,
      useSeparateTable: true,
      columnsToCompress: [],
      keepOriginalData: false,
      compressedDataRetention: '5 years',
      ...config
    };
    
    // Set default compressed table name if not provided
    if (this.config.useSeparateTable && !this.config.compressedTableName) {
      this.config.compressedTableName = `${this.config.tableName}_compressed`;
    }
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Validate configuration
      this.validateConfig();

      // Initialize time series service if needed
      if (this.shouldUseTimeSeriesService()) {
        await this.initializeTimeSeriesService();
      }

      // Create the compressed table if needed
      if (this.config.useSeparateTable) {
        await this.createCompressedTable();
      }

      // Set up partitioning if enabled
      if (this.config.usePartitioning && this.config.useSeparateTable) {
        await this.setupPartitioning();
      }

      // Start maintenance tasks
      this.startMaintenanceTasks();

      this.isInitialized = true;
      logger.info('Data compression service initialized');
    } catch (error) {
      logger.error('Failed to initialize data compression service', error);
      throw error;
    }
  }

  private validateConfig(): void {
    if (!this.config.tableName) {
      throw new Error('Table name is required');
    }

    if (!this.config.timestampColumn) {
      throw new Error('Timestamp column is required');
    }

    if (this.config.columnsToCompress.length === 0) {
      throw new Error('At least one column to compress is required');
    }

    if (this.config.useSeparateTable && !this.config.compressedTableName) {
      throw new Error('Compressed table name is required when using a separate table');
    }
  }

  private shouldUseTimeSeriesService(): boolean {
    // Check if the table has time series configuration
    try {
      const timeSeriesConfig = getTableTimeSeriesConfig(this.config.tableName);
      return timeSeriesConfig !== null;
    } catch (error) {
      return false;
    }
  }

  private async initializeTimeSeriesService(): Promise<void> {
    const timeSeriesConfig = getTableTimeSeriesConfig(this.config.tableName);
    this.timeSeriesService = new TimeSeriesOptimizationService(timeSeriesConfig);
    await this.timeSeriesService.initialize();
    logger.info(`Initialized time series service for table ${this.config.tableName}`);
  }

  private async createCompressedTable(): Promise<void> {
    if (!this.config.compressedTableName) {
      return;
    }
    
    // Check if the table already exists
    const tableExists = await this.checkTableExists(this.config.compressedTableName);
    
    if (!tableExists) {
      // Create the compressed table
      const createTableQuery = this.generateCreateCompressedTableQuery();
      
      await ReadReplicaManager.getInstance().query(createTableQuery);
      
      logger.info(`Created compressed table ${this.config.compressedTableName}`);
    }
  }

  private async checkTableExists(tableName: string): Promise<boolean> {
    const query = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = $1
      )
    `;
    
    const result = await ReadReplicaManager.getInstance().query(query, [tableName]);
    return result.rows[0].exists;
  }

  private generateCreateCompressedTableQuery(): string {
    if (!this.config.compressedTableName) {
      throw new Error('Compressed table name is required');
    }
    
    // Get the column definitions from the original table
    const query = `
      SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name IN (${this.config.columnsToCompress.map((_, i) => `$${i + 2}`).join(', ')})
    `;
    
    // Execute the query to get column definitions
    const columnParams = [this.config.tableName, ...this.config.columnsToCompress];
    const result = ReadReplicaManager.getInstance().query(query, columnParams);
    
    // Generate column definitions
    const columnDefinitions = this.config.columnsToCompress.map(column => {
      // Default to the same data type as the original column
      return `${column} ${this.getColumnDataType(column)}`;
    });
    
    // Add the timestamp column
    columnDefinitions.unshift(`${this.config.timestampColumn} TIMESTAMP NOT NULL`);
    
    // Add compression settings
    const compressionSettings = this.getCompressionSettings();
    
    // Create the table
    return `
      CREATE TABLE ${this.config.compressedTableName} (
        ${columnDefinitions.join(', ')},
        PRIMARY KEY (${this.config.timestampColumn})
      )
      ${compressionSettings}
    `;
  }

  private getColumnDataType(columnName: string): string {
    // This is a simplified implementation
    // In a real-world scenario, you would need to determine the data type dynamically
    return 'TEXT';
  }

  private getCompressionSettings(): string {
    // This is a simplified implementation
    // In a real-world scenario, you would need to use the appropriate compression settings
    return `WITH (COMPRESS = true)`;
  }

  private async setupPartitioning(): Promise<void> {
    if (!this.config.compressedTableName) {
      return;
    }
    
    // Check if the table is already partitioned
    const isPartitioned = await this.checkTableIsPartitioned(this.config.compressedTableName);
    
    if (!isPartitioned) {
      // Create the partitioned table
      await this.createPartitionedTable();
      
      // Migrate data to the partitioned table
      await this.migrateDataToPartitionedTable();
      
      logger.info(`Set up partitioning for table ${this.config.compressedTableName}`);
    }
  }

  private async checkTableIsPartitioned(tableName: string): Promise<boolean> {
    const query = `
      SELECT EXISTS (
        SELECT FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
        AND c.relname = $1
        AND c.relkind = 'p'
      )
    `;
    
    const result = await ReadReplicaManager.getInstance().query(query, [tableName]);
    return result.rows[0].exists;
  }

  private async createPartitionedTable(): Promise<void> {
    if (!this.config.compressedTableName) {
      return;
    }
    
    // This is a simplified implementation
    // In a real-world scenario, you would need to determine the column types dynamically
    const query = `
      CREATE TABLE ${this.config.compressedTableName}_partitioned (
        LIKE ${this.config.compressedTableName} INCLUDING ALL
      ) PARTITION BY RANGE (${this.config.timestampColumn});
    `;
    
    await ReadReplicaManager.getInstance().query(query);
    
    // Create partitions
    await this.createPartitions();
  }

  private async createPartitions(): Promise<void> {
    if (!this.config.compressedTableName) {
      return;
    }
    
    // This is a simplified implementation
    // In a real-world scenario, you would need to determine the partition ranges dynamically
    const query = `
      CREATE TABLE ${this.config.compressedTableName}_partition_1 
      PARTITION OF ${this.config.compressedTableName}_partitioned
      FOR VALUES FROM ('2023-01-01') TO ('2023-02-01');
    `;
    
    await ReadReplicaManager.getInstance().query(query);
    
    // Create more partitions as needed
  }

  private async migrateDataToPartitionedTable(): Promise<void> {
    if (!this.config.compressedTableName) {
      return;
    }
    
    // This is a simplified implementation
    // In a real-world scenario, you would need to migrate data in batches
    const query = `
      INSERT INTO ${this.config.compressedTableName}_partitioned
      SELECT * FROM ${this.config.compressedTableName};
    `;
    
    await ReadReplicaManager.getInstance().query(query);
  }

  private startMaintenanceTasks(): void {
    // Run maintenance tasks daily
    this.maintenanceInterval = setInterval(() => {
      this.runMaintenanceTasks().catch(err => {
        logger.error('Error running maintenance tasks', err);
      });
    }, 24 * 60 * 60 * 1000);
    
    // Run maintenance tasks immediately
    this.runMaintenanceTasks().catch(err => {
      logger.error('Error running maintenance tasks', err);
    });
  }

  private async runMaintenanceTasks(): Promise<void> {
    logger.info('Running data compression maintenance tasks');
    
    // Compress data
    await this.compressData();
    
    // Clean up old data
    await this.cleanupOldData();
    
    // Create new partitions if needed
    if (this.config.usePartitioning && this.config.useSeparateTable) {
      await this.createNewPartitions();
    }
    
    logger.info('Data compression maintenance tasks completed');
  }

  private async compressData(): Promise<void> {
    // Generate the compression query
    const query = this.generateCompressionQuery();
    
    await ReadReplicaManager.getInstance().query(query);
    
    logger.info(`Compressed data for table ${this.config.tableName}`);
  }

  private generateCompressionQuery(): string {
    if (this.config.useSeparateTable && this.config.compressedTableName) {
      // Insert into a separate compressed table
      return `
        INSERT INTO ${this.config.compressedTableName} (${this.config.timestampColumn}, ${this.config.columnsToCompress.join(', ')})
        SELECT ${this.config.timestampColumn}, ${this.config.columnsToCompress.join(', ')}
        FROM ${this.config.tableName}
        WHERE ${this.config.timestampColumn} < NOW() - INTERVAL '${this.config.compressionThreshold}'
        AND ${this.config.timestampColumn} > (
          SELECT COALESCE(MAX(${this.config.timestampColumn}), '1970-01-01')
          FROM ${this.config.compressedTableName}
        )
        ORDER BY ${this.config.timestampColumn}
      `;
    } else {
      // Compress data in-place
      return `
        ALTER TABLE ${this.config.tableName}
        SET (
          COMPRESS = true,
          COMPRESSION_LEVEL = ${this.config.compressionLevel}
        )
        WHERE ${this.config.timestampColumn} < NOW() - INTERVAL '${this.config.compressionThreshold}'
      `;
    }
  }

  private async cleanupOldData(): Promise<void> {
    if (this.config.useSeparateTable && this.config.compressedTableName) {
      // Clean up old compressed data
      const compressedDataQuery = `
        DELETE FROM ${this.config.compressedTableName}
        WHERE ${this.config.timestampColumn} < NOW() - INTERVAL '${this.config.compressedDataRetention}'
      `;
      
      await ReadReplicaManager.getInstance().query(compressedDataQuery);
      
      // Clean up original data if configured
      if (!this.config.keepOriginalData) {
        const originalDataQuery = `
          DELETE FROM ${this.config.tableName}
          WHERE ${this.config.timestampColumn} < NOW() - INTERVAL '${this.config.compressionThreshold}'
          AND ${this.config.timestampColumn} > (
            SELECT COALESCE(MAX(${this.config.timestampColumn}), '1970-01-01')
            FROM ${this.config.compressedTableName}
          )
        `;
        
        await ReadReplicaManager.getInstance().query(originalDataQuery);
      }
    } else {
      // Clean up old data
      const query = `
        DELETE FROM ${this.config.tableName}
        WHERE ${this.config.timestampColumn} < NOW() - INTERVAL '${this.config.compressedDataRetention}'
      `;
      
      await ReadReplicaManager.getInstance().query(query);
    }
    
    logger.info(`Cleaned up old data for table ${this.config.tableName}`);
  }

  private async createNewPartitions(): Promise<void> {
    if (!this.config.compressedTableName) {
      return;
    }
    
    // This is a simplified implementation
    // In a real-world scenario, you would need to determine the partition ranges dynamically
    logger.info(`Creating new partitions for table ${this.config.compressedTableName}`);
  }

  public async queryCompressedData(
    startTime: Date,
    endTime: Date,
    columns: string[] = []
  ): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Determine which table to query
    const tableName = this.config.useSeparateTable && this.config.compressedTableName
      ? this.config.compressedTableName
      : this.config.tableName;
    
    // Determine which columns to select
    const selectedColumns = columns.length > 0 
      ? columns.map(col => `${col}`).join(', ') 
      : '*';
    
    // Generate the query
    const query = `
      SELECT ${selectedColumns}
      FROM ${tableName}
      WHERE ${this.config.timestampColumn} BETWEEN $1 AND $2
      ORDER BY ${this.config.timestampColumn}
    `;
    
    // Execute the query
    const result = await ReadReplicaManager.getInstance().query(query, [startTime, endTime]);
    
    return result.rows;
  }

  public async insertData(data: Record<string, any>[]): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (data.length === 0) {
      return;
    }

    // Determine the columns
    const columns = Object.keys(data[0]);
    
    // Generate the placeholders
    const placeholders = data.map((_, i) => {
      const values = columns.map((_, j) => `$${i * columns.length + j + 1}`);
      return `(${values.join(', ')})`;
    }).join(', ');
    
    // Flatten the data
    const values = data.flatMap(item => columns.map(col => item[col]));
    
    // Generate the query
    const query = `
      INSERT INTO ${this.config.tableName} (${columns.join(', ')})
      VALUES ${placeholders}
    `;
    
    // Execute the query
    await ReadReplicaManager.getInstance().query(query, values);
    
    logger.info(`Inserted ${data.length} rows into ${this.config.tableName}`);
  }

  public async end(): Promise<void> {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }
    
    if (this.timeSeriesService) {
      await this.timeSeriesService.end();
      this.timeSeriesService = null;
    }
    
    this.isInitialized = false;
    logger.info('Data compression service ended');
  }
} 