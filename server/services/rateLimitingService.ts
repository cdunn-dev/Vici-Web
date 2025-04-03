import { logger } from '../utils/logger';
import { ErrorHandlingService, ErrorCategory, ErrorSeverity } from './errorHandlingService';
import Redis from 'ioredis';

/**
 * Rate limiting configuration
 */
export interface RateLimitConfig {
  // Maximum number of tokens in the bucket
  maxTokens: number;
  // Rate at which tokens are added to the bucket (tokens per second)
  refillRate: number;
  // Time window for rate limiting (in seconds)
  timeWindow: number;
  // Whether to use Redis for distributed rate limiting
  useRedis?: boolean;
  // Redis configuration (if useRedis is true)
  redisConfig?: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };
}

/**
 * Rate limit tier configuration
 */
export interface RateLimitTier {
  // Tier name
  name: string;
  // Maximum number of tokens in the bucket
  maxTokens: number;
  // Rate at which tokens are added to the bucket (tokens per second)
  refillRate: number;
  // Time window for rate limiting (in seconds)
  timeWindow: number;
}

/**
 * Rate limiting service for API rate limiting
 */
export class RateLimitingService {
  private static instance: RateLimitingService;
  private errorHandlingService: ErrorHandlingService;
  private redisClient?: Redis;
  private localBuckets: Map<string, { tokens: number; lastRefill: number }>;
  private defaultConfig: RateLimitConfig;
  private tiers: Map<string, RateLimitTier>;
  private bypassList: Set<string>;

  private constructor(errorHandlingService: ErrorHandlingService, config?: RateLimitConfig) {
    this.errorHandlingService = errorHandlingService;
    this.localBuckets = new Map();
    this.tiers = new Map();
    this.bypassList = new Set();
    
    // Default configuration
    this.defaultConfig = {
      maxTokens: 100,
      refillRate: 10,
      timeWindow: 60,
      useRedis: false,
      ...config
    };
    
    // Initialize Redis if configured
    if (this.defaultConfig.useRedis && this.defaultConfig.redisConfig) {
      this.redisClient = new Redis(this.defaultConfig.redisConfig);
      this.redisClient.on('error', (error) => {
        logger.error('Redis error:', error);
        this.errorHandlingService.handleError(error.message, {
          category: ErrorCategory.SYSTEM,
          severity: ErrorSeverity.HIGH,
          context: { service: 'RateLimitingService', error }
        });
      });
    }
    
    // Add default tier
    this.addTier('default', {
      name: 'default',
      maxTokens: this.defaultConfig.maxTokens,
      refillRate: this.defaultConfig.refillRate,
      timeWindow: this.defaultConfig.timeWindow
    });
  }

  /**
   * Get the singleton instance of the RateLimitingService
   */
  public static getInstance(errorHandlingService?: ErrorHandlingService, config?: RateLimitConfig): RateLimitingService {
    if (!RateLimitingService.instance) {
      if (!errorHandlingService) {
        throw new Error('ErrorHandlingService is required for first initialization');
      }
      RateLimitingService.instance = new RateLimitingService(errorHandlingService, config);
    }
    return RateLimitingService.instance;
  }

  /**
   * Add a rate limit tier
   */
  public addTier(name: string, tier: RateLimitTier): void {
    this.tiers.set(name, tier);
  }

  /**
   * Add an IP or user ID to the bypass list
   */
  public addToBypassList(identifier: string): void {
    this.bypassList.add(identifier);
  }

  /**
   * Remove an IP or user ID from the bypass list
   */
  public removeFromBypassList(identifier: string): void {
    this.bypassList.delete(identifier);
  }

  /**
   * Check if a request should be rate limited
   */
  public async isRateLimited(identifier: string, tier: string = 'default'): Promise<{ limited: boolean; remaining: number; reset: number }> {
    // Check if the identifier is in the bypass list
    if (this.bypassList.has(identifier)) {
      return { limited: false, remaining: -1, reset: 0 };
    }
    
    // Get the tier configuration
    const tierConfig = this.tiers.get(tier) || this.tiers.get('default')!;
    
    // Use Redis for distributed rate limiting if configured
    if (this.defaultConfig.useRedis && this.redisClient) {
      return this.isRateLimitedRedis(identifier, tierConfig);
    }
    
    // Use local rate limiting
    return this.isRateLimitedLocal(identifier, tierConfig);
  }

  /**
   * Check if a request should be rate limited using Redis
   */
  private async isRateLimitedRedis(identifier: string, tier: RateLimitTier): Promise<{ limited: boolean; remaining: number; reset: number }> {
    if (!this.redisClient) {
      throw new Error('Redis client not initialized');
    }
    
    const key = `ratelimit:${identifier}:${tier.name}`;
    const now = Date.now();
    const windowStart = now - (tier.timeWindow * 1000);
    
    // Use Redis transaction to ensure atomicity
    const result = await this.redisClient.multi()
      .zremrangebyscore(key, 0, windowStart)
      .zcard(key)
      .zadd(key, now, `${now}-${Math.random()}`)
      .expire(key, tier.timeWindow)
      .exec();
    
    if (!result) {
      throw new Error('Redis transaction failed');
    }
    
    const requestCount = result[1][1] as number;
    const limited = requestCount > tier.maxTokens;
    const remaining = Math.max(0, tier.maxTokens - requestCount);
    const reset = now + (tier.timeWindow * 1000);
    
    return { limited, remaining, reset };
  }

  /**
   * Check if a request should be rate limited using local storage
   */
  private isRateLimitedLocal(identifier: string, tier: RateLimitTier): { limited: boolean; remaining: number; reset: number } {
    const key = `${identifier}:${tier.name}`;
    const now = Date.now();
    
    // Get or create bucket
    let bucket = this.localBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: tier.maxTokens, lastRefill: now };
      this.localBuckets.set(key, bucket);
    }
    
    // Refill tokens
    const timePassed = (now - bucket.lastRefill) / 1000; // Convert to seconds
    const tokensToAdd = timePassed * tier.refillRate;
    bucket.tokens = Math.min(tier.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
    
    // Check if rate limited
    const limited = bucket.tokens < 1;
    const remaining = Math.floor(bucket.tokens);
    const reset = now + ((1 - bucket.tokens) / tier.refillRate * 1000);
    
    // Consume token if not limited
    if (!limited) {
      bucket.tokens -= 1;
    }
    
    return { limited, remaining, reset };
  }

  /**
   * Get rate limit headers for a response
   */
  public getRateLimitHeaders(identifier: string, tier: string = 'default'): Promise<{ 'X-RateLimit-Limit': number; 'X-RateLimit-Remaining': number; 'X-RateLimit-Reset': number }> {
    return this.isRateLimited(identifier, tier).then(({ remaining, reset }) => {
      const tierConfig = this.tiers.get(tier) || this.tiers.get('default')!;
      return {
        'X-RateLimit-Limit': tierConfig.maxTokens,
        'X-RateLimit-Remaining': remaining,
        'X-RateLimit-Reset': Math.ceil(reset / 1000) // Convert to Unix timestamp
      };
    });
  }

  /**
   * Clean up resources
   */
  public async cleanup(): Promise<void> {
    if (this.redisClient) {
      await this.redisClient.quit();
    }
  }
} 