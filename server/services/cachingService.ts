import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

interface CacheConfig {
  /**
   * Default TTL in milliseconds
   */
  defaultTTL: number;
  
  /**
   * Maximum number of items in the cache
   */
  maxSize: number;
  
  /**
   * Whether to use LRU eviction
   */
  useLRU: boolean;
  
  /**
   * Whether to enable cache statistics
   */
  enableStats: boolean;
  
  /**
   * Whether to enable cache events
   */
  enableEvents: boolean;
}

interface CacheItem<T> {
  key: string;
  value: T;
  expiresAt: number | null;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  hitRate: number;
}

type CacheEvents = {
  'set': (key: string, value: any) => void;
  'get': (key: string, value: any) => void;
  'delete': (key: string) => void;
  'expire': (key: string) => void;
  'evict': (key: string) => void;
  'clear': () => void;
};

export class CachingService extends EventEmitter {
  private cache: Map<string, CacheItem<any>>;
  private config: CacheConfig;
  private stats: CacheStats;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<CacheConfig> = {}) {
    super();
    
    this.config = {
      defaultTTL: 3600000, // 1 hour
      maxSize: 10000,
      useLRU: true,
      enableStats: true,
      enableEvents: true,
      ...config
    };
    
    this.cache = new Map<string, CacheItem<any>>();
    
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      hitRate: 0
    };
    
    // Start cleanup interval
    this.startCleanupInterval();
  }

  /**
   * Set a value in the cache
   */
  set<T>(key: string, value: T, ttl?: number): void {
    try {
      // Check if cache is full and evict if necessary
      if (this.cache.size >= this.config.maxSize) {
        this.evictItems();
      }
      
      const now = Date.now();
      const expiresAt = ttl ? now + ttl : (this.config.defaultTTL ? now + this.config.defaultTTL : null);
      
      const item: CacheItem<T> = {
        key,
        value,
        expiresAt,
        createdAt: now,
        lastAccessed: now,
        accessCount: 0
      };
      
      this.cache.set(key, item);
      
      if (this.config.enableStats) {
        this.stats.size = this.cache.size;
      }
      
      if (this.config.enableEvents) {
        this.emit('set', key, value);
      }
      
      logger.debug(`Cache set: ${key}`);
    } catch (error) {
      logger.error(`Failed to set cache item: ${key}`, error);
    }
  }

  /**
   * Get a value from the cache
   */
  get<T>(key: string): T | null {
    try {
      const item = this.cache.get(key);
      
      if (!item) {
        if (this.config.enableStats) {
          this.stats.misses++;
          this.updateHitRate();
        }
        
        logger.debug(`Cache miss: ${key}`);
        return null;
      }
      
      // Check if item is expired
      if (item.expiresAt !== null && item.expiresAt < Date.now()) {
        this.delete(key);
        
        if (this.config.enableStats) {
          this.stats.misses++;
          this.updateHitRate();
        }
        
        logger.debug(`Cache expired: ${key}`);
        return null;
      }
      
      // Update access metadata
      item.lastAccessed = Date.now();
      item.accessCount++;
      
      if (this.config.enableStats) {
        this.stats.hits++;
        this.updateHitRate();
      }
      
      if (this.config.enableEvents) {
        this.emit('get', key, item.value);
      }
      
      logger.debug(`Cache hit: ${key}`);
      return item.value as T;
    } catch (error) {
      logger.error(`Failed to get cache item: ${key}`, error);
      return null;
    }
  }

  /**
   * Delete a value from the cache
   */
  delete(key: string): boolean {
    try {
      const result = this.cache.delete(key);
      
      if (result) {
        if (this.config.enableStats) {
          this.stats.size = this.cache.size;
        }
        
        if (this.config.enableEvents) {
          this.emit('delete', key);
        }
        
        logger.debug(`Cache delete: ${key}`);
      }
      
      return result;
    } catch (error) {
      logger.error(`Failed to delete cache item: ${key}`, error);
      return false;
    }
  }

  /**
   * Clear the cache
   */
  clear(): void {
    try {
      this.cache.clear();
      
      if (this.config.enableStats) {
        this.stats.size = 0;
      }
      
      if (this.config.enableEvents) {
        this.emit('clear');
      }
      
      logger.info('Cache cleared');
    } catch (error) {
      logger.error('Failed to clear cache', error);
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
      hits: 0,
      misses: 0,
      evictions: 0,
      size: this.cache.size,
      hitRate: 0
    };
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Check if a key exists in the cache
   */
  has(key: string): boolean {
    const item = this.cache.get(key);
    
    if (!item) {
      return false;
    }
    
    // Check if item is expired
    if (item.expiresAt !== null && item.expiresAt < Date.now()) {
      this.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Get all keys in the cache
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all values in the cache
   */
  values(): any[] {
    return Array.from(this.cache.values()).map(item => item.value);
  }

  /**
   * Get all entries in the cache
   */
  entries(): [string, any][] {
    return Array.from(this.cache.entries()).map(([key, item]) => [key, item.value]);
  }

  /**
   * Start the cleanup interval
   */
  private startCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Run cleanup every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  /**
   * Clean up expired items
   */
  private cleanup(): void {
    try {
      const now = Date.now();
      let expiredCount = 0;
      
      for (const [key, item] of this.cache.entries()) {
        if (item.expiresAt !== null && item.expiresAt < now) {
          this.delete(key);
          expiredCount++;
          
          if (this.config.enableEvents) {
            this.emit('expire', key);
          }
        }
      }
      
      if (expiredCount > 0) {
        logger.info(`Cleaned up ${expiredCount} expired items from cache`);
      }
    } catch (error) {
      logger.error('Failed to clean up cache', error);
    }
  }

  /**
   * Evict items from the cache
   */
  private evictItems(): void {
    try {
      if (this.cache.size < this.config.maxSize) {
        return;
      }
      
      const itemsToEvict = this.cache.size - this.config.maxSize + 10; // Evict a few extra to avoid frequent evictions
      
      if (this.config.useLRU) {
        // Sort by last accessed time
        const sortedItems = Array.from(this.cache.entries())
          .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
        
        // Evict the least recently used items
        for (let i = 0; i < itemsToEvict && i < sortedItems.length; i++) {
          const [key] = sortedItems[i];
          this.delete(key);
          
          if (this.config.enableStats) {
            this.stats.evictions++;
          }
          
          if (this.config.enableEvents) {
            this.emit('evict', key);
          }
        }
      } else {
        // Random eviction
        const keys = Array.from(this.cache.keys());
        
        for (let i = 0; i < itemsToEvict && keys.length > 0; i++) {
          const randomIndex = Math.floor(Math.random() * keys.length);
          const key = keys.splice(randomIndex, 1)[0];
          
          this.delete(key);
          
          if (this.config.enableStats) {
            this.stats.evictions++;
          }
          
          if (this.config.enableEvents) {
            this.emit('evict', key);
          }
        }
      }
      
      logger.info(`Evicted ${itemsToEvict} items from cache`);
    } catch (error) {
      logger.error('Failed to evict items from cache', error);
    }
  }

  /**
   * Update the hit rate
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Stop the cleanup interval
   */
  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Dispose of the cache
   */
  dispose(): void {
    this.stopCleanupInterval();
    this.clear();
  }
} 