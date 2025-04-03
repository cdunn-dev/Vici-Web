import { Request, Response, NextFunction } from 'express';
import { RateLimitingService } from '../services/rateLimitingService';
import { ErrorHandlingService, ErrorCategory, ErrorSeverity } from '../services/errorHandlingService';

/**
 * Rate limiting middleware configuration
 */
export interface RateLimitingMiddlewareConfig {
  // Whether to use IP-based rate limiting
  useIpBasedLimiting: boolean;
  // Whether to use user-based rate limiting
  useUserBasedLimiting: boolean;
  // Default rate limit tier to use
  defaultTier: string;
  // Custom identifier function
  getIdentifier?: (req: Request) => string;
}

/**
 * Create a rate limiting middleware
 */
export const createRateLimitingMiddleware = (
  rateLimitingService: RateLimitingService,
  errorHandlingService: ErrorHandlingService,
  config: RateLimitingMiddlewareConfig = {
    useIpBasedLimiting: true,
    useUserBasedLimiting: false,
    defaultTier: 'default'
  }
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get the identifier for rate limiting
      let identifier: string | undefined;
      
      if (config.getIdentifier) {
        identifier = config.getIdentifier(req);
      } else if (config.useUserBasedLimiting && req.user?.id) {
        identifier = `user:${req.user.id}`;
      } else if (config.useIpBasedLimiting) {
        identifier = `ip:${req.ip}`;
      }
      
      if (!identifier) {
        return next();
      }
      
      // Check if the request should be rate limited
      const { limited, remaining, reset } = await rateLimitingService.isRateLimited(
        identifier,
        config.defaultTier
      );
      
      // Add rate limit headers
      const headers = await rateLimitingService.getRateLimitHeaders(identifier, config.defaultTier);
      Object.entries(headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      
      if (limited) {
        // Return 429 Too Many Requests
        return res.status(429).json({
          error: {
            message: 'Too many requests',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: Math.ceil((reset - Date.now()) / 1000)
          }
        });
      }
      
      next();
    } catch (error) {
      // Handle any errors from the rate limiting service
      await errorHandlingService.handleError(error instanceof Error ? error : new Error(String(error)), {
        category: ErrorCategory.SYSTEM,
        severity: ErrorSeverity.HIGH,
        source: 'RateLimitingMiddleware'
      });
      
      // Continue the request even if rate limiting fails
      next();
    }
  };
}; 