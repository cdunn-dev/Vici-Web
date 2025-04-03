import { Router } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { logger } from '../../../utils/logger';
import { authenticateUser } from '../../../middleware/auth';

/**
 * Create training router
 */
export const createTrainingRouter = (pool: Pool, redis: Redis): Router => {
  const router = Router();
  
  // Require authentication for all training routes
  router.use(authenticateUser);
  
  /**
   * Get user's training programs
   */
  router.get('/programs', async (req, res) => {
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
        `SELECT 
          p.id,
          p.name,
          p.description,
          p.start_date,
          p.end_date,
          p.created_at,
          p.updated_at,
          COUNT(w.id) as workout_count
        FROM training_programs p
        LEFT JOIN workouts w ON w.program_id = p.id
        WHERE p.user_id = $1
        GROUP BY p.id
        ORDER BY p.start_date DESC`,
        [userId]
      );
      
      res.json({
        programs: result.rows
      });
    } catch (error) {
      logger.error('Get training programs error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get training programs',
          code: 'PROGRAMS_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Create a new training program
   */
  router.post('/programs', async (req, res) => {
    try {
      const userId = req.user?.id;
      const { name, description, startDate, endDate } = req.body;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      // Validate input
      if (!name || !startDate || !endDate) {
        return res.status(400).json({
          error: {
            message: 'Missing required fields',
            code: 'MISSING_FIELDS'
          }
        });
      }
      
      // Validate dates
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({
          error: {
            message: 'Invalid date format',
            code: 'INVALID_DATE_FORMAT'
          }
        });
      }
      
      if (end < start) {
        return res.status(400).json({
          error: {
            message: 'End date must be after start date',
            code: 'INVALID_DATE_RANGE'
          }
        });
      }
      
      const result = await pool.query(
        `INSERT INTO training_programs (
          user_id,
          name,
          description,
          start_date,
          end_date
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, description, start_date, end_date, created_at, updated_at`,
        [userId, name, description, startDate, endDate]
      );
      
      res.status(201).json({
        program: result.rows[0]
      });
    } catch (error) {
      logger.error('Create training program error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to create training program',
          code: 'PROGRAM_CREATE_FAILED'
        }
      });
    }
  });
  
  /**
   * Get a specific training program
   */
  router.get('/programs/:id', async (req, res) => {
    try {
      const userId = req.user?.id;
      const programId = req.params.id;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      const result = await pool.query(
        `SELECT 
          p.*,
          json_agg(
            json_build_object(
              'id', w.id,
              'name', w.name,
              'description', w.description,
              'date', w.date,
              'completed', w.completed
            )
          ) as workouts
        FROM training_programs p
        LEFT JOIN workouts w ON w.program_id = p.id
        WHERE p.id = $1 AND p.user_id = $2
        GROUP BY p.id`,
        [programId, userId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            message: 'Training program not found',
            code: 'PROGRAM_NOT_FOUND'
          }
        });
      }
      
      res.json({
        program: result.rows[0]
      });
    } catch (error) {
      logger.error('Get training program error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get training program',
          code: 'PROGRAM_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Update a training program
   */
  router.put('/programs/:id', async (req, res) => {
    try {
      const userId = req.user?.id;
      const programId = req.params.id;
      const { name, description, startDate, endDate } = req.body;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      // Check if program exists and belongs to user
      const existingProgram = await pool.query(
        'SELECT id FROM training_programs WHERE id = $1 AND user_id = $2',
        [programId, userId]
      );
      
      if (existingProgram.rows.length === 0) {
        return res.status(404).json({
          error: {
            message: 'Training program not found',
            code: 'PROGRAM_NOT_FOUND'
          }
        });
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
      
      if (description !== undefined) {
        updates.push(`description = $${paramCount}`);
        values.push(description);
        paramCount++;
      }
      
      if (startDate) {
        updates.push(`start_date = $${paramCount}`);
        values.push(startDate);
        paramCount++;
      }
      
      if (endDate) {
        updates.push(`end_date = $${paramCount}`);
        values.push(endDate);
        paramCount++;
      }
      
      if (updates.length === 0) {
        return res.status(400).json({
          error: {
            message: 'No fields to update',
            code: 'NO_FIELDS_TO_UPDATE'
          }
        });
      }
      
      // Add updated_at timestamp
      updates.push('updated_at = NOW()');
      
      // Add program ID and user ID to values
      values.push(programId);
      values.push(userId);
      
      const result = await pool.query(
        `UPDATE training_programs 
        SET ${updates.join(', ')} 
        WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
        RETURNING id, name, description, start_date, end_date, created_at, updated_at`,
        values
      );
      
      res.json({
        program: result.rows[0]
      });
    } catch (error) {
      logger.error('Update training program error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to update training program',
          code: 'PROGRAM_UPDATE_FAILED'
        }
      });
    }
  });
  
  /**
   * Delete a training program
   */
  router.delete('/programs/:id', async (req, res) => {
    try {
      const userId = req.user?.id;
      const programId = req.params.id;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      // Check if program exists and belongs to user
      const existingProgram = await pool.query(
        'SELECT id FROM training_programs WHERE id = $1 AND user_id = $2',
        [programId, userId]
      );
      
      if (existingProgram.rows.length === 0) {
        return res.status(404).json({
          error: {
            message: 'Training program not found',
            code: 'PROGRAM_NOT_FOUND'
          }
        });
      }
      
      // Delete program (cascade will handle related workouts)
      await pool.query(
        'DELETE FROM training_programs WHERE id = $1 AND user_id = $2',
        [programId, userId]
      );
      
      res.status(204).send();
    } catch (error) {
      logger.error('Delete training program error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to delete training program',
          code: 'PROGRAM_DELETE_FAILED'
        }
      });
    }
  });
  
  return router;
}; 