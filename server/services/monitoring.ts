import { db } from '../db';
import { logger } from '../utils/logger';
import { performance } from 'perf_hooks';
import { Pool } from 'pg';
import { RedisService } from './redis';

// Define interfaces for monitoring data
export interface QueryMetrics {
  query: string;
  params: any[];
  duration: number;
  timestamp: Date;
  rowsAffected?: number;
  error?: string;
}

export interface DatabaseMetrics {
  activeConnections: number;
  idleConnections: number;
  waitingConnections: number;
  maxConnections: number;
  totalQueries: number;
  slowQueries: number;
  avgQueryTime: number;
  timestamp: Date;
}

export interface ApplicationMetrics {
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  cpuUsage: {
    user: number;
    system: number;
  };
  activeRequests: number;
  timestamp: Date;
}

export interface PerformanceAlert {
  type: 'query' | 'database' | 'application';
  severity: 'warning' | 'error' | 'critical';
  message: string;
  details: any;
  timestamp: Date;
}

export class MonitoringService {
  private static instance: MonitoringService;
  private queryMetrics: QueryMetrics[] = [];
  private databaseMetrics: DatabaseMetrics[] = [];
  private applicationMetrics: ApplicationMetrics[] = [];
  private performanceAlerts: PerformanceAlert[] = [];
  private slowQueryThreshold: number = 1000; // 1 second in milliseconds
  private maxMetricsHistory: number = 1000; // Keep last 1000 metrics
  private redisService: RedisService;
  private pool: Pool;

  private constructor() {
    this.redisService = RedisService.getInstance();
    this.pool = db.pool;
    this.startMonitoring();
  }

  public static getInstance(): MonitoringService {
    if (!MonitoringService.instance) {
      MonitoringService.instance = new MonitoringService();
    }
    return MonitoringService.instance;
  }

  private startMonitoring(): void {
    // Monitor database metrics every minute
    setInterval(() => this.collectDatabaseMetrics(), 60000);
    
    // Monitor application metrics every 5 minutes
    setInterval(() => this.collectApplicationMetrics(), 300000);
    
    // Clean up old metrics every hour
    setInterval(() => this.cleanupOldMetrics(), 3600000);
    
    // Log performance alerts every 5 minutes
    setInterval(() => this.checkPerformanceAlerts(), 300000);
  }

  public trackQuery(query: string, params: any[], startTime: number): void {
    const duration = performance.now() - startTime;
    const timestamp = new Date();
    
    const metric: QueryMetrics = {
      query,
      params,
      duration,
      timestamp
    };
    
    this.queryMetrics.push(metric);
    
    // Check if this is a slow query
    if (duration > this.slowQueryThreshold) {
      this.addPerformanceAlert({
        type: 'query',
        severity: 'warning',
        message: `Slow query detected: ${duration.toFixed(2)}ms`,
        details: { query, params, duration },
        timestamp
      });
      
      logger.warn(`Slow query detected: ${duration.toFixed(2)}ms`, {
        query,
        params,
        duration
      });
    }
  }

  private async collectDatabaseMetrics(): Promise<void> {
    try {
      const client = await this.pool.connect();
      
      try {
        // Get connection pool stats
        const poolStats = this.pool.totalCount;
        const idleCount = this.pool.idleCount;
        const waitingCount = this.pool.waitingCount;
        
        // Get database stats
        const dbStats = await client.query(`
          SELECT 
            sum(xact_commit + xact_rollback) as total_transactions,
            sum(blks_read) as blocks_read,
            sum(blks_hit) as blocks_hit,
            sum(tup_returned) as rows_returned,
            sum(tup_fetched) as rows_fetched,
            sum(tup_inserted) as rows_inserted,
            sum(tup_updated) as rows_updated,
            sum(tup_deleted) as rows_deleted
          FROM pg_stat_database
          WHERE datname = current_database()
        `);
        
        // Calculate metrics
        const totalQueries = this.queryMetrics.length;
        const slowQueries = this.queryMetrics.filter(m => m.duration > this.slowQueryThreshold).length;
        const avgQueryTime = totalQueries > 0 
          ? this.queryMetrics.reduce((sum, m) => sum + m.duration, 0) / totalQueries 
          : 0;
        
        const metrics: DatabaseMetrics = {
          activeConnections: poolStats - idleCount,
          idleConnections: idleCount,
          waitingConnections: waitingCount,
          maxConnections: this.pool.options.max,
          totalQueries,
          slowQueries,
          avgQueryTime,
          timestamp: new Date()
        };
        
        this.databaseMetrics.push(metrics);
        
        // Store in Redis for real-time monitoring
        await this.redisService.set('db:metrics', JSON.stringify(metrics), 300); // 5 minutes TTL
        
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error collecting database metrics', { error });
    }
  }

  private collectApplicationMetrics(): void {
    try {
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      
      const metrics: ApplicationMetrics = {
        memoryUsage: {
          heapUsed: memoryUsage.heapUsed,
          heapTotal: memoryUsage.heapTotal,
          external: memoryUsage.external,
          rss: memoryUsage.rss
        },
        cpuUsage: {
          user: cpuUsage.user,
          system: cpuUsage.system
        },
        activeRequests: this.getActiveRequestCount(),
        timestamp: new Date()
      };
      
      this.applicationMetrics.push(metrics);
      
      // Store in Redis for real-time monitoring
      this.redisService.set('app:metrics', JSON.stringify(metrics), 300); // 5 minutes TTL
      
      // Check for memory leaks
      if (memoryUsage.heapUsed > memoryUsage.heapTotal * 0.9) {
        this.addPerformanceAlert({
          type: 'application',
          severity: 'warning',
          message: 'High memory usage detected',
          details: { memoryUsage },
          timestamp: new Date()
        });
      }
    } catch (error) {
      logger.error('Error collecting application metrics', { error });
    }
  }

  private getActiveRequestCount(): number {
    // This is a placeholder - in a real implementation, you would track active requests
    return 0;
  }

  private cleanupOldMetrics(): void {
    // Keep only the last maxMetricsHistory metrics
    if (this.queryMetrics.length > this.maxMetricsHistory) {
      this.queryMetrics = this.queryMetrics.slice(-this.maxMetricsHistory);
    }
    
    if (this.databaseMetrics.length > this.maxMetricsHistory) {
      this.databaseMetrics = this.databaseMetrics.slice(-this.maxMetricsHistory);
    }
    
    if (this.applicationMetrics.length > this.maxMetricsHistory) {
      this.applicationMetrics = this.applicationMetrics.slice(-this.maxMetricsHistory);
    }
    
    if (this.performanceAlerts.length > this.maxMetricsHistory) {
      this.performanceAlerts = this.performanceAlerts.slice(-this.maxMetricsHistory);
    }
  }

  private checkPerformanceAlerts(): void {
    // Check for database connection issues
    if (this.databaseMetrics.length > 0) {
      const latestDbMetrics = this.databaseMetrics[this.databaseMetrics.length - 1];
      
      if (latestDbMetrics.waitingConnections > 5) {
        this.addPerformanceAlert({
          type: 'database',
          severity: 'warning',
          message: 'High number of waiting database connections',
          details: { waitingConnections: latestDbMetrics.waitingConnections },
          timestamp: new Date()
        });
      }
      
      if (latestDbMetrics.avgQueryTime > 500) {
        this.addPerformanceAlert({
          type: 'database',
          severity: 'warning',
          message: 'High average query time',
          details: { avgQueryTime: latestDbMetrics.avgQueryTime },
          timestamp: new Date()
        });
      }
    }
    
    // Check for application performance issues
    if (this.applicationMetrics.length > 0) {
      const latestAppMetrics = this.applicationMetrics[this.applicationMetrics.length - 1];
      
      if (latestAppMetrics.memoryUsage.heapUsed > latestAppMetrics.memoryUsage.heapTotal * 0.8) {
        this.addPerformanceAlert({
          type: 'application',
          severity: 'warning',
          message: 'High memory usage',
          details: { memoryUsage: latestAppMetrics.memoryUsage },
          timestamp: new Date()
        });
      }
    }
    
    // Log alerts to the logger
    this.performanceAlerts.forEach(alert => {
      if (alert.severity === 'critical') {
        logger.error(alert.message, alert.details);
      } else if (alert.severity === 'error') {
        logger.error(alert.message, alert.details);
      } else {
        logger.warn(alert.message, alert.details);
      }
    });
  }

  private addPerformanceAlert(alert: PerformanceAlert): void {
    this.performanceAlerts.push(alert);
  }

  public getQueryMetrics(): QueryMetrics[] {
    return [...this.queryMetrics];
  }

  public getDatabaseMetrics(): DatabaseMetrics[] {
    return [...this.databaseMetrics];
  }

  public getApplicationMetrics(): ApplicationMetrics[] {
    return [...this.applicationMetrics];
  }

  public getPerformanceAlerts(): PerformanceAlert[] {
    return [...this.performanceAlerts];
  }

  public setSlowQueryThreshold(threshold: number): void {
    this.slowQueryThreshold = threshold;
  }

  public getSlowQueryThreshold(): number {
    return this.slowQueryThreshold;
  }
} 