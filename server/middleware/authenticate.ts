import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
      };
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({
        error: 'No authorization header'
      });
    }
    
    const [type, token] = authHeader.split(' ');
    
    if (type !== 'Bearer') {
      return res.status(401).json({
        error: 'Invalid authorization type'
      });
    }
    
    if (!token) {
      return res.status(401).json({
        error: 'No token provided'
      });
    }
    
    const secret = process.env.JWT_SECRET;
    
    if (!secret) {
      logger.error('JWT_SECRET is not defined');
      return res.status(500).json({
        error: 'Internal server error'
      });
    }
    
    const decoded = jwt.verify(token, secret) as {
      id: string;
      email: string;
      role: string;
    };
    
    req.user = decoded;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({
        error: 'Invalid token'
      });
    }
    
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        error: 'Token expired'
      });
    }
    
    logger.error('Authentication error:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
}; 