import { EventEmitter } from 'events';
import { Pool } from 'pg';
import { MonitoringService, ApplicationMetrics as MonitoringAppMetrics, DatabaseMetrics as MonitoringDbMetrics } from './monitoring';
import { ShardMonitoringService, MonitoringConfig, ShardMetrics } from './shardMonitoring';
import { ShardMonitoringDashboard } from './shardMonitoringDashboard';
import { RedisMonitor } from './redisMonitor';
import { logger } from '../utils/logger';
import { ShardingService, ShardingConfig } from './sharding';
import { DynamicShardingService, DynamicShardingConfig } from './dynamicSharding';

export interface MonitoringSystemConfig {
  updateInterval: number;
  retentionPeriod: number;
  alertThresholds: {
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
    responseTime: number;
    errorRate: number;
    loadPercentage: number;
  };
  notificationChannels: {
    email: boolean;
    slack: boolean;
    webhook: boolean;
  };
}

export interface SystemMetrics {
  timestamp: Date;
  application: {
    cpuUsage: {
      user: number;
      system: number;
    };
    memoryUsage: {
      heapUsed: number;
      heapTotal: number;
      external: number;
      rss: number;
    };
    activeRequests: number;
    errorRate: number;
  };
  database: {
    activeConnections: number;
    idleConnections: number;
    waitingConnections: number;
    maxConnections: number;
    totalQueries: number;
    slowQueries: number;
    avgQueryTime: number;
  };
  cache: {
    hitRate: number;
    memoryUsage: number;
    evictionCount: number;
    connectedClients: number;
    totalCommands: number;
    opsPerSecond: number;
  };
  shards: {
    totalShards: number;
    avgLoadPercentage: number;
    avgResponseTime: number;
    errorRate: number;
  };
}

interface ApplicationMetrics {
  cpuUsage: {
    user: number;
    system: number;
  };
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
  };
  activeRequests: number;
  errorRate: number;
}

interface DatabaseMetrics {
  activeConnections: number;
  totalQueries: number;
  slowQueries: number;
  avgQueryTime: number;
}

interface RedisStats {
  timestamp: Date;
  connected: boolean;
  memoryUsage: {
    used: number;
    total: number;
  };
  cacheMetrics: {
    hits: number;
    misses: number;
    hitRate: number;
    evictions: number;
  };
  evictionPolicy: string;
}

export class MonitoringSystem extends EventEmitter {
  private static instance: MonitoringSystem;
  private config: MonitoringSystemConfig;
  private monitoringService: MonitoringService;
  private shardMonitoringService: ShardMonitoringService;
  private shardDashboard: ShardMonitoringDashboard;
  private redisMonitor: RedisMonitor;
  private metrics: SystemMetrics[] = [];
  private monitoringInterval: NodeJS.Timeout | null = null;
  private shardingService: ShardingService;
  private dynamicShardingService: DynamicShardingService;
  private pool: Pool;

  private constructor(config: MonitoringSystemConfig) {
    super();
    this.config = config;
    this.monitoringService = MonitoringService.getInstance();
    this.pool = new Pool();
    
    // Initialize sharding service
    this.shardingService = ShardingService.getInstance();
    const shardingConfig: ShardingConfig = {
      shards: [
        {
          id: 0,
          host: 'localhost',
          port: 5432,
          database: 'vici',
          user: 'postgres',
          password: 'postgres'
        }
      ],
      shardCount: 1,
      defaultShard: 0
    };
    this.shardingService.initialize(shardingConfig);
    
    // Initialize dynamic sharding service
    this.dynamicShardingService = new DynamicShardingService({
      shards: shardingConfig.shards,
      initialShardCount: 1,
      maxShardCount: 4,
      minShardCount: 1,
      loadThreshold: 0.8,
      monitoringInterval: config.updateInterval,
      rebalanceThreshold: 0.2,
      shardCount: shardingConfig.shardCount,
      defaultShard: shardingConfig.defaultShard
    });
    
    // Initialize shard monitoring with config
    const monitoringConfig: MonitoringConfig = {
      updateInterval: config.updateInterval,
      retentionPeriod: config.retentionPeriod,
      alertThresholds: {
        loadPercentage: config.alertThresholds.loadPercentage,
        errorRate: config.alertThresholds.errorRate,
        responseTime: config.alertThresholds.responseTime,
        diskUsage: config.alertThresholds.diskUsage,
        cpuUsage: config.alertThresholds.cpuUsage,
        memoryUsage: config.alertThresholds.memoryUsage
      }
    };
    
    this.shardMonitoringService = new ShardMonitoringService(
      monitoringConfig,
      this.shardingService,
      this.dynamicShardingService
    );
    
    // Initialize shard dashboard
    this.shardDashboard = new ShardMonitoringDashboard(
      this.pool,
      this.shardingService,
      this.shardMonitoringService,
      {
        updateInterval: config.updateInterval,
        alertThresholds: {
          loadPercentage: config.alertThresholds.loadPercentage,
          errorRate: config.alertThresholds.errorRate,
          responseTime: config.alertThresholds.responseTime
        }
      }
    );
    
    this.redisMonitor = new RedisMonitor();
  }

  public static getInstance(config?: MonitoringSystemConfig): MonitoringSystem {
    if (!MonitoringSystem.instance) {
      if (!config) {
        throw new Error('Configuration required for first initialization');
      }
      MonitoringSystem.instance = new MonitoringSystem(config);
    }
    return MonitoringSystem.instance;
  }

  public async start(): Promise<void> {
    logger.info('Starting monitoring system');

    try {
      // Start all monitoring services
      await this.shardMonitoringService.startMonitoring();
      await this.shardDashboard.start();
      this.redisMonitor.startMonitoring();

      // Start system-wide monitoring
      this.monitoringInterval = setInterval(
        () => this.collectSystemMetrics(),
        this.config.updateInterval
      );

      // Initial metrics collection
      await this.collectSystemMetrics();

      logger.info('Monitoring system started successfully');
    } catch (error) {
      logger.error('Failed to start monitoring system', { error });
      throw error;
    }
  }

  public async stop(): Promise<void> {
    logger.info('Stopping monitoring system');

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    await this.shardMonitoringService.stop();
    await this.shardDashboard.stop();
    this.redisMonitor.stopMonitoring();
    await this.pool.end();

    logger.info('Monitoring system stopped successfully');
  }

  private async collectSystemMetrics(): Promise<void> {
    try {
      const timestamp = new Date();
      const [appMetricsArray, dbMetricsArray, redisStatsArray, shardMetrics] = await Promise.all([
        this.monitoringService.getApplicationMetrics(),
        this.monitoringService.getDatabaseMetrics(),
        this.redisMonitor.getStats(),
        this.shardMonitoringService.getAggregatedMetrics()
      ]);

      // Get the latest metrics from arrays
      const appMetrics = Array.isArray(appMetricsArray) ? appMetricsArray[appMetricsArray.length - 1] : appMetricsArray;
      const dbMetrics = Array.isArray(dbMetricsArray) ? dbMetricsArray[dbMetricsArray.length - 1] : dbMetricsArray;
      const redisStats = Array.isArray(redisStatsArray) ? redisStatsArray[redisStatsArray.length - 1] : redisStatsArray;

      const metrics: SystemMetrics = {
        timestamp,
        application: {
          cpuUsage: appMetrics.cpuUsage,
          memoryUsage: appMetrics.memoryUsage,
          activeRequests: appMetrics.activeRequests,
          errorRate: dbMetrics.slowQueries / dbMetrics.totalQueries * 100 || 0
        },
        database: {
          activeConnections: dbMetrics.activeConnections,
          idleConnections: dbMetrics.activeConnections - dbMetrics.waitingConnections,
          waitingConnections: dbMetrics.waitingConnections,
          maxConnections: dbMetrics.maxConnections,
          totalQueries: dbMetrics.totalQueries,
          slowQueries: dbMetrics.slowQueries,
          avgQueryTime: dbMetrics.avgQueryTime
        },
        cache: {
          hitRate: redisStats?.hitRate || 0,
          memoryUsage: redisStats?.memoryUsage || 0,
          evictionCount: redisStats?.evictionCount || 0,
          connectedClients: redisStats?.connectedClients || 0,
          totalCommands: redisStats?.totalCommands || 0,
          opsPerSecond: redisStats?.opsPerSecond || 0
        },
        shards: {
          totalShards: shardMetrics.totalActiveConnections || 0,
          avgLoadPercentage: shardMetrics.totalLoadPercentage || 0,
          avgResponseTime: shardMetrics.averageResponseTime || 0,
          errorRate: shardMetrics.averageErrorRate || 0
        }
      };

      this.metrics.push(metrics);
      this.emit('metrics', metrics);

      // Clean up old metrics
      await this.cleanupOldMetrics();
      
      // Check for alerts
      await this.checkAlerts(metrics);
    } catch (error) {
      logger.error('Failed to collect system metrics:', error);
    }
  }

  private cleanupOldMetrics(): void {
    const cutoffTime = new Date(Date.now() - this.config.retentionPeriod);
    this.metrics = this.metrics.filter(m => m.timestamp >= cutoffTime);
  }

  private async checkAlerts(metrics: SystemMetrics): Promise<void> {
    try {
      // Check CPU usage
      const cpuUsage = metrics.application.cpuUsage.user + metrics.application.cpuUsage.system;
      if (cpuUsage > this.config.alertThresholds.cpuUsage * 100) {
        this.emit('alert', {
          type: 'cpu',
          message: `High CPU usage: ${cpuUsage.toFixed(2)}%`,
          value: cpuUsage,
          threshold: this.config.alertThresholds.cpuUsage * 100
        });
      }

      // Check memory usage
      const memoryUsage = metrics.application.memoryUsage.heapUsed / metrics.application.memoryUsage.heapTotal * 100;
      if (memoryUsage > this.config.alertThresholds.memoryUsage * 100) {
        this.emit('alert', {
          type: 'memory',
          message: `High memory usage: ${memoryUsage.toFixed(2)}%`,
          value: memoryUsage,
          threshold: this.config.alertThresholds.memoryUsage * 100
        });
      }

      // Check shard load
      if (metrics.shards.avgLoadPercentage > this.config.alertThresholds.loadPercentage * 100) {
        this.emit('alert', {
          type: 'shardLoad',
          message: `High shard load: ${metrics.shards.avgLoadPercentage.toFixed(2)}%`,
          value: metrics.shards.avgLoadPercentage,
          threshold: this.config.alertThresholds.loadPercentage * 100
        });
      }

      // Check error rate
      if (metrics.shards.errorRate > this.config.alertThresholds.errorRate) {
        this.emit('alert', {
          type: 'errorRate',
          message: `High error rate: ${metrics.shards.errorRate.toFixed(2)}%`,
          value: metrics.shards.errorRate,
          threshold: this.config.alertThresholds.errorRate
        });
      }

      // Check response time
      if (metrics.shards.avgResponseTime > this.config.alertThresholds.responseTime) {
        this.emit('alert', {
          type: 'responseTime',
          message: `High response time: ${metrics.shards.avgResponseTime.toFixed(2)}ms`,
          value: metrics.shards.avgResponseTime,
          threshold: this.config.alertThresholds.responseTime
        });
      }
    } catch (error) {
      logger.error('Failed to check alerts:', error);
    }
  }

  public getMetrics(timeRange?: { start: Date; end: Date }): SystemMetrics[] {
    if (timeRange) {
      return this.metrics.filter(
        m => m.timestamp >= timeRange.start && m.timestamp <= timeRange.end
      );
    }
    return this.metrics;
  }

  public getLatestMetrics(): SystemMetrics | null {
    return this.metrics.length > 0 ? this.metrics[this.metrics.length - 1] : null;
  }
} 