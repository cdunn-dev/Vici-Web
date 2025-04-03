import { Request, Response, NextFunction } from 'express';
import { securityHeadersConfig } from '../config/security';
import { logger } from '../utils/logger';

/**
 * Security Headers Middleware
 * 
 * This middleware applies security headers to all responses, including:
 * - Content Security Policy
 * - X-Content-Type-Options
 * - X-Frame-Options
 * - X-XSS-Protection
 * - Referrer-Policy
 * - Permissions-Policy
 */
export const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
  try {
    // Apply Content Security Policy
    const cspDirectives = Object.entries(securityHeadersConfig.contentSecurityPolicy)
      .map(([key, values]) => `${key} ${values.join(' ')}`)
      .join('; ');
    
    res.setHeader('Content-Security-Policy', cspDirectives);
    
    // Apply other security headers
    Object.entries(securityHeadersConfig.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    
    // Log security headers being applied (in development only)
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Security headers applied', {
        path: req.path,
        method: req.method,
        headers: res.getHeaders()
      });
    }
    
    next();
  } catch (error) {
    logger.error('Error applying security headers', { error });
    // Continue without security headers if there's an error
    next();
  }
};

/**
 * CORS Middleware
 * 
 * This middleware handles Cross-Origin Resource Sharing (CORS) by:
 * - Checking if the origin is allowed
 * - Setting appropriate CORS headers
 * - Handling preflight requests
 */
export const cors = (req: Request, res: Response, next: NextFunction) => {
  try {
    const origin = req.headers.origin;
    
    // Check if the origin is allowed
    if (origin && securityHeadersConfig.cors.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    
    // Set other CORS headers
    res.setHeader('Access-Control-Allow-Methods', securityHeadersConfig.cors.allowedMethods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', securityHeadersConfig.cors.allowedHeaders.join(', '));
    res.setHeader('Access-Control-Expose-Headers', securityHeadersConfig.cors.exposedHeaders.join(', '));
    res.setHeader('Access-Control-Max-Age', securityHeadersConfig.cors.maxAge.toString());
    
    // Handle credentials
    if (securityHeadersConfig.cors.allowCredentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    
    next();
  } catch (error) {
    logger.error('Error applying CORS headers', { error });
    // Continue without CORS headers if there's an error
    next();
  }
};

/**
 * Rate Limiting Headers Middleware
 * 
 * This middleware adds rate limiting headers to the response, including:
 * - X-RateLimit-Limit
 * - X-RateLimit-Remaining
 * - X-RateLimit-Reset
 */
export const rateLimitHeaders = (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get rate limit information from the request
    const rateLimit = (req as any).rateLimit;
    
    if (rateLimit) {
      res.setHeader('X-RateLimit-Limit', rateLimit.limit.toString());
      res.setHeader('X-RateLimit-Remaining', rateLimit.remaining.toString());
      res.setHeader('X-RateLimit-Reset', rateLimit.reset.toString());
    }
    
    next();
  } catch (error) {
    logger.error('Error applying rate limit headers', { error });
    // Continue without rate limit headers if there's an error
    next();
  }
};

// Export all security middleware
export default {
  securityHeaders,
  cors,
 