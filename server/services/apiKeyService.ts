import { v4 as uuidv4 } from 'uuid';
import { RedisService } from './redis';
import { logger } from '../utils/logger';
import { createHash, randomBytes } from 'crypto';

/**
 * API Key Service
 * 
 * This service handles API key management including:
 * - Generation of API keys
 * - Validation of API keys
 * - Revocation of API keys
 * - Rate limiting based on API keys
 */
export class ApiKeyService {
  private static instance: ApiKeyService;
  private redis: RedisService;
  
  // API key expiration time (in seconds)
  private readonly API_KEY_EXPIRY = 31536000; // 1 year
  
  private constructor() {
    this.redis = RedisService.getInstance();
  }
  
  /**
   * Get the singleton instance of the API key service
   */
  public static getInstance(): ApiKeyService {
    if (!ApiKeyService.instance) {
      ApiKeyService.instance = new ApiKeyService();
    }
    return ApiKeyService.instance;
  }
  
  /**
   * Generate a new API key for a user
   * @param userId The user ID to generate a key for
   * @param name A name for the API key
   * @param scopes The scopes the API key should have access to
   * @param rateLimit The rate limit for the API key (requests per hour)
   * @returns The generated API key and key ID
   */
  public async generateApiKey(
    userId: string,
    name: string,
    scopes: string[] = [],
    rateLimit: number = 1000
  ): Promise<{ apiKey: string; keyId: string }> {
    try {
      // Generate a unique key ID
      const keyId = uuidv4();
      
      // Generate a secure API key
      const apiKey = this.generateSecureKey();
      
      // Hash the API key for storage
      const hashedKey = this.hashKey(apiKey);
      
      // Store the API key in Redis
      const keyKey = `api_key:${keyId}`;
      await this.redis.setex(
        keyKey,
        this.API_KEY_EXPIRY,
        JSON.stringify({
          userId,
          name,
          scopes,
          rateLimit,
          createdAt: Date.now(),
          lastUsed: null,
          requestCount: 0
        })
      );
      
      // Store the hash mapping for quick lookups
      const hashKey = `api_key_hash:${hashedKey}`;
      await this.redis.setex(hashKey, this.API_KEY_EXPIRY, keyId);
      
      // Add the key ID to the user's API keys set
      const userKeysKey = `user_api_keys:${userId}`;
      await this.redis.sadd(userKeysKey, keyId);
      
      // Set expiry on the user's API keys set
      await this.redis.expire(userKeysKey, this.API_KEY_EXPIRY);
      
      return { apiKey, keyId };
    } catch (error) {
      logger.error('Error generating API key', { error, userId });
      throw new Error('Failed to generate API key');
    }
  }
  
  /**
   * Validate an API key
   * @param apiKey The API key to validate
   * @returns The key data if valid, null otherwise
   */
  public async validateApiKey(apiKey: string): Promise<any> {
    try {
      // Hash the API key for lookup
      const hashedKey = this.hashKey(apiKey);
      
      // Look up the key ID from the hash
      const hashKey = `api_key_hash:${hashedKey}`;
      const keyId = await this.redis.get(hashKey);
      
      if (!keyId) {
        return null;
      }
      
      // Get the key data
      const keyKey = `api_key:${keyId}`;
      const keyData = await this.redis.get(keyKey);
      
      if (!keyData) {
        return null;
      }
      
      const parsedData = JSON.parse(keyData);
      
      // Update last used timestamp
      parsedData.lastUsed = Date.now();
      await this.redis.setex(keyKey, this.API_KEY_EXPIRY, JSON.stringify(parsedData));
      
      return {
        keyId,
        ...parsedData
      };
    } catch (error) {
      logger.error('Error validating API key', { error });
      return null;
    }
  }
  
  /**
   * Check if an API key has exceeded its rate limit
   * @param keyId The key ID to check
   * @returns True if the key has exceeded its rate limit, false otherwise
   */
  public async checkRateLimit(keyId: string): Promise<boolean> {
    try {
      // Get the key data
      const keyKey = `api_key:${keyId}`;
      const keyData = await this.redis.get(keyKey);
      
      if (!keyData) {
        return true; // Key not found, consider it rate limited
      }
      
      const parsedData = JSON.parse(keyData);
      
      // Get the current hour
      const now = Date.now();
      const currentHour = Math.floor(now / 3600000);
      
      // Get the hour from the last request
      const lastRequestHour = parsedData.lastRequestHour || 0;
      
      // If this is a new hour, reset the request count
      if (currentHour !== lastRequestHour) {
        parsedData.requestCount = 0;
        parsedData.lastRequestHour = currentHour;
        await this.redis.setex(keyKey, this.API_KEY_EXPIRY, JSON.stringify(parsedData));
      }
      
      // Increment the request count
      parsedData.requestCount += 1;
      await this.redis.setex(keyKey, this.API_KEY_EXPIRY, JSON.stringify(parsedData));
      
      // Check if the request count exceeds the rate limit
      return parsedData.requestCount > parsedData.rateLimit;
    } catch (error) {
      logger.error('Error checking rate limit', { error, keyId });
      return true; // Error occurred, consider it rate limited
    }
  }
  
  /**
   * Revoke an API key
   * @param keyId The key ID to revoke
   * @param userId The user ID that owns the key
   * @returns True if the key was revoked, false otherwise
   */
  public async revokeApiKey(keyId: string, userId: string): Promise<boolean> {
    try {
      // Get the key data
      const keyKey = `api_key:${keyId}`;
      const keyData = await this.redis.get(keyKey);
      
      if (!keyData) {
        return false;
      }
      
      const parsedData = JSON.parse(keyData);
      
      // Verify the user owns the key
      if (parsedData.userId !== userId) {
        logger.warn('User attempted to revoke another user\'s API key', { 
          userId, 
          keyUserId: parsedData.userId, 
          keyId 
        });
        return false;
      }
      
      // Delete the key
      await this.redis.del(keyKey);
      
      // Remove the key ID from the user's API keys set
      const userKeysKey = `user_api_keys:${userId}`;
      await this.redis.srem(userKeysKey, keyId);
      
      return true;
    } catch (error) {
      logger.error('Error revoking API key', { error, keyId, userId });
      return false;
    }
  }
  
  /**
   * Get all API keys for a user
   * @param userId The user ID to get keys for
   * @returns An array of API key data
   */
  public async getUserApiKeys(userId: string): Promise<any[]> {
    try {
      // Get the user's API key IDs
      const userKeysKey = `user_api_keys:${userId}`;
      const keyIds = await this.redis.smembers(userKeysKey);
      
      // Get the data for each key
      const keys = [];
      for (const keyId of keyIds) {
        const keyKey = `api_key:${keyId}`;
        const keyData = await this.redis.get(keyKey);
        
        if (keyData) {
          const parsedData = JSON.parse(keyData);
          keys.push({
            keyId,
            name: parsedData.name,
            scopes: parsedData.scopes,
            rateLimit: parsedData.rateLimit,
            createdAt: parsedData.createdAt,
            lastUsed: parsedData.lastUsed
          });
        }
      }
      
      return keys;
    } catch (error) {
      logger.error('Error getting user API keys', { error, userId });
      return [];
    }
  }
  
  /**
   * Generate a secure random key
   * @returns A secure random key
   */
  private generateSecureKey(): string {
    return randomBytes(32).toString('hex');
  }
  
  /**
   * Hash a key for storage
   * @param key The key to hash
   * @returns The hashed key
   */
  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
} 