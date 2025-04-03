import {
  users,
  trainingPlans,
  workoutNotes,
} from "./db/schema";
import { ShardingService } from "./services/sharding";
import { eq, desc, and, or, lt, gt } from "drizzle-orm";
import session from "express-session";
import createMemoryStore from "memorystore";
import { InferModel } from "drizzle-orm";
import { RedisService } from './services/redis';
import { Pool } from 'pg';

// Create memory store with proper typing
const MemoryStore = createMemoryStore(session);
type MemoryStoreType = ReturnType<typeof createMemoryStore>;

// Define types based on schema
type User = typeof users.$inferSelect;
type InsertUser = typeof users.$inferInsert;
type TrainingPlan = typeof trainingPlans.$inferSelect;
type InsertTrainingPlan = typeof trainingPlans.$inferInsert;
type WorkoutNote = typeof workoutNotes.$inferSelect;
type InsertWorkoutNote = typeof workoutNotes.$inferInsert;

// Add validation types
interface BackupValidationError {
  field: string;
  message: string;
}

interface BackupValidationResult {
  isValid: boolean;
  errors: BackupValidationError[];
}

interface WorkoutMetrics {
  perceivedEffort?: number;
  energyLevel?: number;
  sleepQuality?: number;
  nutritionQuality?: number;
  stressLevel?: number;
  recoveryStatus?: number;
}

export interface IStorage {
  // User operations
  getUser(email: string): Promise<User | null>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(userId: number, updates: Partial<InsertUser>): Promise<User>;
  storeResetToken(email: string, token: string, expiresAt: Date): Promise<void>;
  getResetToken(email: string): Promise<{ token: string; expiresAt: Date } | null>;
  updateUserPassword(userId: number, hashedPassword: string): Promise<void>;
  removeResetToken(email: string): Promise<void>;

  // Training plan operations
  getTrainingPlans(userId: number, active?: boolean): Promise<TrainingPlan[]>;
  getTrainingPlan(id: string): Promise<TrainingPlan | null>;
  createTrainingPlan(plan: InsertTrainingPlan): Promise<TrainingPlan>;
  updateTrainingPlan(id: string, updates: Partial<InsertTrainingPlan>): Promise<TrainingPlan>;
  deleteTrainingPlan(id: string): Promise<void>;

  // Workout notes operations
  getWorkoutNotes(userId: number, workoutId?: string): Promise<WorkoutNote[]>;
  getWorkoutNote(id: string): Promise<WorkoutNote | null>;
  createWorkoutNote(note: InsertWorkoutNote): Promise<WorkoutNote>;
  updateWorkoutNote(id: string, updates: Partial<InsertWorkoutNote>): Promise<WorkoutNote>;
  deleteWorkoutNote(id: string): Promise<void>;

  // Session store
  sessionStore: session.Store;

  // New methods
  getAllUsers(): Promise<User[]>;
  getAllTrainingPlans(): Promise<TrainingPlan[]>;
  getAllWorkoutNotes(): Promise<WorkoutNote[]>;
}

export class DatabaseStorage implements IStorage {
  public sessionStore: session.Store;
  private redis: RedisService;
  private sharding: ShardingService;
  private readonly CACHE_TTL = 3600; // 1 hour in seconds

  constructor() {
    this.redis = RedisService.getInstance();
    this.sharding = ShardingService.getInstance();
    // Switch to memory store temporarily to isolate database issues
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000 // Clear expired entries every 24h
    });
  }

  private getCacheKey(type: string, id: string | number): string {
    return `${type}:${id}`;
  }

  private async getFromCache<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    return value as T | null;
  }

  private async setInCache(key: string, value: any, ttl?: number): Promise<void> {
    await this.redis.set(key, value, ttl ?? this.CACHE_TTL);
  }

  private async invalidateCache(key: string): Promise<void> {
    await this.redis.delete(key);
  }

  private async invalidatePattern(pattern: string): Promise<void> {
    await this.redis.deletePattern(pattern);
  }

  async getUser(email: string): Promise<User | null> {
    const cacheKey = this.getCacheKey('user:email', email);
    const cachedUser = await this.getFromCache<User>(cacheKey);
    
    if (cachedUser) {
      return cachedUser;
    }

    // Query all shards for the user
    const shards = await this.sharding.healthCheck();
    for (const [shardId, isHealthy] of shards) {
      if (isHealthy) {
        const pool = await this.sharding.getShardPool(shardId);
        const result = await pool.query(
          'SELECT * FROM users WHERE email = $1 LIMIT 1',
          [email]
        );
        
        if (result.rows.length > 0) {
          const user = result.rows[0];
          await this.setInCache(cacheKey, user);
          return user;
        }
      }
    }
    
    return null;
  }

  async createUser(user: InsertUser): Promise<User> {
    const pool = await this.sharding.getShardPool(user.id ?? 0);
    const result = await pool.query(
      `INSERT INTO users (email, password, email_verified, reset_token, reset_token_expires, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user.email,
        user.password,
        user.emailVerified,
        user.resetToken,
        user.resetTokenExpires
      ]
    );
    
    const newUser = result.rows[0];
    await this.setInCache(this.getCacheKey('user:email', newUser.email), newUser);
    
    return newUser;
  }

  async updateUser(userId: number, updates: Partial<InsertUser>): Promise<User> {
    const pool = await this.sharding.getShardPool(userId);
    const setClause = Object.entries(updates)
      .map((_, index) => `${Object.keys(updates)[index]} = $${index + 1}`)
      .join(', ');
    
    const values = Object.values(updates);
    values.push(userId);
    
    const result = await pool.query(
      `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );
    
    const updatedUser = result.rows[0];
    
    if (updates.email) {
      await this.invalidateCache(this.getCacheKey('user:email', updates.email));
    }
    
    return updatedUser;
  }

  async storeResetToken(email: string, token: string, expiresAt: Date): Promise<void> {
    const pool = await this.sharding.getShardPool(0); // Assuming user ID 0 for reset token update
    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE email = $3',
      [token, expiresAt, email]
    );
    
    // Invalidate user cache since we modified the user
    await this.invalidateCache(this.getCacheKey('user:email', email));
  }

  async getResetToken(email: string): Promise<{ token: string; expiresAt: Date } | null> {
    const cacheKey = this.getCacheKey('resetToken', email);
    const cachedToken = await this.getFromCache<{ token: string; expiresAt: Date }>(cacheKey);
    
    if (cachedToken) {
      return cachedToken;
    }

    const pool = await this.sharding.getShardPool(0); // Assuming user ID 0 for reset token retrieval
    const result = await pool.query(
      'SELECT reset_token, reset_token_expires FROM users WHERE email = $1 LIMIT 1',
      [email]
    );

    if (!result.rows[0]?.reset_token || !result.rows[0]?.reset_token_expires) {
      return null;
    }

    const tokenData = {
      token: result.rows[0].reset_token,
      expiresAt: result.rows[0].reset_token_expires
    };
    
    await this.setInCache(cacheKey, tokenData, 3600); // Cache for 1 hour
    return tokenData;
  }

  async updateUserPassword(userId: number, hashedPassword: string): Promise<void> {
    const pool = await this.sharding.getShardPool(userId);
    await pool.query(
      'UPDATE users SET password = $1 WHERE id = $2',
      [hashedPassword, userId]
    );
    
    // Invalidate user cache since we modified the user
    const result = await pool.query(
      'SELECT email FROM users WHERE id = $1 LIMIT 1',
      [userId]
    );
    if (result.rows.length > 0) {
      await this.invalidateCache(this.getCacheKey('user:email', result.rows[0].email));
    }
  }

  async removeResetToken(email: string): Promise<void> {
    const pool = await this.sharding.getShardPool(0); // Assuming user ID 0 for reset token removal
    await pool.query(
      'UPDATE users SET reset_token = null, reset_token_expires = null WHERE email = $1',
      [email]
    );
    
    // Invalidate both user cache and reset token cache
    await this.invalidateCache(this.getCacheKey('user:email', email));
    await this.invalidateCache(this.getCacheKey('resetToken', email));
  }

  async getTrainingPlans(userId: number, active?: boolean): Promise<TrainingPlan[]> {
    const cacheKey = this.getCacheKey('trainingPlans:user', `${userId}:${active ?? 'all'}`);
    const cachedPlans = await this.getFromCache<TrainingPlan[]>(cacheKey);
    
    if (cachedPlans) {
      return cachedPlans;
    }

    const pool = await this.sharding.getShardPool(userId);
    const result = await pool.query(
      'SELECT * FROM training_plans WHERE user_id = $1 AND ($2::boolean IS NULL OR status = $3) ORDER BY start_date DESC',
      [userId, active !== undefined, active ? 'active' : 'completed']
    );
    
    await this.setInCache(cacheKey, result.rows);
    return result.rows;
  }

  async getTrainingPlan(id: string): Promise<TrainingPlan | null> {
    const cacheKey = this.getCacheKey('trainingPlan', id);
    const cachedPlan = await this.getFromCache<TrainingPlan>(cacheKey);
    
    if (cachedPlan) {
      return cachedPlan;
    }

    const pool = await this.sharding.getShardPool(0); // Assuming shard 0 for training plan retrieval
    const result = await pool.query(
      'SELECT * FROM training_plans WHERE id = $1 LIMIT 1',
      [id]
    );
    const plan = result.rows[0] || null;
    
    if (plan) {
      await this.setInCache(cacheKey, plan);
    }
    
    return plan;
  }

  async createTrainingPlan(plan: InsertTrainingPlan): Promise<TrainingPlan> {
    const pool = await this.sharding.getShardPool(plan.userId);
    const result = await pool.query(
      `INSERT INTO training_plans (user_id, name, description, start_date, end_date, status, type, difficulty, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        plan.userId,
        plan.name,
        plan.description,
        plan.startDate,
        plan.endDate,
        plan.status,
        plan.type,
        plan.difficulty
      ]
    );
    const newPlan = result.rows[0];
    
    // Invalidate user's training plans cache
    await this.invalidatePattern(`trainingPlans:user:${newPlan.userId}:*`);
    
    return newPlan;
  }

  async updateTrainingPlan(id: string, updates: Partial<InsertTrainingPlan>): Promise<TrainingPlan> {
    const pool = await this.sharding.getShardPool(0); // Assuming shard 0 for training plan update
    const setClause = Object.entries(updates)
      .map((_, index) => `${Object.keys(updates)[index]} = $${index + 1}`)
      .join(', ');
    
    const values = Object.values(updates);
    values.push(id);
    
    const result = await pool.query(
      `UPDATE training_plans SET ${setClause}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );
    
    const updatedPlan = result.rows[0];
    
    // Invalidate both the specific plan cache and user's training plans cache
    await this.invalidateCache(this.getCacheKey('trainingPlan', id));
    await this.invalidatePattern(`trainingPlans:user:${updatedPlan.userId}:*`);
    
    return updatedPlan;
  }

  async deleteTrainingPlan(id: string): Promise<void> {
    const plan = await this.getTrainingPlan(id);
    if (plan) {
      const pool = await this.sharding.getShardPool(plan.userId);
      await pool.query(
        'DELETE FROM training_plans WHERE id = $1',
        [id]
      );
      
      // Invalidate both the specific plan cache and user's training plans cache
      await this.invalidateCache(this.getCacheKey('trainingPlan', id));
      await this.invalidatePattern(`trainingPlans:user:${plan.userId}:*`);
    }
  }

  async getWorkoutNotes(userId: number, workoutId?: string): Promise<WorkoutNote[]> {
    const cacheKey = this.getCacheKey('workoutNotes:user', `${userId}:${workoutId ?? 'all'}`);
    const cachedNotes = await this.getFromCache<WorkoutNote[]>(cacheKey);
    
    if (cachedNotes) {
      return cachedNotes;
    }

    const pool = await this.sharding.getShardPool(userId);
    const result = await pool.query(
      'SELECT * FROM workout_notes WHERE user_id = $1 AND ($2::text IS NULL OR workout_id = $2) ORDER BY created_at DESC',
      [userId, workoutId]
    );
    
    await this.setInCache(cacheKey, result.rows);
    return result.rows;
  }

  async getWorkoutNote(id: string): Promise<WorkoutNote | null> {
    const cacheKey = this.getCacheKey('workoutNote', id);
    const cachedNote = await this.getFromCache<WorkoutNote>(cacheKey);
    
    if (cachedNote) {
      return cachedNote;
    }

    const pool = await this.sharding.getShardPool(0); // Assuming shard 0 for workout note retrieval
    const result = await pool.query(
      'SELECT * FROM workout_notes WHERE id = $1 LIMIT 1',
      [parseInt(id)]
    );
    
    const note = result.rows[0] || null;
    if (note) {
      await this.setInCache(cacheKey, note);
    }
    
    return note;
  }

  async createWorkoutNote(note: InsertWorkoutNote): Promise<WorkoutNote> {
    const pool = await this.sharding.getShardPool(note.userId);
    const result = await pool.query(
      `INSERT INTO workout_notes (user_id, workout_id, content, type, rating, tags, metrics, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        note.userId,
        note.workoutId,
        note.content,
        note.type,
        note.rating,
        note.tags,
        note.metrics
      ]
    );
    const newNote = result.rows[0];
    
    // Invalidate user's workout notes cache
    await this.invalidatePattern(`workoutNotes:user:${newNote.userId}:*`);
    
    return newNote;
  }

  async updateWorkoutNote(id: string, updates: Partial<InsertWorkoutNote>): Promise<WorkoutNote> {
    const pool = await this.sharding.getShardPool(0); // Assuming shard 0 for workout note update
    const setClause = Object.entries(updates)
      .map((_, index) => `${Object.keys(updates)[index]} = $${index + 1}`)
      .join(', ');
    
    const values = Object.values(updates);
    values.push(parseInt(id));
    
    const result = await pool.query(
      `UPDATE workout_notes SET ${setClause}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );
    
    const updatedNote = result.rows[0];
    
    // Invalidate both the specific note cache and user's notes cache
    await this.invalidateCache(this.getCacheKey('workoutNote', id));
    await this.invalidatePattern(`workoutNotes:user:${updatedNote.userId}:*`);
    
    return updatedNote;
  }

  async deleteWorkoutNote(id: string): Promise<void> {
    const note = await this.getWorkoutNote(id);
    if (note) {
      const pool = await this.sharding.getShardPool(note.userId);
      await pool.query(
        'DELETE FROM workout_notes WHERE id = $1',
        [parseInt(id)]
      );
      
      // Invalidate both the specific note cache and user's notes cache
      await this.invalidateCache(this.getCacheKey('workoutNote', id));
      await this.invalidatePattern(`workoutNotes:user:${note.userId}:*`);
    }
  }

  async clearCache(): Promise<void> {
    await this.redis.clear();
  }

  async createBackup(): Promise<{
    users: User[];
    trainingPlans: TrainingPlan[];
    workoutNotes: WorkoutNote[];
  }> {
    try {
      const [backupUsers, backupTrainingPlans, backupWorkoutNotes] = await Promise.all([
        await this.getAllUsers(),
        await this.getAllTrainingPlans(),
        await this.getAllWorkoutNotes()
      ]);

      if (!backupUsers || !backupTrainingPlans || !backupWorkoutNotes) {
        throw new Error('Failed to retrieve data for backup');
      }

      return {
        users: backupUsers,
        trainingPlans: backupTrainingPlans,
        workoutNotes: backupWorkoutNotes
      };
    } catch (error) {
      console.error('Failed to create backup:', error);
      throw new Error('Failed to create backup: Database operation failed');
    }
  }

  private validateBackupData(backup: {
    users: User[];
    trainingPlans: TrainingPlan[];
    workoutNotes: WorkoutNote[];
  }): BackupValidationResult {
    const errors: BackupValidationError[] = [];

    // Type guards
    const isValidUserId = (id: number | null): id is number => {
      return id !== null && typeof id === 'number' && id > 0;
    };

    const isValidTrainingPlanId = (id: string | null): id is string => {
      return id !== null && typeof id === 'string' && id.length > 0;
    };

    const isValidWorkoutNoteId = (id: number | null): id is number => {
      return id !== null && typeof id === 'number' && id > 0;
    };

    const isValidEmail = (email: string): boolean => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(email);
    };

    const isValidDate = (date: Date): boolean => {
      return date instanceof Date && !isNaN(date.getTime());
    };

    const isValidDateRange = (startDate: Date, endDate: Date): boolean => {
      return startDate < endDate;
    };

    const isValidPassword = (password: string): boolean => {
      return password.length >= 8 && 
             /[A-Z]/.test(password) && 
             /[a-z]/.test(password) && 
             /[0-9]/.test(password) &&
             /[!@#$%^&*(),.?":{}|<>]/.test(password);
    };

    const isValidStringLength = (str: string, min: number, max: number): boolean => {
      return str.length >= min && str.length <= max;
    };

    const isValidUrl = (url: string): boolean => {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    };

    const isValidMetricValue = (value: number | undefined): boolean => {
      return value === undefined || (typeof value === 'number' && value >= 1 && value <= 10);
    };

    const isValidFutureDate = (date: Date): boolean => {
      return date > new Date();
    };

    const isValidPastDate = (date: Date): boolean => {
      return date < new Date();
    };

    const isValidTag = (tag: string): boolean => {
      return /^[a-zA-Z0-9\s-_]+$/.test(tag);
    };

    const isValidTrainingPlanDuration = (startDate: Date, endDate: Date): boolean => {
      const maxDuration = 365 * 24 * 60 * 60 * 1000; // 1 year in milliseconds
      return endDate.getTime() - startDate.getTime() <= maxDuration;
    };

    const isValidResetTokenFormat = (token: string): boolean => {
      return /^[a-zA-Z0-9-_]{32,64}$/.test(token);
    };

    const isValidWorkoutIdFormat = (id: string): boolean => {
      return /^[a-zA-Z0-9-_]+$/.test(id);
    };

    // Validate users
    if (!Array.isArray(backup.users)) {
      errors.push({ field: 'users', message: 'Users must be an array' });
    } else {
      // Check for duplicate emails
      const emailSet = new Set<string>();
      backup.users.forEach((user, index) => {
        const userPrefix = `users[${index}]`;
        
        // ID validation
        if (!isValidUserId(user.id)) {
          errors.push({ 
            field: `${userPrefix}.id`, 
            message: 'User ID must be a positive number' 
          });
        }

        // Email validation
        if (!user.email || typeof user.email !== 'string') {
          errors.push({ 
            field: `${userPrefix}.email`, 
            message: 'Email must be a string' 
          });
        } else {
          if (!isValidEmail(user.email)) {
            errors.push({ 
              field: `${userPrefix}.email`, 
              message: 'Invalid email format' 
            });
          } else if (!isValidStringLength(user.email, 3, 255)) {
            errors.push({ 
              field: `${userPrefix}.email`, 
              message: 'Email must be between 3 and 255 characters' 
            });
          } else if (emailSet.has(user.email.toLowerCase())) {
            errors.push({ 
              field: `${userPrefix}.email`, 
              message: 'Duplicate email address found' 
            });
          } else {
            emailSet.add(user.email.toLowerCase());
          }
        }

        // Password validation
        if (!user.password || typeof user.password !== 'string') {
          errors.push({ 
            field: `${userPrefix}.password`, 
            message: 'Password must be a string' 
          });
        } else if (!isValidPassword(user.password)) {
          errors.push({ 
            field: `${userPrefix}.password`, 
            message: 'Password must be at least 8 characters long and contain uppercase, lowercase, numbers, and special characters' 
          });
        }

        // Email verification status
        if (typeof user.emailVerified !== 'boolean' && user.emailVerified !== null) {
          errors.push({ 
            field: `${userPrefix}.emailVerified`, 
            message: 'Email verification status must be a boolean or null' 
          });
        }

        // Reset token validation
        if (user.resetToken && typeof user.resetToken !== 'string') {
          errors.push({ 
            field: `${userPrefix}.resetToken`, 
            message: 'Reset token must be a string or null' 
          });
        } else if (user.resetToken) {
          if (!isValidStringLength(user.resetToken, 32, 64)) {
            errors.push({ 
              field: `${userPrefix}.resetToken`, 
              message: 'Reset token must be between 32 and 64 characters' 
            });
          } else if (!isValidResetTokenFormat(user.resetToken)) {
            errors.push({ 
              field: `${userPrefix}.resetToken`, 
              message: 'Reset token must contain only letters, numbers, hyphens, and underscores' 
            });
          }
        }

        // Reset token expiration validation
        if (user.resetTokenExpires && !isValidDate(user.resetTokenExpires)) {
          errors.push({ 
            field: `${userPrefix}.resetTokenExpires`, 
            message: 'Reset token expiration must be a valid date or null' 
          });
        } else if (user.resetTokenExpires && !isValidFutureDate(user.resetTokenExpires)) {
          errors.push({ 
            field: `${userPrefix}.resetTokenExpires`, 
            message: 'Reset token expiration must be in the future' 
          });
        }
      });
    }

    // Validate training plans
    if (!Array.isArray(backup.trainingPlans)) {
      errors.push({ field: 'trainingPlans', message: 'Training plans must be an array' });
    } else {
      // Check for duplicate plan IDs
      const planIdSet = new Set<string>();
      backup.trainingPlans.forEach((plan, index) => {
        const planPrefix = `trainingPlans[${index}]`;
        
        // ID validation
        if (!isValidTrainingPlanId(plan.id)) {
          errors.push({ 
            field: `${planPrefix}.id`, 
            message: 'Plan ID must be a non-empty string' 
          });
        } else if (planIdSet.has(plan.id)) {
          errors.push({ 
            field: `${planPrefix}.id`, 
            message: 'Duplicate plan ID found' 
          });
        } else {
          planIdSet.add(plan.id);
        }

        // User ID validation
        if (!isValidUserId(plan.userId)) {
          errors.push({ 
            field: `${planPrefix}.userId`, 
            message: 'Plan user ID must be a positive number' 
          });
        }

        // Name validation
        if (!plan.name || typeof plan.name !== 'string') {
          errors.push({ 
            field: `${planPrefix}.name`, 
            message: 'Plan name must be a string' 
          });
        } else if (!isValidStringLength(plan.name, 1, 255)) {
          errors.push({ 
            field: `${planPrefix}.name`, 
            message: 'Plan name must be between 1 and 255 characters' 
          });
        }

        // Description validation
        if (plan.description && typeof plan.description !== 'string') {
          errors.push({ 
            field: `${planPrefix}.description`, 
            message: 'Plan description must be a string or null' 
          });
        } else if (plan.description && !isValidStringLength(plan.description, 1, 1000)) {
          errors.push({ 
            field: `${planPrefix}.description`, 
            message: 'Plan description must be between 1 and 1000 characters' 
          });
        }

        // Date validation
        if (!plan.startDate || !isValidDate(plan.startDate)) {
          errors.push({ 
            field: `${planPrefix}.startDate`, 
            message: 'Start date must be a valid date' 
          });
        } else if (!isValidFutureDate(plan.startDate)) {
          errors.push({ 
            field: `${planPrefix}.startDate`, 
            message: 'Start date must be in the future' 
          });
        }

        if (!plan.endDate || !isValidDate(plan.endDate)) {
          errors.push({ 
            field: `${planPrefix}.endDate`, 
            message: 'End date must be a valid date' 
          });
        }

        if (plan.startDate && plan.endDate) {
          if (!isValidDateRange(plan.startDate, plan.endDate)) {
            errors.push({ 
              field: `${planPrefix}.endDate`, 
              message: 'End date must be after start date' 
            });
          } else if (!isValidTrainingPlanDuration(plan.startDate, plan.endDate)) {
            errors.push({ 
              field: `${planPrefix}.endDate`, 
              message: 'Training plan duration cannot exceed 1 year' 
            });
          }
        }

        // Status validation
        if (!plan.status || typeof plan.status !== 'string') {
          errors.push({ 
            field: `${planPrefix}.status`, 
            message: 'Status must be a string' 
          });
        } else if (!['draft', 'active', 'completed'].includes(plan.status)) {
          errors.push({ 
            field: `${planPrefix}.status`, 
            message: 'Status must be one of: draft, active, completed' 
          });
        }

        // Type validation
        if (!plan.type || typeof plan.type !== 'string') {
          errors.push({ 
            field: `${planPrefix}.type`, 
            message: 'Type must be a string' 
          });
        } else if (!['5k', '10k', 'half', 'full', 'custom'].includes(plan.type)) {
          errors.push({ 
            field: `${planPrefix}.type`, 
            message: 'Type must be one of: 5k, 10k, half, full, custom' 
          });
        }

        // Difficulty validation
        if (!plan.difficulty || typeof plan.difficulty !== 'string') {
          errors.push({ 
            field: `${planPrefix}.difficulty`, 
            message: 'Difficulty must be a string' 
          });
        } else if (!['beginner', 'intermediate', 'advanced'].includes(plan.difficulty)) {
          errors.push({ 
            field: `${planPrefix}.difficulty`, 
            message: 'Difficulty must be one of: beginner, intermediate, advanced' 
          });
        }
      });
    }

    // Validate workout notes
    if (!Array.isArray(backup.workoutNotes)) {
      errors.push({ field: 'workoutNotes', message: 'Workout notes must be an array' });
    } else {
      // Check for duplicate note IDs
      const noteIdSet = new Set<number>();
      backup.workoutNotes.forEach((note, index) => {
        const notePrefix = `workoutNotes[${index}]`;
        
        // ID validation
        if (!isValidWorkoutNoteId(note.id)) {
          errors.push({ 
            field: `${notePrefix}.id`, 
            message: 'Note ID must be a positive number' 
          });
        } else if (noteIdSet.has(note.id)) {
          errors.push({ 
            field: `${notePrefix}.id`, 
            message: 'Duplicate note ID found' 
          });
        } else {
          noteIdSet.add(note.id);
        }

        // User ID validation
        if (!isValidUserId(note.userId)) {
          errors.push({ 
            field: `${notePrefix}.userId`, 
            message: 'Note user ID must be a positive number' 
          });
        }

        // Workout ID validation
        if (!note.workoutId || typeof note.workoutId !== 'string') {
          errors.push({ 
            field: `${notePrefix}.workoutId`, 
            message: 'Workout ID must be a string' 
          });
        } else {
          if (!isValidStringLength(note.workoutId, 1, 255)) {
            errors.push({ 
              field: `${notePrefix}.workoutId`, 
              message: 'Workout ID must be between 1 and 255 characters' 
            });
          } else if (!isValidWorkoutIdFormat(note.workoutId)) {
            errors.push({ 
              field: `${notePrefix}.workoutId`, 
              message: 'Workout ID can only contain letters, numbers, hyphens, and underscores' 
            });
          }
        }

        // Content validation
        if (!note.content || typeof note.content !== 'string') {
          errors.push({ 
            field: `${notePrefix}.content`, 
            message: 'Content must be a string' 
          });
        } else if (!isValidStringLength(note.content, 1, 10000)) {
          errors.push({ 
            field: `${notePrefix}.content`, 
            message: 'Content must be between 1 and 10000 characters' 
          });
        }

        // Type validation
        if (!note.type || typeof note.type !== 'string') {
          errors.push({ 
            field: `${notePrefix}.type`, 
            message: 'Type must be a string' 
          });
        } else if (!['note', 'feedback'].includes(note.type)) {
          errors.push({ 
            field: `${notePrefix}.type`, 
            message: 'Type must be either "note" or "feedback"' 
          });
        }

        // Rating validation for feedback
        if (note.type === 'feedback' && note.rating !== undefined) {
          if (typeof note.rating !== 'number' || note.rating < 1 || note.rating > 5) {
            errors.push({ 
              field: `${notePrefix}.rating`, 
              message: 'Rating must be a number between 1 and 5' 
            });
          }
        }

        // Tags validation
        const tags = note.tags as string[] | undefined;
        if (tags && !Array.isArray(tags)) {
          errors.push({ 
            field: `${notePrefix}.tags`, 
            message: 'Tags must be an array' 
          });
        } else if (tags && tags.length > 0) {
          if (tags.length > 10) {
            errors.push({ 
              field: `${notePrefix}.tags`, 
              message: 'Maximum of 10 tags allowed' 
            });
          } else {
            tags.forEach((tag: string, tagIndex: number) => {
              if (typeof tag !== 'string') {
                errors.push({ 
                  field: `${notePrefix}.tags[${tagIndex}]`, 
                  message: 'All tags must be strings' 
                });
              } else if (!isValidStringLength(tag, 1, 50)) {
                errors.push({ 
                  field: `${notePrefix}.tags[${tagIndex}]`, 
                  message: 'Each tag must be between 1 and 50 characters' 
                });
              } else if (!isValidTag(tag)) {
                errors.push({ 
                  field: `${notePrefix}.tags[${tagIndex}]`, 
                  message: 'Tags can only contain letters, numbers, spaces, hyphens, and underscores' 
                });
              }
            });
          }
        }

        // Metrics validation
        if (note.metrics) {
          const metrics = note.metrics as WorkoutMetrics;
          const validateMetric = (field: keyof WorkoutMetrics, value: number | undefined) => {
            if (!isValidMetricValue(value)) {
              errors.push({ 
                field: `${notePrefix}.metrics.${field}`, 
                message: `${field} must be a number between 1 and 10` 
              });
            }
          };

          validateMetric('perceivedEffort', metrics.perceivedEffort);
          validateMetric('energyLevel', metrics.energyLevel);
          validateMetric('sleepQuality', metrics.sleepQuality);
          validateMetric('nutritionQuality', metrics.nutritionQuality);
          validateMetric('stressLevel', metrics.stressLevel);
          validateMetric('recoveryStatus', metrics.recoveryStatus);
        }
      });
    }

    // Validate referential integrity
    if (backup.trainingPlans && backup.users) {
      const validUserIds = new Set(
        backup.users
          .filter(user => isValidUserId(user.id))
          .map(user => user.id)
      );

      backup.trainingPlans.forEach((plan, index) => {
        if (!isValidUserId(plan.userId) || !validUserIds.has(plan.userId)) {
          errors.push({ 
            field: `trainingPlans[${index}].userId`, 
            message: `Training plan references non-existent user ID: ${plan.userId}` 
          });
        }
      });
    }

    if (backup.workoutNotes && backup.users) {
      const validUserIds = new Set(
        backup.users
          .filter(user => isValidUserId(user.id))
          .map(user => user.id)
      );

      backup.workoutNotes.forEach((note, index) => {
        if (!isValidUserId(note.userId) || !validUserIds.has(note.userId)) {
          errors.push({ 
            field: `workoutNotes[${index}].userId`, 
            message: `Workout note references non-existent user ID: ${note.userId}` 
          });
        }
      });
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  async restoreFromBackup(backup: {
    users: User[];
    trainingPlans: TrainingPlan[];
    workoutNotes: WorkoutNote[];
  }): Promise<void> {
    if (!backup || typeof backup !== 'object') {
      throw new Error('Invalid backup data: Backup must be an object');
    }

    // Validate backup data structure
    const validation = this.validateBackupData(backup);
    if (!validation.isValid) {
      const errorMessage = validation.errors
        .map(error => `${error.field}: ${error.message}`)
        .join('\n');
      throw new Error(`Invalid backup data:\n${errorMessage}`);
    }

    try {
      // Start a transaction to ensure data consistency
      await this.sharding.executeTransaction(0, async (client) => {
        try {
          // Clear existing data
          await Promise.all([
            client.query('DELETE FROM workout_notes'),
            client.query('DELETE FROM training_plans'),
            client.query('DELETE FROM users')
          ]);

          // Restore data in correct order (users first, then related data)
          if (backup.users.length > 0) {
            await client.query(
              `INSERT INTO users (id, email, password, email_verified, reset_token, reset_token_expires, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              backup.users.map(user => [
                user.id,
                user.email,
                user.password,
                user.emailVerified,
                user.resetToken,
                user.resetTokenExpires,
                user.createdAt,
                user.updatedAt
              ])
            );
          }

          if (backup.trainingPlans.length > 0) {
            await client.query(
              `INSERT INTO training_plans (id, user_id, name, description, start_date, end_date, status, type, difficulty, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              backup.trainingPlans.map(plan => [
                plan.id,
                plan.userId,
                plan.name,
                plan.description,
                plan.startDate,
                plan.endDate,
                plan.status,
                plan.type,
                plan.difficulty,
                plan.createdAt,
                plan.updatedAt
              ])
            );
          }

          if (backup.workoutNotes.length > 0) {
            await client.query(
              `INSERT INTO workout_notes (id, user_id, workout_id, content, type, rating, tags, metrics, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              backup.workoutNotes.map(note => [
                note.id,
                note.userId,
                note.workoutId,
                note.content,
                note.type,
                note.rating,
                note.tags,
                note.metrics,
                note.createdAt,
                note.updatedAt
              ])
            );
          }
        } catch (txError) {
          console.error('Transaction failed during restore:', txError);
          throw new Error('Failed to restore backup: Transaction failed');
        }
      });

      // Clear cache after restore
      await this.clearCache();
    } catch (error) {
      console.error('Failed to restore backup:', error);
      throw new Error('Failed to restore backup: Database operation failed');
    }
  }

  async getAllUsers(): Promise<User[]> {
    const pool = await this.sharding.getShardPool(0); // Assuming shard 0 for user retrieval
    const result = await pool.query('SELECT * FROM users');
    return result.rows;
  }

  async getAllTrainingPlans(): Promise<TrainingPlan[]> {
    const pool = await this.sharding.getShardPool(0); // Assuming shard 0 for training plan retrieval
    const result = await pool.query('SELECT * FROM training_plans');
    return result.rows;
  }

  async getAllWorkoutNotes(): Promise<WorkoutNote[]> {
    const pool = await this.sharding.getShardPool(0); // Assuming shard 0 for workout note retrieval
    const result = await pool.query('SELECT * FROM workout_notes');
    return result.rows;
  }
}

export const storage = new DatabaseStorage();