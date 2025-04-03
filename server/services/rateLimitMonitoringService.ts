import { EventEmitter } from 'events';
import { RedisService } from './redis';
import { logger } from '../utils/logger';
import { ErrorHandlingService, ErrorCategory, ErrorSeverity } from './errorHandlingService';

export interface RateLimitMetrics {
  timestamp: Date;
  totalRequests: number;
  rateLimitedRequests: number;
  rateLimitHits: number;
  rateLimitMisses: number;
  averageLatency: number;
  byTier: {
    [tier: string]: {
      requests: number;
      rateLimited: number;
      hits: number;
      misses: number;
      averageLatency: number;
    };
  };
  byIdentifier: {
    [identifier: string]: {
      requests: number;
      rateLimited: number;
      hits: number;
      misses: number;
      averageLatency: number;
    };
  };
}

export interface RateLimitAlert {
  timestamp: Date;
  type: 'HIGH_RATE_LIMIT_HITS' | 'HIGH_LATENCY' | 'UNUSUAL_PATTERN';
  message: string;
  details: Record<string, any>;
}

export interface RateLimitMonitoringConfig {
  // Threshold for rate limit hits percentage to trigger an alert
  rateLimitHitThreshold: number;
  // Threshold for average latency to trigger an alert (in milliseconds)
  latencyThreshold: number;
  // Window size for pattern detection (in minutes)
  patternDetectionWindow: number;
  // Maximum number of metrics to keep in memory
  maxMetricsHistory: number;
}

const DEFAULT_CONFIG: RateLimitMonitoringConfig = {
  rateLimitHitThreshold: 0.1, // 10% rate limit hits threshold
  latencyThreshold: 1000, // 1 second latency threshold
  patternDetectionWindow: 60, // 1 hour window
  maxMetricsHistory: 1000 // Keep last 1000 metrics
};

export class RateLimitMonitoringService extends EventEmitter {
  private static instance: RateLimitMonitoringService;
  private redis: RedisService;
  private errorHandlingService: ErrorHandlingService;
  private config: RateLimitMonitoringConfig;
  private metrics: RateLimitMetrics[] = [];
  private alerts: RateLimitAlert[] = [];
  private readonly METRICS_KEY_PREFIX = 'ratelimit:metrics:';
  private readonly DAILY_METRICS_KEY_PREFIX = 'ratelimit:metrics:daily:';

  private constructor(
    errorHandlingService: ErrorHandlingService,
    config: Partial<RateLimitMonitoringConfig> = {}
  ) {
    super();
    this.redis = RedisService.getInstance();
    this.errorHandlingService = errorHandlingService;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startMonitoring();
  }

  public static getInstance(
    errorHandlingService: ErrorHandlingService,
    config?: Partial<RateLimitMonitoringConfig>
  ): RateLimitMonitoringService {
    if (!RateLimitMonitoringService.instance) {
      RateLimitMonitoringService.instance = new RateLimitMonitoringService(errorHandlingService, config);
    }
    return RateLimitMonitoringService.instance;
  }

  private startMonitoring(): void {
    // Collect metrics every minute
    setInterval(() => this.collectMetrics(), 60000);
  }

  public async trackRequest(
    identifier: string,
    tier: string,
    rateLimited: boolean,
    latency: number
  ): Promise<void> {
    try {
      const date = new Date().toISOString().split('T')[0];
      const timestamp = new Date();

      // Track total requests
      await this.redis.incr(`${this.METRICS_KEY_PREFIX}requests:total`);
      await this.redis.incr(`${this.METRICS_KEY_PREFIX}requests:tier:${tier}`);
      await this.redis.incr(`${this.METRICS_KEY_PREFIX}requests:identifier:${identifier}`);

      // Track rate limited requests
      if (rateLimited) {
        await this.redis.incr(`${this.METRICS_KEY_PREFIX}rate_limited:total`);
        await this.redis.incr(`${this.METRICS_KEY_PREFIX}rate_limited:tier:${tier}`);
        await this.redis.incr(`${this.METRICS_KEY_PREFIX}rate_limited:identifier:${identifier}`);
      }

      // Track latency
      await this.redis.lpush(`${this.METRICS_KEY_PREFIX}latency:${tier}`, latency.toString());
      await this.redis.ltrim(`${this.METRICS_KEY_PREFIX}latency:${tier}`, 0, 999); // Keep last 1000 latencies

      // Track daily metrics
      await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:requests:total`);
      await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:requests:tier:${tier}`);
      if (rateLimited) {
        await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:rate_limited:total`);
        await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:rate_limited:tier:${tier}`);
      }

      // Check for alerts
      await this.checkAlerts(identifier, tier, rateLimited, latency);
    } catch (error) {
      logger.error('Error tracking rate limit request:', error);
      await this.errorHandlingService.handleError(error instanceof Error ? error : new Error(String(error)), {
        category: ErrorCategory.SYSTEM,
        severity: ErrorSeverity.HIGH,
        source: 'RateLimitMonitoringService'
      });
    }
  }

  private async collectMetrics(): Promise<void> {
    try {
      const timestamp = new Date();
      const metrics: RateLimitMetrics = {
        timestamp,
        totalRequests: parseInt(await this.redis.get(`${this.METRICS_KEY_PREFIX}requests:total`) || '0'),
        rateLimitedRequests: parseInt(await this.redis.get(`${this.METRICS_KEY_PREFIX}rate_limited:total`) || '0'),
        rateLimitHits: 0,
        rateLimitMisses: 0,
        averageLatency: 0,
        byTier: {},
        byIdentifier: {}
      };

      // Calculate rate limit hits and misses
      metrics.rateLimitHits = metrics.rateLimitedRequests;
      metrics.rateLimitMisses = metrics.totalRequests - metrics.rateLimitedRequests;

      // Calculate average latency
      const latencies = await this.redis.lrange(`${this.METRICS_KEY_PREFIX}latency:total`, 0, -1);
      if (latencies.length > 0) {
        metrics.averageLatency = latencies.reduce((sum, lat) => sum + parseFloat(lat), 0) / latencies.length;
      }

      // Add metrics to history
      this.metrics.push(metrics);
      if (this.metrics.length > this.config.maxMetricsHistory) {
        this.metrics = this.metrics.slice(-this.config.maxMetricsHistory);
      }

      // Emit metrics event
      this.emit('metrics', metrics);
    } catch (error) {
      logger.error('Error collecting rate limit metrics:', error);
      await this.errorHandlingService.handleError(error instanceof Error ? error : new Error(String(error)), {
        category: ErrorCategory.SYSTEM,
        severity: ErrorSeverity.HIGH,
        source: 'RateLimitMonitoringService'
      });
    }
  }

  private async checkAlerts(
    identifier: string,
    tier: string,
    rateLimited: boolean,
    latency: number
  ): Promise<void> {
    try {
      // Check rate limit hit percentage
      const totalRequests = parseInt(await this.redis.get(`${this.METRICS_KEY_PREFIX}requests:total`) || '0');
      const rateLimitedRequests = parseInt(await this.redis.get(`${this.METRICS_KEY_PREFIX}rate_limited:total`) || '0');
      const hitPercentage = totalRequests > 0 ? rateLimitedRequests / totalRequests : 0;

      if (hitPercentage > this.config.rateLimitHitThreshold) {
        const alert: RateLimitAlert = {
          timestamp: new Date(),
          type: 'HIGH_RATE_LIMIT_HITS',
          message: `High rate limit hit percentage: ${(hitPercentage * 100).toFixed(2)}%`,
          details: {
            hitPercentage,
            threshold: this.config.rateLimitHitThreshold,
            identifier,
            tier
          }
        };
        this.alerts.push(alert);
        this.emit('alert', alert);
      }

      // Check latency
      if (latency > this.config.latencyThreshold) {
        const alert: RateLimitAlert = {
          timestamp: new Date(),
          type: 'HIGH_LATENCY',
          message: `High latency detected: ${latency}ms`,
          details: {
            latency,
            threshold: this.config.latencyThreshold,
            identifier,
            tier
          }
        };
        this.alerts.push(alert);
        this.emit('alert', alert);
      }

      // Check for unusual patterns
      await this.checkUnusualPatterns(identifier, tier);
    } catch (error) {
      logger.error('Error checking rate limit alerts:', error);
      await this.errorHandlingService.handleError(error instanceof Error ? error : new Error(String(error)), {
        category: ErrorCategory.SYSTEM,
        severity: ErrorSeverity.HIGH,
        source: 'RateLimitMonitoringService'
      });
    }
  }

  private async checkUnusualPatterns(identifier: string, tier: string): Promise<void> {
    try {
      const windowStart = Date.now() - (this.config.patternDetectionWindow * 60 * 1000);
      const requests = await this.redis.zrangebyscore(
        `${this.METRICS_KEY_PREFIX}requests:${identifier}`,
        windowStart,
        '+inf'
      );

      if (requests.length > 0) {
        const requestTimes = requests.map(time => parseInt(time));
        const intervals = [];
        for (let i = 1; i < requestTimes.length; i++) {
          intervals.push(requestTimes[i] - requestTimes[i - 1]);
        }

        // Calculate average interval and standard deviation
        const avgInterval = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
        const stdDev = Math.sqrt(
          intervals.reduce((sum, interval) => sum + Math.pow(interval - avgInterval, 2), 0) / intervals.length
        );

        // Check for unusual patterns (requests coming in too quickly or too slowly)
        if (stdDev > avgInterval * 2) {
          const alert: RateLimitAlert = {
            timestamp: new Date(),
            type: 'UNUSUAL_PATTERN',
            message: 'Unusual request pattern detected',
            details: {
              identifier,
              tier,
              averageInterval: avgInterval,
              standardDeviation: stdDev,
              requestCount: requests.length
            }
          };
          this.alerts.push(alert);
          this.emit('alert', alert);
        }
      }
    } catch (error) {
      logger.error('Error checking unusual patterns:', error);
      await this.errorHandlingService.handleError(error instanceof Error ? error : new Error(String(error)), {
        category: ErrorCategory.SYSTEM,
        severity: ErrorSeverity.HIGH,
        source: 'RateLimitMonitoringService'
      });
    }
  }

  public getMetrics(): RateLimitMetrics[] {
    return this.metrics;
  }

  public getAlerts(): RateLimitAlert[] {
    return this.alerts;
  }

  public async getDailyMetrics(date: string): Promise<RateLimitMetrics> {
    try {
      const metrics: RateLimitMetrics = {
        timestamp: new Date(date),
        totalRequests: parseInt(await this.redis.get(`${this.DAILY_METRICS_KEY_PREFIX}${date}:requests:total`) || '0'),
        rateLimitedRequests: parseInt(await this.redis.get(`${this.DAILY_METRICS_KEY_PREFIX}${date}:rate_limited:total`) || '0'),
        rateLimitHits: 0,
        rateLimitMisses: 0,
        averageLatency: 0,
        byTier: {},
        byIdentifier: {}
      };

      // Calculate rate limit hits and misses
      metrics.rateLimitHits = metrics.rateLimitedRequests;
      metrics.rateLimitMisses = metrics.totalRequests - metrics.rateLimitedRequests;

      return metrics;
    } catch (error) {
      logger.error('Error getting daily metrics:', error);
      throw error;
    }
  }

  public async cleanup(): Promise<void> {
    try {
      // Clean up old metrics
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30); // Keep last 30 days
      const oldDateStr = oldDate.toISOString().split('T')[0];

      // Delete old daily metrics
      const keys = await this.redis.keys(`${this.DAILY_METRICS_KEY_PREFIX}*`);
      for (const key of keys) {
        const date = key.split(':').pop();
        if (date && date < oldDateStr) {
          await this.redis.del(key);
        }
      }

      // Trim metrics history
      if (this.metrics.length > this.config.maxMetricsHistory) {
        this.metrics = this.metrics.slice(-this.config.maxMetricsHistory);
      }

      // Trim alerts history
      const oldAlerts = this.alerts.filter(alert => alert.timestamp < oldDate);
      this.alerts = this.alerts.filter(alert => alert.timestamp >= oldDate);
    } catch (error) {
      logger.error('Error cleaning up rate limit monitoring:', error);
      throw error;
    }
  }
} 