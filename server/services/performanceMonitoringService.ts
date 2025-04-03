import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { MonitoringService } from './monitoring';
import { RedisService } from './redis';
import { logger } from '../utils/logger';
import { ErrorHandlingService } from './errorHandlingService';
import { AuditLoggingService } from './auditLoggingService';
import { Pool } from 'pg';

export interface PerformanceMetrics {
  timestamp: Date;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  requestSize: number;
  responseSize: number;
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
  activeConnections: number;
  databaseQueries: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface PerformanceAlert {
  id: string;
  type: 'endpoint' | 'database' | 'cache' | 'memory' | 'cpu';
  severity: 'warning' | 'error' | 'critical';
  message: string;
  details: any;
  timestamp: Date;
  acknowledged: boolean;
  resolved: boolean;
  resolvedAt?: Date;
}

export interface PerformanceMonitoringConfig {
  updateInterval: number;
  retentionPeriod: number;
  alertThresholds: {
    responseTime: number;
    errorRate: number;
    memoryUsage: number;
    cpuUsage: number;
    cacheHitRate: number;
    databaseQueryTime: number;
  };
  notificationChannels: {
    email: boolean;
    slack: boolean;
    webhook: boolean;
  };
}

export class PerformanceMonitoringService extends EventEmitter {
  private static instance: PerformanceMonitoringService;
  private config: PerformanceMonitoringConfig;
  private monitoringService: MonitoringService;
  private redisService: RedisService;
  private errorHandlingService: ErrorHandlingService;
  private auditLoggingService: AuditLoggingService;
  private metrics: PerformanceMetrics[] = [];
  private alerts: PerformanceAlert[] = [];
  private monitoringInterval: NodeJS.Timeout | null = null;
  private endpointMetrics: Map<string, PerformanceMetrics[]> = new Map();
  private alertCooldown: Map<string, Date> = new Map();
  private cooldownPeriod: number = 300000; // 5 minutes in milliseconds
  private pool: Pool;

  private constructor(config: PerformanceMonitoringConfig) {
    super();
    this.config = config;
    this.pool = new Pool({
      // Add your PostgreSQL connection config here
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432'),
      database: process.env.POSTGRES_DB || 'vici',
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres'
    });
    this.monitoringService = MonitoringService.getInstance();
    this.redisService = RedisService.getInstance();
    this.errorHandlingService = ErrorHandlingService.getInstance();
    this.auditLoggingService = new AuditLoggingService(this.pool, {
      enabled: true,
      logPerformanceMetrics: true,
      enableAlerts: true
    });
  }

  public static getInstance(config?: PerformanceMonitoringConfig): PerformanceMonitoringService {
    if (!PerformanceMonitoringService.instance) {
      if (!config) {
        throw new Error('Configuration required for first initialization');
      }
      PerformanceMonitoringService.instance = new PerformanceMonitoringService(config);
    }
    return PerformanceMonitoringService.instance;
  }

  public async start(): Promise<void> {
    logger.info('Starting performance monitoring service');

    try {
      // Initialize audit logging service
      await this.auditLoggingService.initialize();

      // Start performance monitoring
      this.monitoringInterval = setInterval(
        () => this.collectPerformanceMetrics(),
        this.config.updateInterval
      );

      // Initial metrics collection
      await this.collectPerformanceMetrics();

      logger.info('Performance monitoring service started successfully');
    } catch (error) {
      logger.error('Failed to start performance monitoring service', { error });
      throw error;
    }
  }

  public async stop(): Promise<void> {
    logger.info('Stopping performance monitoring service');

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    // Close the database pool
    await this.pool.end();

    logger.info('Performance monitoring service stopped successfully');
  }

  public trackEndpointPerformance(
    endpoint: string,
    method: string,
    statusCode: number,
    startTime: number,
    requestSize: number,
    responseSize: number
  ): void {
    const responseTime = performance.now() - startTime;
    const timestamp = new Date();
    
    // Get current application metrics
    const appMetrics = this.monitoringService.getApplicationMetrics();
    const latestAppMetrics = appMetrics.length > 0 ? appMetrics[appMetrics.length - 1] : null;
    
    // Get current database metrics
    const dbMetrics = this.monitoringService.getDatabaseMetrics();
    const latestDbMetrics = dbMetrics.length > 0 ? dbMetrics[dbMetrics.length - 1] : null;
    
    // Create performance metric
    const metric: PerformanceMetrics = {
      timestamp,
      endpoint,
      method,
      statusCode,
      responseTime,
      requestSize,
      responseSize,
      memoryUsage: latestAppMetrics?.memoryUsage || {
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        rss: 0
      },
      cpuUsage: latestAppMetrics?.cpuUsage || {
        user: 0,
        system: 0
      },
      activeConnections: latestDbMetrics?.activeConnections || 0,
      databaseQueries: latestDbMetrics?.totalQueries || 0,
      cacheHits: 0, // This would be populated from Redis metrics
      cacheMisses: 0 // This would be populated from Redis metrics
    };
    
    // Store metric
    this.metrics.push(metric);
    
    // Store endpoint-specific metrics
    if (!this.endpointMetrics.has(endpoint)) {
      this.endpointMetrics.set(endpoint, []);
    }
    this.endpointMetrics.get(endpoint)?.push(metric);
    
    // Check for performance issues
    this.checkPerformanceAlerts(metric);
    
    // Store in Redis for real-time monitoring
    this.redisService.set(`perf:endpoint:${endpoint}`, JSON.stringify(metric), 300); // 5 minutes TTL
  }

  private async collectPerformanceMetrics(): Promise<void> {
    try {
      // This method would collect system-wide performance metrics
      // For now, we'll just clean up old metrics
      this.cleanupOldMetrics();
    } catch (error) {
      logger.error('Error collecting performance metrics', { error });
    }
  }

  private cleanupOldMetrics(): void {
    const now = new Date();
    const retentionPeriodMs = this.config.retentionPeriod * 24 * 60 * 60 * 1000; // Convert days to milliseconds
    
    // Clean up main metrics array
    this.metrics = this.metrics.filter(metric => 
      now.getTime() - metric.timestamp.getTime() < retentionPeriodMs
    );
    
    // Clean up endpoint-specific metrics
    for (const [endpoint, metrics] of this.endpointMetrics.entries()) {
      this.endpointMetrics.set(
        endpoint,
        metrics.filter(metric => now.getTime() - metric.timestamp.getTime() < retentionPeriodMs)
      );
    }
    
    // Clean up old alerts
    this.alerts = this.alerts.filter(alert => 
      now.getTime() - alert.timestamp.getTime() < retentionPeriodMs
    );
  }

  private checkPerformanceAlerts(metric: PerformanceMetrics): void {
    // Check response time
    if (metric.responseTime > this.config.alertThresholds.responseTime) {
      this.createAlert({
        type: 'endpoint',
        severity: metric.responseTime > this.config.alertThresholds.responseTime * 2 ? 'critical' : 'warning',
        message: `Slow response time for ${metric.method} ${metric.endpoint}: ${metric.responseTime.toFixed(2)}ms`,
        details: { metric }
      });
    }
    
    // Check error rate
    if (metric.statusCode >= 500) {
      this.createAlert({
        type: 'endpoint',
        severity: 'error',
        message: `Error response for ${metric.method} ${metric.endpoint}: ${metric.statusCode}`,
        details: { metric }
      });
    }
    
    // Check memory usage
    const memoryUsagePercentage = metric.memoryUsage.heapUsed / metric.memoryUsage.heapTotal;
    if (memoryUsagePercentage > this.config.alertThresholds.memoryUsage) {
      this.createAlert({
        type: 'memory',
        severity: memoryUsagePercentage > 0.9 ? 'critical' : 'warning',
        message: `High memory usage: ${(memoryUsagePercentage * 100).toFixed(2)}%`,
        details: { metric }
      });
    }
    
    // Check CPU usage
    const totalCpuUsage = metric.cpuUsage.user + metric.cpuUsage.system;
    if (totalCpuUsage > this.config.alertThresholds.cpuUsage) {
      this.createAlert({
        type: 'cpu',
        severity: totalCpuUsage > this.config.alertThresholds.cpuUsage * 2 ? 'critical' : 'warning',
        message: `High CPU usage: ${totalCpuUsage.toFixed(2)}`,
        details: { metric }
      });
    }
  }

  private createAlert(alert: Omit<PerformanceAlert, 'id' | 'timestamp' | 'acknowledged' | 'resolved'>): void {
    // Check cooldown period
    const alertKey = `${alert.type}:${alert.message}`;
    const lastAlertTime = this.alertCooldown.get(alertKey);
    const now = new Date();
    
    if (lastAlertTime && now.getTime() - lastAlertTime.getTime() < this.cooldownPeriod) {
      // Skip alert due to cooldown
      return;
    }
    
    // Create new alert
    const newAlert: PerformanceAlert = {
      id: `perf-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      timestamp: now,
      acknowledged: false,
      resolved: false,
      ...alert
    };
    
    // Add to alerts array
    this.alerts.push(newAlert);
    
    // Update cooldown
    this.alertCooldown.set(alertKey, now);
    
    // Store in Redis
    this.redisService.set(`perf:alert:${newAlert.id}`, JSON.stringify(newAlert), 86400); // 24 hours TTL
    
    // Emit event
    this.emit('performanceAlert', newAlert);
    
    // Log alert
    logger.warn(`Performance alert: ${newAlert.message}`, { alert: newAlert });
    
    // Send notifications
    this.sendAlertNotifications(newAlert);
  }

  private async sendAlertNotifications(alert: PerformanceAlert): Promise<void> {
    try {
      // Log to audit service
      await this.auditLoggingService.logEvent(
        'system', // userId
        'PERFORMANCE_ALERT',
        alert.type,
        {
          alertId: alert.id,
          message: alert.message,
          severity: alert.severity,
          details: alert.details
        }
      );
      
      // Send to error handling service
      const error = new Error(alert.message);
      (error as any).details = alert.details; // Type assertion to add details
      await this.errorHandlingService.handleError(error);
      
      // In a real implementation, you would send notifications via email, Slack, etc.
      // based on the config.notificationChannels settings
    } catch (error) {
      logger.error('Error sending alert notifications', { error, alert });
    }
  }

  public acknowledgeAlert(alertId: string): void {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      
      // Update in Redis
      this.redisService.set(`perf:alert:${alertId}`, JSON.stringify(alert), 86400);
      
      // Emit event
      this.emit('alertAcknowledged', alert);
      
      // Log acknowledgment
      logger.info(`Performance alert acknowledged: ${alert.message}`, { alertId });
    }
  }

  public resolveAlert(alertId: string): void {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      alert.resolvedAt = new Date();
      
      // Update in Redis
      this.redisService.set(`perf:alert:${alertId}`, JSON.stringify(alert), 86400);
      
      // Emit event
      this.emit('alertResolved', alert);
      
      // Log resolution
      logger.info(`Performance alert resolved: ${alert.message}`, { alertId });
    }
  }

  public getMetrics(timeRange?: { start: Date; end: Date }): PerformanceMetrics[] {
    if (timeRange) {
      return this.metrics.filter(metric => 
        metric.timestamp >= timeRange.start && metric.timestamp <= timeRange.end
      );
    }
    return this.metrics;
  }

  public getEndpointMetrics(endpoint: string, timeRange?: { start: Date; end: Date }): PerformanceMetrics[] {
    const metrics = this.endpointMetrics.get(endpoint) || [];
    
    if (timeRange) {
      return metrics.filter(metric => 
        metric.timestamp >= timeRange.start && metric.timestamp <= timeRange.end
      );
    }
    return metrics;
  }

  public getAlerts(includeResolved: boolean = false): PerformanceAlert[] {
    if (includeResolved) {
      return this.alerts;
    }
    return this.alerts.filter(alert => !alert.resolved);
  }

  public getAlertById(alertId: string): PerformanceAlert | undefined {
    return this.alerts.find(alert => alert.id === alertId);
  }

  public setCooldownPeriod(period: number): void {
    this.cooldownPeriod = period;
  }

  public getCooldownPeriod(): number {
    return this.cooldownPeriod;
  }
} 