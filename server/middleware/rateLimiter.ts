import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { logger } from '../utils/logger';

// Initialize Redis client
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
});

// Configure rate limits
const RATE_LIMIT_WINDOW = 60; // 1 minute
const DEFAULT_RATE_LIMIT = 60; // 60 requests per minute
const RATE_LIMITS: { [key: string]: number } = {
  '/api/v1/auth': 10, // 10 requests per minute for auth endpoints
  '/api/v1/users': 30, // 30 requests per minute for user endpoints
  '/api/v1/training': 60, // 60 requests per minute for training endpoints
  '/api/v1/workouts': 60, // 60 requests per minute for workout endpoints
};

/**
 * Get rate limit for a path
 */
const getRateLimit = (path: string): number => {
  // Find matching rate limit
  const matchingPath = Object.keys(RATE_LIMITS).find(p => path.startsWith(p));
  return matchingPath ? RATE_LIMITS[matchingPath] : DEFAULT_RATE_LIMIT;
};

/**
 * Rate limiter middleware
 */
export const rateLimiter = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Skip rate limiting for health check and docs
    if (req.path.startsWith('/health') || req.path.startsWith('/docs')) {
      return next();
    }
    
    const key = `rate_limit:${req.ip}:${req.path}`;
    const limit = getRateLimit(req.path);
    
    // Use Redis to track request count
    const result = await redis
      .multi()
      .incr(key)
      .expire(key, RATE_LIMIT_WINDOW)
      .exec();
    
    if (!result) {
      throw new Error('Failed to execute Redis commands');
    }
    
    const [[incrErr, count], [expireErr]] = result;
    
    if (incrErr || expireErr) {
      throw incrErr || expireErr;
    }
    
    if (typeof count !== 'number') {
      throw new Error('Invalid count returned from Redis');
    }
    
    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));
    res.setHeader('X-RateLimit-Reset', Math.floor(Date.now() / 1000) + RATE_LIMIT_WINDOW);
    
    if (count > limit) {
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        path: req.path,
        limit,
        count
      });
      
      return res.status(429).json({
        error: {
          message: 'Too many requests',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: RATE_LIMIT_WINDOW
        }
      });
    }
    
    next();
  } catch (error) {
    logger.error('Error in rate limiter:', error);
    
    // On error, allow the request to proceed
    next();
  }
};

// Handle Redis connection errors
redis.on('error', (error) => {
  logger.error('Redis connection error:', error);
});

// Handle Redis connection success
redis.on('connect', () => {
  logger.info('Connected to Redis');
}); 