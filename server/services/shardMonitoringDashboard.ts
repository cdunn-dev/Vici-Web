import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { ShardingService } from './sharding';
import { ShardMonitoringService } from './shardMonitoring';

/**
 * Configuration for the shard monitoring dashboard
 */
export interface DashboardConfig {
  /**
   * Update interval in milliseconds
   */
  updateInterval: number;
  
  /**
   * Alert thresholds
   */
  alertThresholds: {
    /**
     * Load percentage threshold for alerts
     */
    loadPercentage: number;
    
    /**
     * Error rate threshold for alerts
     */
    errorRate: number;
    
    /**
     * Response time threshold for alerts (in ms)
     */
    responseTime: number;
  };
}

interface ShardMetrics {
  shardId: number;
  timestamp: Date;
  rowCount: number;
  queryCount: number;
  errorCount: number;
  avgResponseTime: number;
  activeConnections: number;
  loadPercentage: number;
}

interface DashboardData {
  shards: ShardMetrics[];
  summary: {
    totalShards: number;
    totalRows: number;
    totalQueries: number;
    totalErrors: number;
    avgResponseTime: number;
    avgLoadPercentage: number;
  };
  alerts: {
    highLoad: number[];
    highErrorRate: number[];
    highResponseTime: number[];
  };
}

/**
 * Service for the shard monitoring dashboard
 */
export class ShardMonitoringDashboard {
  private pool: Pool;
  private shardingService: ShardingService;
  private monitoringService: ShardMonitoringService;
  private config: DashboardConfig;
  private updateInterval: NodeJS.Timeout | null = null;
  
  /**
   * Creates a new ShardMonitoringDashboard
   * @param pool The database connection pool
   * @param shardingService The sharding service
   * @param monitoringService The shard monitoring service
   * @param config Dashboard configuration
   */
  constructor(
    pool: Pool,
    shardingService: ShardingService,
    monitoringService: ShardMonitoringService,
    config: DashboardConfig
  ) {
    this.pool = pool;
    this.shardingService = shardingService;
    this.monitoringService = monitoringService;
    this.config = config;
  }
  
  /**
   * Starts the dashboard
   * @returns Promise that resolves when the dashboard is started
   */
  public async start(): Promise<void> {
    try {
      logger.info('Starting shard monitoring dashboard');
      
      // Initial metrics collection
      await this.collectMetrics();
      
      // Set up periodic updates
      this.updateInterval = setInterval(
        () => this.collectMetrics(),
        this.config.updateInterval
      );
    } catch (error) {
      logger.error('Failed to start monitoring dashboard:', error);
      throw error;
    }
  }
  
  /**
   * Stops the dashboard
   * @returns Promise that resolves when the dashboard is stopped
   */
  public async stop(): Promise<void> {
    logger.info('Stopping shard monitoring dashboard');
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    logger.info('Shard monitoring dashboard stopped');
  }
  
  /**
   * Collects metrics for all shards
   * @returns Promise that resolves when metrics are collected
   */
  private async collectMetrics(): Promise<void> {
    logger.info('Collecting shard metrics');
    
    try {
      const shardCount = await this.shardingService.getShardCount();
      
      for (let shardId = 0; shardId < shardCount; shardId++) {
        const metrics = await this.collectShardMetrics(shardId);
        await this.monitoringService.storeMetrics(metrics);
      }
      
      await this.checkAlerts();
      
      logger.info('Shard metrics collected successfully');
    } catch (error) {
      logger.error('Failed to collect shard metrics', { error });
    }
  }
  
  /**
   * Collects metrics for a specific shard
   * @param shardId Shard ID
   * @returns Promise that resolves with the collected metrics
   */
  private async collectShardMetrics(shardId: number): Promise<ShardMetrics> {
    try {
      // Get row count
      const rowCountResult = await this.pool.query(
        'SELECT COUNT(*) as count FROM shard_data WHERE shard_id = $1',
        [shardId]
      );
      const rowCount = parseInt(rowCountResult.rows[0].count);

      // Get query statistics
      const statsResult = await this.pool.query(
        `SELECT 
         COUNT(*) as query_count,
         COUNT(*) FILTER (WHERE error) as error_count,
         AVG(response_time) as avg_response_time
         FROM query_stats 
         WHERE shard_id = $1 
         AND timestamp >= NOW() - INTERVAL '5 minutes'`,
        [shardId]
      );

      // Get active connections
      const connectionsResult = await this.pool.query(
        'SELECT COUNT(*) as count FROM pg_stat_activity WHERE datname = $1',
        [`shard_${shardId}`]
      );
      const activeConnections = parseInt(connectionsResult.rows[0].count);

      // Calculate load percentage (assuming max 1M rows per shard)
      const loadPercentage = (rowCount / 1000000) * 100;

      return {
        shardId,
        timestamp: new Date(),
        rowCount,
        queryCount: parseInt(statsResult.rows[0].query_count) || 0,
        errorCount: parseInt(statsResult.rows[0].error_count) || 0,
        avgResponseTime: parseFloat(statsResult.rows[0].avg_response_time) || 0,
        activeConnections,
        loadPercentage
      };
    } catch (error) {
      logger.error(`Failed to collect metrics for shard ${shardId}:`, error);
      throw error;
    }
  }
  
  /**
   * Checks for alerts based on metrics
   * @returns Promise that resolves when alerts are checked
   */
  private async checkAlerts(): Promise<void> {
    try {
      const metrics = await this.monitoringService.getLatestMetrics();
      
      for (const metric of metrics) {
        if (metric.loadPercentage > this.config.alertThresholds.loadPercentage) {
          logger.warn(`High load alert for shard ${metric.shardId}: ${metric.loadPercentage.toFixed(2)}%`);
        }
        
        const errorRate = metric.queryCount > 0 ? (metric.errorCount / metric.queryCount) * 100 : 0;
        if (errorRate > this.config.alertThresholds.errorRate) {
          logger.warn(`High error rate alert for shard ${metric.shardId}: ${errorRate.toFixed(2)}%`);
        }
        
        if (metric.avgResponseTime > this.config.alertThresholds.responseTime) {
          logger.warn(`High response time alert for shard ${metric.shardId}: ${metric.avgResponseTime.toFixed(2)}ms`);
        }
      }
    } catch (error) {
      logger.error('Failed to check alerts', { error });
    }
  }
  
  /**
   * Gets the dashboard data
   * @returns Promise that resolves with the dashboard data
   */
  public async getDashboardData(): Promise<DashboardData> {
    try {
      const metrics = await this.monitoringService.getLatestMetrics();
      
      // Calculate summary statistics
      const summary = {
        totalShards: metrics.length,
        totalRows: metrics.reduce((sum, m) => sum + m.rowCount, 0),
        totalQueries: metrics.reduce((sum, m) => sum + m.queryCount, 0),
        totalErrors: metrics.reduce((sum, m) => sum + m.errorCount, 0),
        avgResponseTime: metrics.reduce((sum, m) => sum + m.avgResponseTime, 0) / metrics.length,
        avgLoadPercentage: metrics.reduce((sum, m) => sum + m.loadPercentage, 0) / metrics.length
      };

      // Identify shards with alerts
      const alerts = {
        highLoad: metrics
          .filter(m => m.loadPercentage > this.config.alertThresholds.loadPercentage)
          .map(m => m.shardId),
        highErrorRate: metrics
          .filter(m => (m.errorCount / m.queryCount) * 100 > this.config.alertThresholds.errorRate)
          .map(m => m.shardId),
        highResponseTime: metrics
          .filter(m => m.avgResponseTime > this.config.alertThresholds.responseTime)
          .map(m => m.shardId)
      };

      return {
        shards: metrics,
        summary,
        alerts
      };
    } catch (error) {
      logger.error('Failed to get dashboard data', { error });
      throw error;
    }
  }
} 