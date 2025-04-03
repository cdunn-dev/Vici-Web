import { Redis } from 'ioredis';
import { logger } from '../utils/logger';

export interface RedisStats {
  hitRate: number;
  memoryUsage: number;
  evictionCount: number;
  connectedClients: number;
  totalCommands: number;
  opsPerSecond: number;
}

export class RedisMonitor {
  private static instance: RedisMonitor;
  private redis: Redis;
  private stats: RedisStats[] = [];
  private monitoringInterval: NodeJS.Timeout | null = null;
  private readonly MAX_STATS = 100; // Keep last 100 stats

  constructor() {
    this.redis = new Redis();
  }

  public static getInstance(): RedisMonitor {
    if (!RedisMonitor.instance) {
      RedisMonitor.instance = new RedisMonitor();
    }
    return RedisMonitor.instance;
  }

  public startMonitoring(intervalMs: number = 60000): void {
    if (this.monitoringInterval) {
      logger.warn('Redis monitoring is already running');
      return;
    }

    logger.info(`Starting Redis monitoring (interval: ${intervalMs}ms)`);
    
    this.monitoringInterval = setInterval(async () => {
      await this.collectStats();
    }, intervalMs);
  }

  public stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('Redis monitoring stopped');
    }
  }

  private async collectStats(): Promise<void> {
    try {
      const connected = await this.redis.healthCheck();
      const memoryUsage = await this.redis.getMemoryUsage();
      const cacheMetrics = this.redis.getMetrics();
      const hitRate = this.redis.getHitRate();
      const evictionPolicy = await this.redis.getEvictionPolicy();

      const stats: RedisStats = {
        timestamp: new Date(),
        connected,
        memoryUsage,
        cacheMetrics: {
          hits: cacheMetrics.hits,
          misses: cacheMetrics.misses,
          hitRate
        },
        evictionPolicy
      };

      this.stats.push(stats);
      
      // Keep only the last MAX_STATS
      if (this.stats.length > this.MAX_STATS) {
        this.stats = this.stats.slice(-this.MAX_STATS);
      }

      // Log warnings if needed
      if (memoryUsage && memoryUsage.used > memoryUsage.total * 0.8) {
        logger.warn(`Redis memory usage is high: ${(memoryUsage.used / memoryUsage.total * 100).toFixed(2)}%`);
      }

      if (hitRate < 0.5) {
        logger.warn(`Redis cache hit rate is low: ${(hitRate * 100).toFixed(2)}%`);
      }

      if (!connected) {
        logger.error('Redis connection is down');
      }
    } catch (error) {
      logger.error('Error collecting Redis stats:', error);
    }
  }

  public getStats(): RedisStats[] {
    return [...this.stats];
  }

  public getLatestStats(): RedisStats | null {
    return this.stats.length > 0 ? this.stats[this.stats.length - 1] : null;
  }

  public getAverageHitRate(): number {
    if (this.stats.length === 0) return 0;
    
    const totalHitRate = this.stats.reduce((sum, stat) => sum + stat.cacheMetrics.hitRate, 0);
    return totalHitRate / this.stats.length;
  }

  public getMemoryUsageTrend(): { increasing: boolean; percentage: number } {
    if (this.stats.length < 2) return { increasing: false, percentage: 0 };
    
    const latest = this.stats[this.stats.length - 1];
    const previous = this.stats[this.stats.length - 2];
    
    if (!latest.memoryUsage || !previous.memoryUsage) {
      return { increasing: false, percentage: 0 };
    }
    
    const increase = latest.memoryUsage.used - previous.memoryUsage.used;
    const percentage = (increase / previous.memoryUsage.used) * 100;
    
    return {
      increasing: increase > 0,
      percentage
    };
  }
} 