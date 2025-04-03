import { Router } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { logger } from '../../../utils/logger';
import { authenticateUser } from '../../../middleware/auth';

/**
 * Create workout router
 */
export const createWorkoutRouter = (pool: Pool, redis: Redis): Router => {
  const router = Router();
  
  // Require authentication for all workout routes
  router.use(authenticateUser);
  
  /**
   * Get user's workouts
   */
  router.get('/', async (req, res) => {
    try {
      const userId = req.user?.id;
      const { programId, completed, startDate, endDate } = req.query;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      // Build query conditions
      const conditions: string[] = ['w.user_id = $1'];
      const values: any[] = [userId];
      let paramCount = 2;
      
      if (programId) {
        conditions.push(`w.program_id = $${paramCount}`);
        values.push(programId);
        paramCount++;
      }
      
      if (completed !== undefined) {
        conditions.push(`w.completed = $${paramCount}`);
        values.push(completed === 'true');
        paramCount++;
      }
      
      if (startDate) {
        conditions.push(`w.date >= $${paramCount}`);
        values.push(startDate);
        paramCount++;
      }
      
      if (endDate) {
        conditions.push(`w.date <= $${paramCount}`);
        values.push(endDate);
        paramCount++;
      }
      
      const result = await pool.query(
        `SELECT 
          w.*,
          p.name as program_name
        FROM workouts w
        LEFT JOIN training_programs p ON p.id = w.program_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY w.date DESC`,
        values
      );
      
      res.json({
        workouts: result.rows
      });
    } catch (error) {
      logger.error('Get workouts error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get workouts',
          code: 'WORKOUTS_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Create a new workout
   */
  router.post('/', async (req, res) => {
    try {
      const userId = req.user?.id;
      const { programId, name, description, date, exercises } = req.body;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      // Validate input
      if (!name || !date) {
        return res.status(400).json({
          error: {
            message: 'Missing required fields',
            code: 'MISSING_FIELDS'
          }
        });
      }
      
      // Validate date
      const workoutDate = new Date(date);
      if (isNaN(workoutDate.getTime())) {
        return res.status(400).json({
          error: {
            message: 'Invalid date format',
            code: 'INVALID_DATE_FORMAT'
          }
        });
      }
      
      // If program ID is provided, verify it belongs to user
      if (programId) {
        const program = await pool.query(
          'SELECT id FROM training_programs WHERE id = $1 AND user_id = $2',
          [programId, userId]
        );
        
        if (program.rows.length === 0) {
          return res.status(404).json({
            error: {
              message: 'Training program not found',
              code: 'PROGRAM_NOT_FOUND'
            }
          });
        }
      }
      
      // Start transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        // Create workout
        const workoutResult = await client.query(
          `INSERT INTO workouts (
            user_id,
            program_id,
            name,
            description,
            date
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *`,
          [userId, programId, name, description, date]
        );
        
        const workout = workoutResult.rows[0];
        
        // Add exercises if provided
        if (exercises && Array.isArray(exercises)) {
          for (const exercise of exercises) {
            await client.query(
              `INSERT INTO workout_exercises (
                workout_id,
                name,
                sets,
                reps,
                weight,
                notes
              ) VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                workout.id,
                exercise.name,
                exercise.sets,
                exercise.reps,
                exercise.weight,
                exercise.notes
              ]
            );
          }
        }
        
        await client.query('COMMIT');
        
        // Get complete workout with exercises
        const result = await pool.query(
          `SELECT 
            w.*,
            json_agg(
              json_build_object(
                'id', e.id,
                'name', e.name,
                'sets', e.sets,
                'reps', e.reps,
                'weight', e.weight,
                'notes', e.notes
              )
            ) as exercises
          FROM workouts w
          LEFT JOIN workout_exercises e ON e.workout_id = w.id
          WHERE w.id = $1
          GROUP BY w.id`,
          [workout.id]
        );
        
        res.status(201).json({
          workout: result.rows[0]
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Create workout error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to create workout',
          code: 'WORKOUT_CREATE_FAILED'
        }
      });
    }
  });
  
  /**
   * Get a specific workout
   */
  router.get('/:id', async (req, res) => {
    try {
      const userId = req.user?.id;
      const workoutId = req.params.id;
      
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
          w.*,
          json_agg(
            json_build_object(
              'id', e.id,
              'name', e.name,
              'sets', e.sets,
              'reps', e.reps,
              'weight', e.weight,
              'notes', e.notes
            )
          ) as exercises
        FROM workouts w
        LEFT JOIN workout_exercises e ON e.workout_id = w.id
        WHERE w.id = $1 AND w.user_id = $2
        GROUP BY w.id`,
        [workoutId, userId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            message: 'Workout not found',
            code: 'WORKOUT_NOT_FOUND'
          }
        });
      }
      
      res.json({
        workout: result.rows[0]
      });
    } catch (error) {
      logger.error('Get workout error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get workout',
          code: 'WORKOUT_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Update a workout
   */
  router.put('/:id', async (req, res) => {
    try {
      const userId = req.user?.id;
      const workoutId = req.params.id;
      const { name, description, date, completed, exercises } = req.body;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      // Check if workout exists and belongs to user
      const existingWorkout = await pool.query(
        'SELECT id FROM workouts WHERE id = $1 AND user_id = $2',
        [workoutId, userId]
      );
      
      if (existingWorkout.rows.length === 0) {
        return res.status(404).json({
          error: {
            message: 'Workout not found',
            code: 'WORKOUT_NOT_FOUND'
          }
        });
      }
      
      // Start transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        // Update workout
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
        
        if (date) {
          updates.push(`date = $${paramCount}`);
          values.push(date);
          paramCount++;
        }
        
        if (completed !== undefined) {
          updates.push(`completed = $${paramCount}`);
          values.push(completed);
          paramCount++;
        }
        
        if (updates.length > 0) {
          updates.push('updated_at = NOW()');
          values.push(workoutId);
          values.push(userId);
          
          await client.query(
            `UPDATE workouts 
            SET ${updates.join(', ')} 
            WHERE id = $${paramCount} AND user_id = $${paramCount + 1}`,
            values
          );
        }
        
        // Update exercises if provided
        if (exercises && Array.isArray(exercises)) {
          // Delete existing exercises
          await client.query(
            'DELETE FROM workout_exercises WHERE workout_id = $1',
            [workoutId]
          );
          
          // Add new exercises
          for (const exercise of exercises) {
            await client.query(
              `INSERT INTO workout_exercises (
                workout_id,
                name,
                sets,
                reps,
                weight,
                notes
              ) VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                workoutId,
                exercise.name,
                exercise.sets,
                exercise.reps,
                exercise.weight,
                exercise.notes
              ]
            );
          }
        }
        
        await client.query('COMMIT');
        
        // Get updated workout with exercises
        const result = await pool.query(
          `SELECT 
            w.*,
            json_agg(
              json_build_object(
                'id', e.id,
                'name', e.name,
                'sets', e.sets,
                'reps', e.reps,
                'weight', e.weight,
                'notes', e.notes
              )
            ) as exercises
          FROM workouts w
          LEFT JOIN workout_exercises e ON e.workout_id = w.id
          WHERE w.id = $1
          GROUP BY w.id`,
          [workoutId]
        );
        
        res.json({
          workout: result.rows[0]
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Update workout error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to update workout',
          code: 'WORKOUT_UPDATE_FAILED'
        }
      });
    }
  });
  
  /**
   * Delete a workout
   */
  router.delete('/:id', async (req, res) => {
    try {
      const userId = req.user?.id;
      const workoutId = req.params.id;
      
      if (!userId) {
        return res.status(401).json({
          error: {
            message: 'Unauthorized',
            code: 'UNAUTHORIZED'
          }
        });
      }
      
      // Check if workout exists and belongs to user
      const existingWorkout = await pool.query(
        'SELECT id FROM workouts WHERE id = $1 AND user_id = $2',
        [workoutId, userId]
      );
      
      if (existingWorkout.rows.length === 0) {
        return res.status(404).json({
          error: {
            message: 'Workout not found',
            code: 'WORKOUT_NOT_FOUND'
          }
        });
      }
      
      // Delete workout (cascade will handle exercises)
      await pool.query(
        'DELETE FROM workouts WHERE id = $1 AND user_id = $2',
        [workoutId, userId]
      );
      
      res.status(204).send();
    } catch (error) {
      logger.error('Delete workout error:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to delete workout',
          code: 'WORKOUT_DELETE_FAILED'
        }
      });
    }
  });
  
  return router;
}; 