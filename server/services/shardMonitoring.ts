import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { ShardingService } from './sharding';
import { DynamicShardingService } from './dynamicSharding';

export interface ShardMetrics {
  shardId: number;
  loadPercentage: number;
  rowCount: number;
  queryCount: number;
  lastRebalanced: Date;
  responseTime: number;
  errorRate: number;
  activeConnections: number;
  diskUsage: number;
  cpuUsage: number;
  memoryUsage: number;
}

export interface MonitoringConfig {
  updateInterval: number;
  retentionPeriod: number;
  alertThresholds: {
    loadPercentage: number;
    errorRate: number;
    responseTime: number;
    diskUsage: number;
    cpuUsage: number;
    memoryUsage: number;
  };
}

export class ShardMonitoringService {
  private metrics: Map<number, ShardMetrics[]> = new Map();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private config: MonitoringConfig;
  private shardingService: ShardingService;
  private dynamicShardingService: DynamicShardingService;

  constructor(
    config: MonitoringConfig,
    shardingService: ShardingService,
    dynamicShardingService: DynamicShardingService
  ) {
    this.config = config;
    this.shardingService = shardingService;
    this.dynamicShardingService = dynamicShardingService;
  }

  /**
   * Start monitoring shards
   */
  async startMonitoring(): Promise<void> {
    logger.info('Starting shard monitoring service');
    
    this.monitoringInterval = setInterval(async () => {
      await this.collectMetrics();
      await this.cleanupOldMetrics();
      await this.checkAlerts();
    }, this.config.updateInterval);
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  /**
   * Get metrics for a specific shard
   */
  getShardMetrics(shardId: number, timeRange?: { start: Date; end: Date }): ShardMetrics[] {
    const shardMetrics = this.metrics.get(shardId) || [];
    
    if (timeRange) {
      return shardMetrics.filter(metric => 
        metric.lastRebalanced >= timeRange.start && 
        metric.lastRebalanced <= timeRange.end
      );
    }
    
    return shardMetrics;
  }

  /**
   * Get aggregated metrics across all shards
   */
  getAggregatedMetrics(timeRange?: { start: Date; end: Date }): {
    totalLoadPercentage: number;
    totalRowCount: number;
    totalQueryCount: number;
    averageResponseTime: number;
    averageErrorRate: number;
    totalActiveConnections: number;
    averageDiskUsage: number;
    averageCpuUsage: number;
    averageMemoryUsage: number;
  } {
    const allMetrics = Array.from(this.metrics.values()).flat();
    const filteredMetrics = timeRange
      ? allMetrics.filter(metric => 
          metric.lastRebalanced >= timeRange.start && 
          metric.lastRebalanced <= timeRange.end
        )
      : allMetrics;
    
    if (filteredMetrics.length === 0) {
      return {
        totalLoadPercentage: 0,
        totalRowCount: 0,
        totalQueryCount: 0,
        averageResponseTime: 0,
        averageErrorRate: 0,
        totalActiveConnections: 0,
        averageDiskUsage: 0,
        averageCpuUsage: 0,
        averageMemoryUsage: 0
      };
    }
    
    return {
      totalLoadPercentage: filteredMetrics.reduce((sum, m) => sum + m.loadPercentage, 0) / filteredMetrics.length,
      totalRowCount: filteredMetrics.reduce((sum, m) => sum + m.rowCount, 0),
      totalQueryCount: filteredMetrics.reduce((sum, m) => sum + m.queryCount, 0),
      averageResponseTime: filteredMetrics.reduce((sum, m) => sum + m.responseTime, 0) / filteredMetrics.length,
      averageErrorRate: filteredMetrics.reduce((sum, m) => sum + m.errorRate, 0) / filteredMetrics.length,
      totalActiveConnections: filteredMetrics.reduce((sum, m) => sum + m.activeConnections, 0),
      averageDiskUsage: filteredMetrics.reduce((sum, m) => sum + m.diskUsage, 0) / filteredMetrics.length,
      averageCpuUsage: filteredMetrics.reduce((sum, m) => sum + m.cpuUsage, 0) / filteredMetrics.length,
      averageMemoryUsage: filteredMetrics.reduce((sum, m) => sum + m.memoryUsage, 0) / filteredMetrics.length
    };
  }

  /**
   * Collect metrics for all shards
   */
  private async collectMetrics(): Promise<void> {
    const shardIds = Array.from(this.metrics.keys());
    
    for (const shardId of shardIds) {
      try {
        const pool = await this.shardingService.getShardPool(shardId);
        const metrics = await this.collectShardMetrics(shardId, pool);
        
        const shardMetrics = this.metrics.get(shardId) || [];
        shardMetrics.push(metrics);
        this.metrics.set(shardId, shardMetrics);
        
        logger.debug(`Collected metrics for shard ${shardId}`, { metrics });
      } catch (error) {
        logger.error(`Failed to collect metrics for shard ${shardId}`, { error });
      }
    }
  }

  /**
   * Collect metrics for a specific shard
   */
  private async collectShardMetrics(shardId: number, pool: Pool): Promise<ShardMetrics> {
    const startTime = Date.now();
    
    try {
      // Get row count
      const rowCountResult = await pool.query(`
        SELECT COUNT(*) as count FROM (
          SELECT 'users' as table_name, COUNT(*) as count FROM users
          UNION ALL
          SELECT 'training_plans', COUNT(*) FROM training_plans
          UNION ALL
          SELECT 'workout_notes', COUNT(*) FROM workout_notes
        ) as counts
      `);
      
      // Get query statistics
      const queryStatsResult = await pool.query(`
        SELECT 
          sum(calls) as total_queries,
          sum(total_time) as total_time,
          sum(calls * (total_time / calls)) as avg_time,
          sum(calls * (total_time / calls) * (total_time / calls)) as variance
        FROM pg_stat_statements
      `);
      
      // Get connection count
      const connectionResult = await pool.query(`
        SELECT count(*) as active_connections
        FROM pg_stat_activity
        WHERE state = 'active'
      `);
      
      // Get system metrics
      const systemMetricsResult = await pool.query(`
        SELECT 
          pg_size_pretty(pg_database_size(current_database())) as disk_usage,
          pg_stat_get_db_xact_commit(oid) as cpu_usage,
          pg_stat_get_db_xact_rollback(oid) as memory_usage
        FROM pg_database
        WHERE datname = current_database()
      `);
      
      const responseTime = Date.now() - startTime;
      const rowCount = parseInt(rowCountResult.rows[0].count);
      const queryCount = parseInt(queryStatsResult.rows[0].total_queries);
      const avgResponseTime = parseFloat(queryStatsResult.rows[0].avg_time);
      const errorRate = parseFloat(queryStatsResult.rows[0].variance) / queryCount;
      const activeConnections = parseInt(connectionResult.rows[0].active_connections);
      const diskUsage = parseFloat(systemMetricsResult.rows[0].disk_usage);
      const cpuUsage = parseFloat(systemMetricsResult.rows[0].cpu_usage);
      const memoryUsage = parseFloat(systemMetricsResult.rows[0].memory_usage);
      
      return {
        shardId,
        loadPercentage: this.calculateLoadPercentage(rowCount, queryCount),
        rowCount,
        queryCount,
        lastRebalanced: new Date(),
        responseTime: avgResponseTime,
        errorRate,
        activeConnections,
        diskUsage,
        cpuUsage,
        memoryUsage
      };
    } catch (error) {
      logger.error(`Failed to collect detailed metrics for shard ${shardId}`, { error });
      throw error;
    }
  }

  /**
   * Calculate load percentage based on row count and query count
   */
  private calculateLoadPercentage(rowCount: number, queryCount: number): number {
    const maxRows = 1000000; // Example max rows per shard
    const maxQueries = 10000; // Example max queries per interval
    
    const rowLoad = rowCount / maxRows;
    const queryLoad = queryCount / maxQueries;
    
    return Math.max(rowLoad, queryLoad);
  }

  /**
   * Clean up old metrics
   */
  private async cleanupOldMetrics(): Promise<void> {
    const cutoffTime = new Date(Date.now() - this.config.retentionPeriod);
    
    for (const [shardId, metrics] of this.metrics) {
      const filteredMetrics = metrics.filter(m => m.lastRebalanced >= cutoffTime);
      this.metrics.set(shardId, filteredMetrics);
    }
  }

  /**
   * Check for alert conditions
   */
  private async checkAlerts(): Promise<void> {
    const aggregatedMetrics = this.getAggregatedMetrics();
    
    if (aggregatedMetrics.totalLoadPercentage > this.config.alertThresholds.loadPercentage) {
      logger.warn('High load percentage alert', {
        loadPercentage: aggregatedMetrics.totalLoadPercentage,
        threshold: this.config.alertThresholds.loadPercentage
      });
    }
    
    if (aggregatedMetrics.averageErrorRate > this.config.alertThresholds.errorRate) {
      logger.warn('High error rate alert', {
        errorRate: aggregatedMetrics.averageErrorRate,
        threshold: this.config.alertThresholds.errorRate
      });
    }
    
    if (aggregatedMetrics.averageResponseTime > this.config.alertThresholds.responseTime) {
      logger.warn('High response time alert', {
        responseTime: aggregatedMetrics.averageResponseTime,
        threshold: this.config.alertThresholds.responseTime
      });
    }
    
    if (aggregatedMetrics.averageDiskUsage > this.config.alertThresholds.diskUsage) {
      logger.warn('High disk usage alert', {
        diskUsage: aggregatedMetrics.averageDiskUsage,
        threshold: this.config.alertThresholds.diskUsage
      });
    }
    
    if (aggregatedMetrics.averageCpuUsage > this.config.alertThresholds.cpuUsage) {
      logger.warn('High CPU usage alert', {
        cpuUsage: aggregatedMetrics.averageCpuUsage,
        threshold: this.config.alertThresholds.cpuUsage
      });
    }
    
    if (aggregatedMetrics.averageMemoryUsage > this.config.alertThresholds.memoryUsage) {
      logger.warn('High memory usage alert', {
        memoryUsage: aggregatedMetrics.averageMemoryUsage,
        threshold: this.config.alertThresholds.memoryUsage
      });
    }
  }
} 