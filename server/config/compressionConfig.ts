import { CompressionConfig } from '../services/dataCompressionService';

// Default configuration for data compression
export const defaultCompressionConfig: CompressionConfig = {
  tableName: 'historical_data',
  timestampColumn: 'timestamp',
  compressionThreshold: '30 days',
  compressionMethod: 'pg_compression',
  compressionLevel: 6,
  usePartitioning: true,
  partitioningInterval: '1 month',
  partitionCount: 12,
  useSeparateTable: true,
  columnsToCompress: ['data'],
  keepOriginalData: false,
  compressedDataRetention: '5 years'
};

// Environment-specific configurations
export const compressionConfigs: Record<string, Partial<CompressionConfig>> = {
  development: {
    compressionThreshold: '7 days',
    compressedDataRetention: '30 days',
    partitionCount: 3
  },
  staging: {
    compressionThreshold: '14 days',
    compressedDataRetention: '90 days',
    partitionCount: 6
  },
  production: {
    compressionThreshold: '30 days',
    compressedDataRetention: '5 years',
    partitionCount: 12
  }
};

// Get the configuration for the current environment
export function getCompressionConfig(env: string = process.env.NODE_ENV || 'development'): CompressionConfig {
  const envConfig = compressionConfigs[env] || {};
  
  return {
    ...defaultCompressionConfig,
    ...envConfig
  };
}

// Get configurations for specific tables
export const tableSpecificCompressionConfigs: Record<string, Partial<CompressionConfig>> = {
  'sensor_data': {
    compressionThreshold: '7 days',
    compressedDataRetention: '90 days',
    columnsToCompress: ['temperature', 'humidity', 'pressure', 'raw_data'],
    keepOriginalData: true
  },
  'user_activity': {
    compressionThreshold: '14 days',
    compressedDataRetention: '180 days',
    columnsToCompress: ['user_id', 'action', 'page', 'session_data', 'metadata'],
    keepOriginalData: false
  },
  'system_metrics': {
    compressionThreshold: '3 days',
    compressedDataRetention: '30 days',
    columnsToCompress: ['cpu_usage', 'memory_usage', 'disk_usage', 'network_traffic', 'error_logs'],
    keepOriginalData: true
  },
  'audit_logs': {
    compressionThreshold: '30 days',
    compressedDataRetention: '1 year',
    columnsToCompress: ['user_id', 'action', 'resource', 'details', 'ip_address', 'user_agent'],
    keepOriginalData: false
  },
  'performance_metrics': {
    compressionThreshold: '7 days',
    compressedDataRetention: '90 days',
    columnsToCompress: ['query', 'execution_time', 'rows_affected', 'plan', 'parameters'],
    keepOriginalData: true
  }
};

// Get the configuration for a specific table
export function getTableCompressionConfig(tableName: string, env: string = process.env.NODE_ENV || 'development'): CompressionConfig {
  const baseConfig = getCompressionConfig(env);
  const tableConfig = tableSpecificCompressionConfigs[tableName] || {};
  
  return {
    ...baseConfig,
    ...tableConfig,
    tableName
  };
}

// Get configurations for all tables that should be compressed
export function getAllCompressionConfigs(env: string = process.env.NODE_ENV || 'development'): CompressionConfig[] {
  return Object.keys(tableSpecificCompressionConfigs).map(tableName => 
    getTableCompressionConfig(tableName, env)
  );
} 