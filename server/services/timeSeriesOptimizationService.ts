import { logger } from '../utils/logger';
import ReadReplicaManager from './readReplicaManager';

export interface TimeSeriesConfig {
  /**
   * The table name for the time series data
   */
  tableName: string;
  
  /**
   * The column name for the timestamp
   */
  timestampColumn: string;
  
  /**
   * The interval for downsampling (e.g., '1 hour', '1 day', '1 week')
   */
  downsamplingInterval: string;
  
  /**
   * The retention period for raw data (e.g., '7 days', '30 days', '1 year')
   */
  rawDataRetention: string;
  
  /**
   * The retention period for downsampled data (e.g., '30 days', '1 year', '5 years')
   */
  downsampledDataRetention: string;
  
  /**
   * Whether to use partitioning for the time series data
   */
  usePartitioning: boolean;
  
  /**
   * The partitioning interval (e.g., '1 day', '1 week', '1 month')
   */
  partitioningInterval: string;
  
  /**
   * The number of partitions to keep
   */
  partitionCount: number;
  
  /**
   * Whether to use compression for historical data
   */
  useCompression: boolean;
  
  /**
   * The compression level (1-9)
   */
  compressionLevel: number;
  
  /**
   * The columns to include in the downsampled data
   */
  downsampledColumns: string[];
  
  /**
   * The aggregation functions to use for each column (e.g., 'avg', 'min', 'max', 'sum')
   */
  aggregationFunctions: Record<string, string>;
}

export class TimeSeriesOptimizationService {
  private config: TimeSeriesConfig;
  private isInitialized = false;
  private maintenanceInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<TimeSeriesConfig>) {
    this.config = {
      tableName: '',
      timestampColumn: 'timestamp',
      downsamplingInterval: '1 day',
      rawDataRetention: '30 days',
      downsampledDataRetention: '1 year',
      usePartitioning: true,
      partitioningInterval: '1 month',
      partitionCount: 12,
      useCompression: true,
      compressionLevel: 6,
      downsampledColumns: [],
      aggregationFunctions: {},
      ...config
    };
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Validate configuration
      this.validateConfig();

      // Create the downsampled table if it doesn't exist
      await this.createDownsampledTable();

      // Set up partitioning if enabled
      if (this.config.usePartitioning) {
        await this.setupPartitioning();
      }

      // Start maintenance tasks
      this.startMaintenanceTasks();

      this.isInitialized = true;
      logger.info('Time series optimization service initialized');
    } catch (error) {
      logger.error('Failed to initialize time series optimization service', error);
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

    if (this.config.downsampledColumns.length === 0) {
      throw new Error('At least one downsampled column is required');
    }

    if (Object.keys(this.config.aggregationFunctions).length === 0) {
      throw new Error('At least one aggregation function is required');
    }

    // Validate that all downsampled columns have an aggregation function
    for (const column of this.config.downsampledColumns) {
      if (!this.config.aggregationFunctions[column]) {
        throw new Error(`No aggregation function specified for column ${column}`);
      }
    }
  }

  private async createDownsampledTable(): Promise<void> {
    const downsampledTableName = `${this.config.tableName}_downsampled`;
    
    // Check if the table already exists
    const tableExists = await this.checkTableExists(downsampledTableName);
    
    if (!tableExists) {
      // Create the downsampled table
      const createTableQuery = this.generateCreateDownsampledTableQuery(downsampledTableName);
      
      await ReadReplicaManager.getInstance().query(createTableQuery);
      
      logger.info(`Created downsampled table ${downsampledTableName}`);
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

  private generateCreateDownsampledTableQuery(tableName: string): string {
    // Generate column definitions for the downsampled table
    const columnDefinitions = this.config.downsampledColumns.map(column => {
      // Determine the data type based on the aggregation function
      let dataType = 'DOUBLE PRECISION';
      
      if (this.config.aggregationFunctions[column] === 'count') {
        dataType = 'BIGINT';
      } else if (this.config.aggregationFunctions[column] === 'min' || 
                 this.config.aggregationFunctions[column] === 'max') {
        // Use the same data type as the original column
        dataType = 'DOUBLE PRECISION'; // Default, should be determined dynamically in a real implementation
      }
      
      return `${column} ${dataType}`;
    });
    
    // Add the timestamp column
    columnDefinitions.unshift(`${this.config.timestampColumn} TIMESTAMP NOT NULL`);
    
    // Create the table
    return `
      CREATE TABLE ${tableName} (
        ${columnDefinitions.join(', ')},
        PRIMARY KEY (${this.config.timestampColumn})
      )
    `;
  }

  private async setupPartitioning(): Promise<void> {
    // Check if the table is already partitioned
    const isPartitioned = await this.checkTableIsPartitioned(this.config.tableName);
    
    if (!isPartitioned) {
      // Create the partitioned table
      await this.createPartitionedTable();
      
      // Migrate data to the partitioned table
      await this.migrateDataToPartitionedTable();
      
      logger.info(`Set up partitioning for table ${this.config.tableName}`);
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
    // This is a simplified implementation
    // In a real-world scenario, you would need to determine the column types dynamically
    const query = `
      CREATE TABLE ${this.config.tableName}_partitioned (
        LIKE ${this.config.tableName} INCLUDING ALL
      ) PARTITION BY RANGE (${this.config.timestampColumn});
    `;
    
    await ReadReplicaManager.getInstance().query(query);
    
    // Create partitions
    await this.createPartitions();
  }

  private async createPartitions(): Promise<void> {
    // This is a simplified implementation
    // In a real-world scenario, you would need to determine the partition ranges dynamically
    const query = `
      CREATE TABLE ${this.config.tableName}_partition_1 
      PARTITION OF ${this.config.tableName}_partitioned
      FOR VALUES FROM ('2023-01-01') TO ('2023-02-01');
    `;
    
    await ReadReplicaManager.getInstance().query(query);
    
    // Create more partitions as needed
  }

  private async migrateDataToPartitionedTable(): Promise<void> {
    // This is a simplified implementation
    // In a real-world scenario, you would need to migrate data in batches
    const query = `
      INSERT INTO ${this.config.tableName}_partitioned
      SELECT * FROM ${this.config.tableName};
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
    logger.info('Running time series maintenance tasks');
    
    // Downsample data
    await this.downsampleData();
    
    // Clean up old data
    await this.cleanupOldData();
    
    // Create new partitions if needed
    if (this.config.usePartitioning) {
      await this.createNewPartitions();
    }
    
    // Compress historical data if enabled
    if (this.config.useCompression) {
      await this.compressHistoricalData();
    }
    
    logger.info('Time series maintenance tasks completed');
  }

  private async downsampleData(): Promise<void> {
    const downsampledTableName = `${this.config.tableName}_downsampled`;
    
    // Generate the downsampling query
    const query = this.generateDownsamplingQuery(downsampledTableName);
    
    await ReadReplicaManager.getInstance().query(query);
    
    logger.info(`Downsampled data for table ${this.config.tableName}`);
  }

  private generateDownsamplingQuery(downsampledTableName: string): string {
    // Generate the aggregation expressions
    const aggregationExpressions = this.config.downsampledColumns.map(column => {
      const functionName = this.config.aggregationFunctions[column];
      return `${functionName}(${column}) AS ${column}`;
    });
    
    // Create the downsampling query
    return `
      INSERT INTO ${downsampledTableName} (${this.config.timestampColumn}, ${this.config.downsampledColumns.join(', ')})
      SELECT 
        date_trunc('${this.config.downsamplingInterval}', ${this.config.timestampColumn}) AS ${this.config.timestampColumn},
        ${aggregationExpressions.join(', ')}
      FROM ${this.config.tableName}
      WHERE ${this.config.timestampColumn} > (
        SELECT COALESCE(MAX(${this.config.timestampColumn}), '1970-01-01')
        FROM ${downsampledTableName}
      )
      GROUP BY date_trunc('${this.config.downsamplingInterval}', ${this.config.timestampColumn})
      ORDER BY ${this.config.timestampColumn}
    `;
  }

  private async cleanupOldData(): Promise<void> {
    // Clean up old raw data
    const rawDataQuery = `
      DELETE FROM ${this.config.tableName}
      WHERE ${this.config.timestampColumn} < NOW() - INTERVAL '${this.config.rawDataRetention}'
    `;
    
    await ReadReplicaManager.getInstance().query(rawDataQuery);
    
    // Clean up old downsampled data
    const downsampledTableName = `${this.config.tableName}_downsampled`;
    const downsampledDataQuery = `
      DELETE FROM ${downsampledTableName}
      WHERE ${this.config.timestampColumn} < NOW() - INTERVAL '${this.config.downsampledDataRetention}'
    `;
    
    await ReadReplicaManager.getInstance().query(downsampledDataQuery);
    
    logger.info(`Cleaned up old data for table ${this.config.tableName}`);
  }

  private async createNewPartitions(): Promise<void> {
    // This is a simplified implementation
    // In a real-world scenario, you would need to determine the partition ranges dynamically
    logger.info(`Creating new partitions for table ${this.config.tableName}`);
  }

  private async compressHistoricalData(): Promise<void> {
    // This is a simplified implementation
    // In a real-world scenario, you would need to use PostgreSQL's table compression
    logger.info(`Compressing historical data for table ${this.config.tableName}`);
  }

  public async queryTimeSeriesData(
    startTime: Date,
    endTime: Date,
    columns: string[] = [],
    interval: string = this.config.downsamplingInterval,
    useDownsampled: boolean = true
  ): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Determine which table to query
    const tableName = useDownsampled ? `${this.config.tableName}_downsampled` : this.config.tableName;
    
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

  public async insertTimeSeriesData(data: Record<string, any>[]): Promise<void> {
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
    
    this.isInitialized = false;
    logger.info('Time series optimization service ended');
  }
} 