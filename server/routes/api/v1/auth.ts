import { Router } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { logger } from '../../../utils/logger';

/**
 * Create authentication router
 */
export const createAuthRouter = (pool: Pool, redis: Redis): Router => {
  const router = Router();
  
  /**
   * Register a new user
   */
  router.post('/register', async (req, res) => {
    try {
      const { email, password, name } = req.body;
      
      // Validate input
      if (!email || !password || !name) {
        return res.status(400).json({
          error: {
            message: 'Missing required fields',
            code: 'MISSING_FIELDS'
          }
        });
      }
      
      // Check if user already exists
      const existingUser = await pool.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );
      
      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          error: {
            message: 'User already exists',
            code: 'USER_EXISTS'
          }
        });
      }
      
      // Hash password
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      
      // Create user
      const result = await pool.query(
        'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
        [email, hashedPassword, name]
      );
      
      const user = result.rows[0];
      
      // Generate JWT token
      const token = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET || 'default-secret-key',
        { expiresIn: '24h' }
      );
      
      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name
        },
        token
      });
    } catch (error) {
      logger.error('Registration error:', error);
      
      res.status(500).json({
        error: {
          message: 'Registration failed',
          code: 'REGISTRATION_FAILED'
        }
      });
    }
  });
  
  /**
   * Login user
   */
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      
      // Validate input
      if (!email || !password) {
        return res.status(400).json({
          error: {
            message: 'Missing email or password',
            code: 'MISSING_CREDENTIALS'
          }
        });
      }
      
      // Find user
      const result = await pool.query(
        'SELECT id, email, password, name FROM users WHERE email = $1',
        [email]
      );
      
      if (result.rows.length === 0) {
        return res.status(401).json({
          error: {
            message: 'Invalid credentials',
            code: 'INVALID_CREDENTIALS'
          }
        });
      }
      
      const user = result.rows[0];
      
      // Verify password
      const passwordMatch = await bcrypt.compare(password, user.password);
      
      if (!passwordMatch) {
        return res.status(401).json({
          error: {
            message: 'Invalid credentials',
            code: 'INVALID_CREDENTIALS'
          }
        });
      }
      
      // Generate JWT token
      const token = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET || 'default-secret-key',
        { expiresIn: '24h' }
      );
      
      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name
        },
        token
      });
    } catch (error) {
      logger.error('Login error:', error);
      
      res.status(500).json({
        error: {
          message: 'Login failed',
          code: 'LOGIN_FAILED'
        }
      });
    }
  });
  
  /**
   * Refresh token
   */
  router.post('/refresh-token', async (req, res) => {
    try {
      const { token } = req.body;
      
      if (!token) {
        return res.status(400).json({
          error: {
            message: 'Token is required',
            code: 'TOKEN_REQUIRED'
          }
        });
      }
      
      // Verify token
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'default-secret-key'
      ) as { userId: string };
      
      // Find user
      const result = await pool.query(
        'SELECT id, email, name FROM users WHERE id = $1',
        [decoded.userId]
      );
      
      if (result.rows.length === 0) {
        return res.status(401).json({
          error: {
            message: 'Invalid token',
            code: 'INVALID_TOKEN'
          }
        });
      }
      
      const user = result.rows[0];
      
      // Generate new token
      const newToken = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET || 'default-secret-key',
        { expiresIn: '24h' }
      );
      
      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name
        },
        token: newToken
      });
    } catch (error) {
      logger.error('Token refresh error:', error);
      
      res.status(401).json({
        error: {
          message: 'Invalid token',
          code: 'INVALID_TOKEN'
        }
      });
    }
  });
  
  return router;
}; 