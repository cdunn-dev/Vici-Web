import { Request, Response, NextFunction } from 'express';
import { OAuthService } from '../services/oauthService';
import { ApiKeyService } from '../services/apiKeyService';
import { RequestSigningService } from '../services/requestSigningService';
import { IpWhitelistService } from '../services/ipWhitelistService';
import { logger } from '../utils/logger';

/**
 * API Security Middleware
 * 
 * This middleware handles API security including:
 * - OAuth 2.0 authentication
 * - API key validation
 * - Request signing for sensitive operations
 * - IP whitelisting for admin endpoints
 */

/**
 * Middleware to authenticate requests using OAuth 2.0
 */
export const oauthAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get the authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or invalid authorization header',
          details: {}
        }
      });
    }
    
    // Extract the token
    const token = authHeader.substring(7);
    
    // Validate the token
    const oauthService = OAuthService.getInstance();
    const tokenData = await oauthService.validateAccessToken(token);
    
    if (!tokenData) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired token',
          details: {}
        }
      });
    }
    
    // Attach the user ID to the request
    req.userId = tokenData.userId;
    
    // Attach the scopes to the request
    req.scopes = tokenData.scopes || [];
    
    next();
  } catch (error) {
    logger.error('Error in OAuth authentication middleware', { error });
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An error occurred during authentication',
        details: {}
      }
    });
  }
};

/**
 * Middleware to authenticate requests using API keys
 */
export const apiKeyAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get the API key from the header
    const apiKey = req.headers['x-api-key'] as string;
    
    if (!apiKey) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing API key',
          details: {}
        }
      });
    }
    
    // Validate the API key
    const apiKeyService = ApiKeyService.getInstance();
    const keyData = await apiKeyService.validateApiKey(apiKey);
    
    if (!keyData) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid API key',
          details: {}
        }
      });
    }
    
    // Check if the API key has exceeded its rate limit
    const isRateLimited = await apiKeyService.checkRateLimit(keyData.keyId);
    
    if (isRateLimited) {
      return res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'API key has exceeded its rate limit',
          details: {
            retryAfter: 3600 // 1 hour
          }
        }
      });
    }
    
    // Attach the user ID to the request
    req.userId = keyData.userId;
    
    // Attach the scopes to the request
    req.scopes = keyData.scopes || [];
    
    // Attach the key ID to the request
    req.apiKeyId = keyData.keyId;
    
    next();
  } catch (error) {
    logger.error('Error in API key authentication middleware', { error });
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An error occurred during authentication',
        details: {}
      }
    });
  }
};

/**
 * Middleware to verify signed requests for sensitive operations
 * @param secret The secret key used to sign the request
 */
export const requestSigning = (secret: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get the request signing service
      const requestSigningService = RequestSigningService.getInstance();
      
      // Verify the request signature
      const isValid = requestSigningService.verifyRequestSignature(req, secret);
      
      if (!isValid) {
        return res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid request signature',
            details: {}
          }
        });
      }
      
      next();
    } catch (error) {
      logger.error('Error in request signing middleware', { error });
      return res.status(500).json({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An error occurred during request verification',
          details: {}
        }
      });
    }
  };
};

/**
 * Middleware to check if the request is from a whitelisted IP
 */
export const ipWhitelist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get the client IP
    const clientIp = req.ip || req.connection.remoteAddress;
    
    if (!clientIp) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Could not determine client IP',
          details: {}
        }
      });
    }
    
    // Get the IP whitelist service
    const ipWhitelistService = IpWhitelistService.getInstance();
    
    // Check if the IP is whitelisted
    const isWhitelisted = await ipWhitelistService.isIpWhitelisted(clientIp);
    
    if (!isWhitelisted) {
      logger.warn('Access denied from non-whitelisted IP', { clientIp });
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied from this IP address',
          details: {}
        }
      });
    }
    
    next();
  } catch (error) {
    logger.error('Error in IP whitelist middleware', { error });
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An error occurred during IP verification',
        details: {}
      }
    });
  }
};

/**
 * Middleware to check if the user has the required scopes
 * @param requiredScopes The scopes required to access the endpoint
 */
export const requireScopes = (requiredScopes: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get the user's scopes
      const userScopes = req.scopes || [];
      
      // Check if the user has all the required scopes
      const hasAllScopes = requiredScopes.every(scope => userScopes.includes(scope));
      
      if (!hasAllScopes) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient scopes',
            details: {
              required: requiredScopes,
              provided: userScopes
            }
          }
        });
      }
      
      next();
    } catch (error) {
      logger.error('Error in scope checking middleware', { error });
      return res.status(500).json({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An error occurred during scope verification',
          details: {}
        }
      });
    }
  };
};

// Extend Express Request interface to include our custom properties
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      scopes?: string[];
      apiKeyId?: string;
    }
  }
} 