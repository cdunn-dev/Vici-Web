import { Request, Response, NextFunction } from 'express';
import { RedisService } from '../services/redis';
import { logger } from '../utils/logger';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
}

export const rateLimit = (options: RateLimitOptions) => {
  const redis = RedisService.getInstance();
  const { windowMs, max, keyPrefix = 'rate-limit' } = options;
  
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `${keyPrefix}:${req.user?.id || req.ip}`;
      const current = await redis.incr(key);
      
      if (current === 1) {
        await redis.expire(key, Math.ceil(windowMs / 1000));
      }
      
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));
      
      if (current > max) {
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: await redis.ttl(key)
        });
      }
      
      next();
    } catch (error) {
      logger.error('Rate limiting error:', error);
      next();
    }
  };
}; 