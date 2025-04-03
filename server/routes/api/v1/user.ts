import { Router } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { logger } from '../../../utils/logger';
import { authenticateUser } from '../../../middleware/auth';

/**
 * Create user router
 */
export const createUserRouter = (pool: Pool, redis: Redis): Router => {
  const router = Router();
  
  // Require authentication for all user routes
  router.use(authenticateUser);
  
  /**
   * Get current user profile
   */
  router.get('/me', async (req, res) => {
    try {
      const userId = req.user?.id;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      const result = await pool.query(
        'SELECT id, email, name, created_at, updated_at FROM users WHERE id = $1',
        [userId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            message: 'User not found',
            code: 'USER_NOT_FOUND'
          }
        });
      }
      
      res.json({
        user: result.rows[0]
      });
    } catch (error) {
      logger.error('Get user profile error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get user profile',
          code: 'PROFILE_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Update user profile
   */
  router.put('/me', async (req, res) => {
    try {
      const userId = req.user?.id;
      const { name, email } = req.body;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      // Validate input
      if (!name && !email) {
        return res.status(400).json({
          error: {
            message: 'No fields to update',
            code: 'NO_FIELDS_TO_UPDATE'
          }
        });
      }
      
      // Check if email is already taken
      if (email) {
        const existingUser = await pool.query(
          'SELECT id FROM users WHERE email = $1 AND id != $2',
          [email, userId]
        );
        
        if (existingUser.rows.length > 0) {
          return res.status(409).json({
            error: {
              message: 'Email already in use',
              code: 'EMAIL_IN_USE'
            }
          });
        }
      }
      
      // Build update query
      const updates: string[] = [];
      const values: any[] = [];
      let paramCount = 1;
      
      if (name) {
        updates.push(`name = $${paramCount}`);
        values.push(name);
        paramCount++;
      }
      
      if (email) {
        updates.push(`email = $${paramCount}`);
        values.push(email);
        paramCount++;
      }
      
      // Add updated_at timestamp
      updates.push(`updated_at = NOW()`);
      
      // Add user ID to values
      values.push(userId);
      
      const result = await pool.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, email, name, created_at, updated_at`,
        values
      );
      
      res.json({
        user: result.rows[0]
      });
    } catch (error) {
      logger.error('Update user profile error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to update user profile',
          code: 'PROFILE_UPDATE_FAILED'
        }
      });
    }
  });
  
  /**
   * Change password
   */
  router.put('/me/password', async (req, res) => {
    try {
      const userId = req.user?.id;
      const { currentPassword, newPassword } = req.body;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      // Validate input
      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          error: {
            message: 'Missing required fields',
            code: 'MISSING_FIELDS'
          }
        });
      }
      
      // Get user with current password
      const result = await pool.query(
        'SELECT password FROM users WHERE id = $1',
        [userId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            message: 'User not found',
            code: 'USER_NOT_FOUND'
          }
        });
      }
      
      const user = result.rows[0];
      
      // Verify current password
      const bcrypt = require('bcrypt');
      const passwordMatch = await bcrypt.compare(currentPassword, user.password);
      
      if (!passwordMatch) {
        return res.status(401).json({
          error: {
            message: 'Current password is incorrect',
            code: 'INCORRECT_PASSWORD'
          }
        });
      }
      
      // Hash new password
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
      
      // Update password
      await pool.query(
        'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
        [hashedPassword, userId]
      );
      
      res.json({
        message: 'Password updated successfully'
      });
    } catch (error) {
      logger.error('Change password error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to change password',
          code: 'PASSWORD_CHANGE_FAILED'
        }
      });
    }
  });
  
  return router;
}; 