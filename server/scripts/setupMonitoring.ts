import { logger } from '../utils/logger';
import { ShardingService } from '../services/sharding';
import { DynamicShardingService, DynamicShardingConfig } from '../services/dynamicSharding';
import { ShardMonitoringService, MonitoringConfig } from '../services/shardMonitoring';

/**
 * Sets up the monitoring dashboard and starts collecting metrics
 */
async function setupMonitoring() {
  logger.info('Setting up shard monitoring');
  
  // Initialize sharding services
  const shardingService = ShardingService.getInstance();
  
  const dynamicShardingConfig: DynamicShardingConfig = {
    shards: [
      { id: 0, host: 'localhost', port: 5432, database: 'vici_dyn_0', user: 'postgres', password: 'postgres' },
      { id: 1, host: 'localhost', port: 5432, database: 'vici_dyn_1', user: 'postgres', password: 'postgres' },
      { id: 2, host: 'localhost', port: 5432, database: 'vici_dyn_2', user: 'postgres', password: 'postgres' },
      { id: 3, host: 'localhost', port: 5432, database: 'vici_dyn_3', user: 'postgres', password: 'postgres' }
    ],
    shardCount: 4,
    defaultShard: 0,
    initialShardCount: 4,
    maxShardCount: 16,
    minShardCount: 2,
    loadThreshold: 0.8,
    monitoringInterval: 300000,
    rebalanceThreshold: 0.2
  };
  
  const dynamicShardingService = new DynamicShardingService(dynamicShardingConfig);
  
  // Initialize monitoring service
  const monitoringConfig: MonitoringConfig = {
    updateInterval: 60000, // 1 minute
    retentionPeriod: 7 * 24 * 60 * 60 * 1000, // 7 days
    alertThresholds: {
      loadPercentage: 0.8,
      errorRate: 0.01,
      responseTime: 1000, // 1 second
      diskUsage: 0.9,
      cpuUsage: 0.8,
      memoryUsage: 0.8
    }
  };
  
  const monitoringService = new ShardMonitoringService(
    monitoringConfig,
    shardingService,
    dynamicShardingService
  );
  
  try {
    // Initialize shards
    logger.info('Initializing shards');
    await dynamicShardingService.initializeShards();
    
    // Start monitoring
    logger.info('Starting monitoring service');
    await monitoringService.startMonitoring();
    
    // Log initial metrics
    const initialMetrics = monitoringService.getAggregatedMetrics();
    logger.info('Initial metrics collected', { metrics: initialMetrics });
    
    // Keep the process running
    process.on('SIGINT', async () => {
      logger.info('Shutting down monitoring service');
      await monitoringService.stop();
      process.exit(0);
    });
    
    logger.info('Monitoring service is running. Press Ctrl+C to stop.');
  } catch (error) {
    logger.error('Failed to set up monitoring', { error });
    process.exit(1);
  }
}

// Run the setup
setupMonitoring()
  .then(() => {
    logger.info('Monitoring setup completed');
  })
  .catch((error) => {
    logger.error('Monitoring setup failed', { error });
    process.exit(1);
  }); 