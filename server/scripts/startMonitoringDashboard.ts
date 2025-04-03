import { logger } from '../utils/logger';
import { ShardingService } from '../services/sharding';
import { ShardMonitoringService } from '../services/shardMonitoring';
import { ShardMonitoringDashboard, DashboardConfig } from '../services/shardMonitoringDashboard';

/**
 * Starts the shard monitoring dashboard
 * @returns Promise that resolves when the dashboard is started
 */
async function startMonitoringDashboard(): Promise<void> {
  logger.info('Starting shard monitoring dashboard');
  
  try {
    // Initialize services
    const shardingService = ShardingService.getInstance();
    const monitoringService = new ShardMonitoringService();
    
    // Configure dashboard
    const dashboardConfig: DashboardConfig = {
      updateInterval: 60000, // 1 minute
      alertThresholds: {
        loadPercentage: 80, // 80% load threshold
        errorRate: 0.01, // 1% error rate threshold
        responseTime: 1000 // 1 second response time threshold
      }
    };
    
    // Create and start dashboard
    const dashboard = new ShardMonitoringDashboard(
      shardingService,
      monitoringService,
      dashboardConfig
    );
    
    await dashboard.start();
    
    // Handle process termination
    process.on('SIGINT', async () => {
      logger.info('Stopping shard monitoring dashboard');
      await dashboard.stop();
      process.exit(0);
    });
    
    logger.info('Shard monitoring dashboard started successfully');
  } catch (error) {
    logger.error('Failed to start shard monitoring dashboard', { error });
    process.exit(1);
  }
}

// Start the dashboard
startMonitoringDashboard(); 