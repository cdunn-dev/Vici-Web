import { TimeSeriesConfig } from '../services/timeSeriesOptimizationService';

// Default configuration for time-series optimization
export const defaultTimeSeriesConfig: TimeSeriesConfig = {
  tableName: 'time_series_data',
  timestampColumn: 'timestamp',
  downsamplingInterval: '1 day',
  rawDataRetention: '30 days',
  downsampledDataRetention: '1 year',
  usePartitioning: true,
  partitioningInterval: '1 month',
  partitionCount: 12,
  useCompression: true,
  compressionLevel: 6,
  downsampledColumns: ['value'],
  aggregationFunctions: {
    value: 'avg'
  }
};

// Environment-specific configurations
export const timeSeriesConfigs: Record<string, Partial<TimeSeriesConfig>> = {
  development: {
    rawDataRetention: '7 days',
    downsampledDataRetention: '30 days',
    partitionCount: 3
  },
  staging: {
    rawDataRetention: '14 days',
    downsampledDataRetention: '90 days',
    partitionCount: 6
  },
  production: {
    rawDataRetention: '30 days',
    downsampledDataRetention: '1 year',
    partitionCount: 12
  }
};

// Get the configuration for the current environment
export function getTimeSeriesConfig(env: string = process.env.NODE_ENV || 'development'): TimeSeriesConfig {
  const envConfig = timeSeriesConfigs[env] || {};
  
  return {
    ...defaultTimeSeriesConfig,
    ...envConfig
  };
}

// Get configurations for specific tables
export const tableSpecificConfigs: Record<string, Partial<TimeSeriesConfig>> = {
  'sensor_data': {
    downsamplingInterval: '1 hour',
    rawDataRetention: '7 days',
    downsampledDataRetention: '90 days',
    downsampledColumns: ['temperature', 'humidity', 'pressure'],
    aggregationFunctions: {
      temperature: 'avg',
      humidity: 'avg',
      pressure: 'avg'
    }
  },
  'user_activity': {
    downsamplingInterval: '1 day',
    rawDataRetention: '14 days',
    downsampledDataRetention: '180 days',
    downsampledColumns: ['active_users', 'page_views', 'clicks'],
    aggregationFunctions: {
      active_users: 'max',
      page_views: 'sum',
      clicks: 'sum'
    }
  },
  'system_metrics': {
    downsamplingInterval: '5 minutes',
    rawDataRetention: '3 days',
    downsampledDataRetention: '30 days',
    downsampledColumns: ['cpu_usage', 'memory_usage', 'disk_usage'],
    aggregationFunctions: {
      cpu_usage: 'max',
      memory_usage: 'max',
      disk_usage: 'max'
    }
  }
};

// Get the configuration for a specific table
export function getTableTimeSeriesConfig(tableName: string, env: string = process.env.NODE_ENV || 'development'): TimeSeriesConfig {
  const baseConfig = getTimeSeriesConfig(env);
  const tableConfig = tableSpecificConfigs[tableName] || {};
  
  return {
    ...baseConfig,
    ...tableConfig,
    tableName
  };
} 