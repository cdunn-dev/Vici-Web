import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * Validate API key middleware
 */
export const validateApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers['x-api-key'];
    
    // Skip validation for health check and docs
    if (req.path.startsWith('/health') || req.path.startsWith('/docs')) {
      return next();
    }
    
    if (!apiKey) {
      logger.warn('Missing API key', {
        path: req.path,
        ip: req.ip
      });
      
      return res.status(401).json({
        error: {
          message: 'API key required',
          code: 'API_KEY_REQUIRED'
        }
      });
    }
    
    // TODO: Validate API key against database or cache
    // For now, use environment variable
    if (apiKey !== process.env.API_KEY) {
      logger.warn('Invalid API key', {
        path: req.path,
        ip: req.ip
      });
      
      return res.status(401).json({
        error: {
          message: 'Invalid API key',
          code: 'INVALID_API_KEY'
        }
      });
    }
    
    next();
  } catch (error) {
    logger.error('Error validating API key:', error);
    
    res.status(500).json({
      error: {
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      }
    });
  }
}; 