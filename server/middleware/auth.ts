import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

/**
 * Middleware to authenticate users
 */
export const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: {
          message: 'Authentication required',
          code: 'AUTHENTICATION_REQUIRED'
        }
      });
    }
    
    const token = authHeader.split(' ')[1];
    
    try {
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'default-secret-key'
      ) as { userId: string };
      
      // Attach user ID to request
      req.user = { id: decoded.userId };
      next();
    } catch (error) {
      logger.warn('Invalid token:', error);
      
      return res.status(401).json({
        error: {
          message: 'Invalid token',
          code: 'INVALID_TOKEN'
        }
      });
    }
  } catch (error) {
    logger.error('Error in user authentication middleware:', error);
    
    res.status(500).json({
      error: {
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      }
    });
  }
};

/**
 * Middleware to authenticate admin users
 */
export const authenticateAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check if user is authenticated
    if (!req.user) {
      return res.status(401).json({
        error: {
          message: 'Authentication required',
          code: 'AUTHENTICATION_REQUIRED'
        }
      });
    }
    
    // Check if user is an admin
    if (!req.user.isAdmin) {
      logger.warn('Non-admin user attempted to access admin route', {
        userId: req.user.id,
        path: req.path
      });
      
      return res.status(403).json({
        error: {
          message: 'Admin access required',
          code: 'ADMIN_ACCESS_REQUIRED'
        }
      });
    }
    
    next();
  } catch (error) {
    logger.error('Error in admin authentication middleware:', error);
    
    res.status(500).json({
      error: {
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      }
    });
  }
}; 