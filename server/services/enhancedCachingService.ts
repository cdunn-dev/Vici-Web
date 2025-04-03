import { RedisService } from './redis';
import { CachingService } from './cachingService';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

interface EnhancedCacheConfig {
  // Redis configuration
  redis: {
    enabled: boolean;
    ttl: number;
    compressionThreshold: number;
    maxRetries: number;
    retryDelay: number;
    maxMemory: number;
    maxKeys: number;
    evictionStrategy: string;
  };
  
  // In-memory cache configuration
  memory: {
    enabled: boolean;
    defaultTTL: number;
    maxSize: number;
    useLRU: boolean;
  };
  
  // General configuration
  defaultTTL: number;
  staleWhileRevalidate: boolean;
  staleTTL: number;
  retryOnError: boolean;
  maxRetries: number;
  retryDelay: number;
  enableStats: boolean;
  enableEvents: boolean;
}

interface CacheEntry<T> {
  value: T;
  metadata: {
    createdAt: number;
    expiresAt: number | null;
    lastAccessed: number;
    accessCount: number;
    version: number;
    hash: string;
  };
}

interface CacheStats {
  hits: {
    memory: number;
    redis: number;
    total: number;
  };
  misses: {
    memory: number;
    redis: number;
    total: number;
  };
  evictions: {
    memory: number;
    redis: number;
    total: number;
  };
  errors: number;
  hitRate: number;
}

export class EnhancedCachingService extends EventEmitter {
  private redis: RedisService | null = null;
  private memory: CachingService | null = null;
  private config: EnhancedCacheConfig;
  private stats: CacheStats;
  private locks: Map<string, Promise<void>> = new Map();
  private version: number = 1;

  constructor(config: Partial<EnhancedCacheConfig> = {}) {
    super();
    
    this.config = {
      redis: {
        enabled: true,
        ttl: 3600,
        compressionThreshold: 1024,
        maxRetries: 3,
        retryDelay: 1000,
        maxMemory: 1024 * 1024 * 1024,
        maxKeys: 10000,
        evictionStrategy: 'allkeys-lru'
      },
      memory: {
        enabled: true,
        defaultTTL: 3600000,
        maxSize: 10000,
        useLRU: true
      },
      defaultTTL: 3600,
      staleWhileRevalidate: true,
      staleTTL: 86400,
      retryOnError: true,
      maxRetries: 3,
      retryDelay: 1000,
      enableStats: true,
      enableEvents: true,
      ...config
    };
    
    this.stats = {
      hits: { memory: 0, redis: 0, total: 0 },
      misses: { memory: 0, redis: 0, total: 0 },
      evictions: { memory: 0, redis: 0, total: 0 },
      errors: 0,
      hitRate: 0
    };
    
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      if (this.config.redis.enabled) {
        // Get the singleton instance of RedisService
        const redisInstance = RedisService.getInstance();
        if (redisInstance) {
          this.redis = redisInstance;
        } else {
          logger.warn('Failed to get Redis service instance');
        }
      }
      
      if (this.config.memory.enabled) {
        this.memory = new CachingService({
          defaultTTL: this.config.memory.defaultTTL,
          maxSize: this.config.memory.maxSize,
          useLRU: this.config.memory.useLRU,
          enableStats: this.config.enableStats,
          enableEvents: this.config.enableEvents
        });
      }
      
      logger.info('Enhanced caching service initialized');
    } catch (error) {
      logger.error('Failed to initialize enhanced caching service:', error);
      throw error;
    }
  }

  /**
   * Set a value in the cache with proper locking and versioning
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const lock = this.acquireLock(key);
    
    try {
      await lock;
      
      const entry: CacheEntry<T> = {
        value,
        metadata: {
          createdAt: Date.now(),
          expiresAt: ttl ? Date.now() + ttl : null,
          lastAccessed: Date.now(),
          accessCount: 0,
          version: this.version++,
          hash: this.calculateHash(value)
        }
      };
      
      // Set in memory cache if enabled
      if (this.memory) {
        this.memory.set(key, entry, ttl);
      }
      
      // Set in Redis if enabled
      if (this.redis) {
        await this.redis.set(key, JSON.stringify(entry), ttl || this.config.defaultTTL);
      }
      
      if (this.config.enableEvents) {
        this.emit('set', key, value);
      }
      
      logger.debug(`Cache set: ${key}`);
    } catch (error) {
      this.stats.errors++;
      logger.error(`Failed to set cache item: ${key}`, error);
      throw error;
    } finally {
      this.releaseLock(key);
    }
  }

  /**
   * Get a value from the cache with proper locking and versioning
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      // Try memory cache first if enabled
      if (this.memory) {
        const memoryEntry = this.memory.get<CacheEntry<T>>(key);
        if (memoryEntry) {
          if (this.isValid(memoryEntry)) {
            this.updateStats('hit', 'memory');
            return memoryEntry.value;
          }
          this.memory.delete(key);
        }
      }
      
      // Try Redis if enabled
      if (this.redis) {
        const redisData = await this.redis.get(key);
        if (redisData) {
          const redisEntry: CacheEntry<T> = JSON.parse(redisData);
          
          if (this.isValid(redisEntry)) {
            // Update memory cache if enabled
            if (this.memory) {
              this.memory.set(key, redisEntry);
            }
            
            this.updateStats('hit', 'redis');
            return redisEntry.value;
          }
          
          // Handle stale data
          if (this.config.staleWhileRevalidate && this.isStale(redisEntry)) {
            // Start background revalidation
            this.revalidateInBackground(key, redisEntry);
            return redisEntry.value;
          }
          
          await this.redis.delete(key);
        }
      }
      
      this.updateStats('miss', this.memory ? 'memory' : 'redis');
      return null;
    } catch (error) {
      this.stats.errors++;
      logger.error(`Failed to get cache item: ${key}`, error);
      return null;
    }
  }

  /**
   * Delete a value from all caches
   */
  async delete(key: string): Promise<boolean> {
    const lock = this.acquireLock(key);
    
    try {
      await lock;
      
      let success = true;
      
      if (this.memory) {
        success = success && Boolean(this.memory.delete(key));
      }
      
      if (this.redis) {
        success = success && Boolean(await this.redis.delete(key));
      }
      
      if (this.config.enableEvents) {
        this.emit('delete', key);
      }
      
      return success;
    } catch (error) {
      this.stats.errors++;
      logger.error(`Failed to delete cache item: ${key}`, error);
      return false;
    } finally {
      this.releaseLock(key);
    }
  }

  /**
   * Clear all caches
   */
  async clear(): Promise<void> {
    try {
      if (this.memory) {
        this.memory.clear();
      }
      
      if (this.redis) {
        await this.redis.clear();
      }
      
      if (this.config.enableEvents) {
        this.emit('clear');
      }
      
      logger.info('Cache cleared');
    } catch (error) {
      this.stats.errors++;
      logger.error('Failed to clear cache', error);
      throw error;
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    this.stats = {
      hits: { memory: 0, redis: 0, total: 0 },
      misses: { memory: 0, redis: 0, total: 0 },
      evictions: { memory: 0, redis: 0, total: 0 },
      errors: 0,
      hitRate: 0
    };
  }

  private acquireLock(key: string): Promise<void> {
    if (!this.locks.has(key)) {
      this.locks.set(key, Promise.resolve());
    }
    
    const currentLock = this.locks.get(key)!;
    let releaseLock: () => void;
    
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    
    this.locks.set(key, currentLock.then(() => newLock));
    
    return newLock;
  }

  private releaseLock(key: string): void {
    const lock = this.locks.get(key);
    if (lock) {
      this.locks.delete(key);
    }
  }

  private calculateHash(value: any): string {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(value));
    return hash.digest('hex');
  }

  private isValid(entry: CacheEntry<any>): boolean {
    if (!entry.metadata.expiresAt) {
      return true;
    }
    return entry.metadata.expiresAt > Date.now();
  }

  private isStale(entry: CacheEntry<any>): boolean {
    if (!entry.metadata.expiresAt) {
      return false;
    }
    return entry.metadata.expiresAt + this.config.staleTTL > Date.now();
  }

  private async revalidateInBackground(key: string, staleEntry: CacheEntry<any>): Promise<void> {
    try {
      // Implement your revalidation logic here
      // This could involve fetching fresh data from the source
      // and updating the cache
      
      logger.debug(`Revalidating stale cache entry: ${key}`);
    } catch (error) {
      logger.error(`Failed to revalidate cache entry: ${key}`, error);
    }
  }

  private updateStats(type: 'hit' | 'miss' | 'eviction', cache: 'memory' | 'redis'): void {
    if (!this.config.enableStats) {
      return;
    }
    
    if (type === 'hit') {
      this.stats.hits[cache]++;
      this.stats.hits.total++;
    } else if (type === 'miss') {
      this.stats.misses[cache]++;
      this.stats.misses.total++;
    } else if (type === 'eviction') {
      this.stats.evictions[cache]++;
      this.stats.evictions.total++;
    }
    
    const total = this.stats.hits.total + this.stats.misses.total;
    this.stats.hitRate = total > 0 ? this.stats.hits.total / total : 0;
  }
} 