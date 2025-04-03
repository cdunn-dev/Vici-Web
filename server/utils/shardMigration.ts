import { Pool } from 'pg';
import { logger } from './logger';
import { ShardingService } from '../services/sharding';

export class ShardMigration {
  private shardingService: ShardingService;

  constructor() {
    this.shardingService = ShardingService.getInstance();
  }

  public async createShardTables(shardId: number): Promise<void> {
    const pool = await this.shardingService.getShardPool(shardId);
    
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          email_verified BOOLEAN DEFAULT FALSE,
          reset_token VARCHAR(64),
          reset_token_expires TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS training_plans (
          id VARCHAR(36) PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id),
          name VARCHAR(255) NOT NULL,
          description TEXT,
          start_date TIMESTAMP NOT NULL,
          end_date TIMESTAMP NOT NULL,
          status VARCHAR(20) NOT NULL,
          type VARCHAR(20) NOT NULL,
          difficulty VARCHAR(20) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS workout_notes (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id),
          workout_id VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          type VARCHAR(20) NOT NULL,
          rating INTEGER,
          tags TEXT[],
          metrics JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_training_plans_user_id ON training_plans(user_id);
        CREATE INDEX IF NOT EXISTS idx_workout_notes_user_id ON workout_notes(user_id);
        CREATE INDEX IF NOT EXISTS idx_workout_notes_workout_id ON workout_notes(workout_id);
      `);

      logger.info(`Created tables for shard ${shardId}`);
    } catch (error) {
      logger.error(`Failed to create tables for shard ${shardId}:`, error);
      throw error;
    }
  }

  public async migrateUserData(
    userId: number,
    sourcePool: Pool,
    targetPool: Pool
  ): Promise<void> {
    const client = await targetPool.connect();
    
    try {
      await client.query('BEGIN');

      // Migrate user
      const userResult = await sourcePool.query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
      );
      
      if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        await client.query(
          `INSERT INTO users (id, email, password, email_verified, reset_token, reset_token_expires, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING`,
          [
            user.id,
            user.email,
            user.password,
            user.email_verified,
            user.reset_token,
            user.reset_token_expires,
            user.created_at,
            user.updated_at
          ]
        );
      }

      // Migrate training plans
      const plansResult = await sourcePool.query(
        'SELECT * FROM training_plans WHERE user_id = $1',
        [userId]
      );
      
      for (const plan of plansResult.rows) {
        await client.query(
          `INSERT INTO training_plans (id, user_id, name, description, start_date, end_date, status, type, difficulty, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [
            plan.id,
            plan.user_id,
            plan.name,
            plan.description,
            plan.start_date,
            plan.end_date,
            plan.status,
            plan.type,
            plan.difficulty,
            plan.created_at,
            plan.updated_at
          ]
        );
      }

      // Migrate workout notes
      const notesResult = await sourcePool.query(
        'SELECT * FROM workout_notes WHERE user_id = $1',
        [userId]
      );
      
      for (const note of notesResult.rows) {
        await client.query(
          `INSERT INTO workout_notes (id, user_id, workout_id, content, type, rating, tags, metrics, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO NOTHING`,
          [
            note.id,
            note.user_id,
            note.workout_id,
            note.content,
            note.type,
            note.rating,
            note.tags,
            note.metrics,
            note.created_at,
            note.updated_at
          ]
        );
      }

      await client.query('COMMIT');
      logger.info(`Successfully migrated data for user ${userId}`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to migrate data for user ${userId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  public async verifyMigration(
    userId: number,
    sourcePool: Pool,
    targetPool: Pool
  ): Promise<boolean> {
    try {
      // Verify user data
      const sourceUser = await sourcePool.query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
      );
      const targetUser = await targetPool.query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
      );

      if (sourceUser.rows.length !== targetUser.rows.length) {
        return false;
      }

      // Verify training plans
      const sourcePlans = await sourcePool.query(
        'SELECT COUNT(*) FROM training_plans WHERE user_id = $1',
        [userId]
      );
      const targetPlans = await targetPool.query(
        'SELECT COUNT(*) FROM training_plans WHERE user_id = $1',
        [userId]
      );

      if (sourcePlans.rows[0].count !== targetPlans.rows[0].count) {
        return false;
      }

      // Verify workout notes
      const sourceNotes = await sourcePool.query(
        'SELECT COUNT(*) FROM workout_notes WHERE user_id = $1',
        [userId]
      );
      const targetNotes = await targetPool.query(
        'SELECT COUNT(*) FROM workout_notes WHERE user_id = $1',
        [userId]
      );

      if (sourceNotes.rows[0].count !== targetNotes.rows[0].count) {
        return false;
      }

      return true;
    } catch (error) {
      logger.error(`Failed to verify migration for user ${userId}:`, error);
      return false;
    }
  }
} 