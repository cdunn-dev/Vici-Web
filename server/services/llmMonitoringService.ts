import { EventEmitter } from 'events';
import { RedisService } from './redis';
import { logger } from '../utils/logger';
import { LLMRequest, LLMResponse } from '../types/llm';

interface LLMMetrics {
  requests: number;
  tokens: number;
  errors: number;
  latency: number;
}

interface LLMProviderMetrics {
  [key: string]: LLMMetrics;
}

interface LLMMonitoringConfig {
  errorRateThreshold: number;
  latencyThreshold: number;
  costThreshold: number;
}

const DEFAULT_CONFIG: LLMMonitoringConfig = {
  errorRateThreshold: 0.05, // 5% error rate threshold
  latencyThreshold: 2000, // 2 seconds latency threshold
  costThreshold: 100 // $100 daily cost threshold
};

export class LLMMonitoringService extends EventEmitter {
  private static instance: LLMMonitoringService;
  private redis: RedisService;
  private config: LLMMonitoringConfig;
  private readonly METRICS_KEY_PREFIX = 'llm:metrics:';
  private readonly DAILY_METRICS_KEY_PREFIX = 'llm:metrics:daily:';

  private constructor(config: Partial<LLMMonitoringConfig> = {}) {
    super();
    this.redis = RedisService.getInstance();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public static getInstance(config?: Partial<LLMMonitoringConfig>): LLMMonitoringService {
    if (!LLMMonitoringService.instance) {
      LLMMonitoringService.instance = new LLMMonitoringService(config);
    }
    return LLMMonitoringService.instance;
  }

  public async trackRequest(request: LLMRequest, response: LLMResponse, latency: number): Promise<void> {
    try {
      const date = new Date().toISOString().split('T')[0];
      const provider = response.provider;
      const model = response.model;

      // Track request count
      await this.redis.incr(`${this.METRICS_KEY_PREFIX}requests:total`);
      await this.redis.incr(`${this.METRICS_KEY_PREFIX}requests:provider:${provider}`);
      await this.redis.incr(`${this.METRICS_KEY_PREFIX}requests:model:${model}`);

      // Track token usage
      await this.redis.incrby(`${this.METRICS_KEY_PREFIX}tokens:total`, response.usage.totalTokens);
      await this.redis.incrby(`${this.METRICS_KEY_PREFIX}tokens:provider:${provider}`, response.usage.totalTokens);
      await this.redis.incrby(`${this.METRICS_KEY_PREFIX}tokens:model:${model}`, response.usage.totalTokens);

      // Track latency
      await this.redis.incrby(`${this.METRICS_KEY_PREFIX}latency:total`, latency);
      await this.redis.incrby(`${this.METRICS_KEY_PREFIX}latency:provider:${provider}`, latency);
      await this.redis.incrby(`${this.METRICS_KEY_PREFIX}latency:model:${model}`, latency);

      // Track daily metrics
      await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:requests:total`);
      await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:requests:provider:${provider}`);
      await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:requests:model:${model}`);
      await this.redis.incrby(`${this.DAILY_METRICS_KEY_PREFIX}${date}:tokens:total`, response.usage.totalTokens);
      await this.redis.incrby(`${this.DAILY_METRICS_KEY_PREFIX}${date}:tokens:provider:${provider}`, response.usage.totalTokens);
      await this.redis.incrby(`${this.DAILY_METRICS_KEY_PREFIX}${date}:tokens:model:${model}`, response.usage.totalTokens);
      await this.redis.incrby(`${this.DAILY_METRICS_KEY_PREFIX}${date}:latency:total`, latency);
      await this.redis.incrby(`${this.DAILY_METRICS_KEY_PREFIX}${date}:latency:provider:${provider}`, latency);
      await this.redis.incrby(`${this.DAILY_METRICS_KEY_PREFIX}${date}:latency:model:${model}`, latency);

      // Check latency threshold
      if (latency > this.config.latencyThreshold) {
        this.emit('highLatency', {
          provider,
          model,
          latency,
          threshold: this.config.latencyThreshold
        });
      }
    } catch (error) {
      logger.error('Error tracking LLM request:', error);
    }
  }

  public async trackError(request: LLMRequest, error: Error): Promise<void> {
    try {
      const date = new Date().toISOString().split('T')[0];
      const provider = request.provider || 'unknown';
      const model = request.model;

      // Track error count
      await this.redis.incr(`${this.METRICS_KEY_PREFIX}errors:total`);
      await this.redis.incr(`${this.METRICS_KEY_PREFIX}errors:provider:${provider}`);
      await this.redis.incr(`${this.METRICS_KEY_PREFIX}errors:model:${model}`);

      // Track daily errors
      await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:errors:total`);
      await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:errors:provider:${provider}`);
      await this.redis.incr(`${this.DAILY_METRICS_KEY_PREFIX}${date}:errors:model:${model}`);

      // Check error rate threshold
      const totalRequests = parseInt(await this.redis.get(`${this.METRICS_KEY_PREFIX}requests:total`) || '0');
      const totalErrors = parseInt(await this.redis.get(`${this.METRICS_KEY_PREFIX}errors:total`) || '0');
      const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;

      if (errorRate > this.config.errorRateThreshold) {
        this.emit('highErrorRate', {
          provider,
          model,
          errorRate,
          threshold: this.config.errorRateThreshold
        });
      }

      // Log error details
      logger.error('LLM request failed:', {
        provider,
        model,
        error: error.message,
        stack: error.stack
      });
    } catch (err) {
      logger.error('Error tracking LLM error:', err);
    }
  }

  public async getMetrics(date?: string): Promise<LLMProviderMetrics> {
    try {
      const targetDate = date || new Date().toISOString().split('T')[0];
      const metrics: LLMProviderMetrics = {};

      // Get metrics for each provider
      const providers = ['openai', 'anthropic', 'gemini'];
      for (const provider of providers) {
        const requests = parseInt(await this.redis.get(`${this.DAILY_METRICS_KEY_PREFIX}${targetDate}:requests:provider:${provider}`) || '0');
        const tokens = parseInt(await this.redis.get(`${this.DAILY_METRICS_KEY_PREFIX}${targetDate}:tokens:provider:${provider}`) || '0');
        const errors = parseInt(await this.redis.get(`${this.DAILY_METRICS_KEY_PREFIX}${targetDate}:errors:provider:${provider}`) || '0');
        const latency = parseInt(await this.redis.get(`${this.DAILY_METRICS_KEY_PREFIX}${targetDate}:latency:provider:${provider}`) || '0');

        metrics[provider] = {
          requests,
          tokens,
          errors,
          latency: requests > 0 ? latency / requests : 0
        };
      }

      return metrics;
    } catch (error) {
      logger.error('Error getting LLM metrics:', error);
      throw error;
    }
  }

  public async resetMetrics(): Promise<void> {
    try {
      const keys = await this.redis.keys(`${this.METRICS_KEY_PREFIX}*`);
      if (keys.length > 0) {
        for (const key of keys) {
          await this.redis.del(key);
        }
      }
      logger.info('LLM metrics reset successfully');
    } catch (error) {
      logger.error('Error resetting LLM metrics:', error);
      throw error;
    }
  }
} 