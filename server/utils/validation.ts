import { z } from 'zod';

// User validation schemas
export const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').optional(),
  email: z.string().email('Invalid email format').optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

// API key validation schemas
export const createApiKeySchema = z.object({
  name: z.string().min(1, 'API key name is required'),
  expiresAt: z.string().datetime().optional(),
});

// Training program validation schemas
export const createTrainingProgramSchema = z.object({
  name: z.string().min(1, 'Program name is required'),
  description: z.string().optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});

export const updateTrainingProgramSchema = z.object({
  name: z.string().min(1, 'Program name is required').optional(),
  description: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

// Workout validation schemas
export const createWorkoutSchema = z.object({
  programId: z.number().int().positive().optional(),
  name: z.string().min(1, 'Workout name is required'),
  description: z.string().optional(),
  date: z.string().datetime(),
  exercises: z.array(z.object({
    name: z.string().min(1, 'Exercise name is required'),
    sets: z.number().int().positive().optional(),
    reps: z.number().int().positive().optional(),
    weight: z.number().positive().optional(),
    notes: z.string().optional(),
  })).optional(),
});

export const updateWorkoutSchema = z.object({
  name: z.string().min(1, 'Workout name is required').optional(),
  description: z.string().optional(),
  date: z.string().datetime().optional(),
  completed: z.boolean().optional(),
  exercises: z.array(z.object({
    name: z.string().min(1, 'Exercise name is required'),
    sets: z.number().int().positive().optional(),
    reps: z.number().int().positive().optional(),
    weight: z.number().positive().optional(),
    notes: z.string().optional(),
  })).optional(),
});

// Validation middleware
export const validateRequest = (schema: z.ZodSchema) => {
  return async (req: any, res: any, next: any) => {
    try {
      await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: {
            message: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details: error.errors.map(err => ({
              path: err.path.join('.'),
              message: err.message
            }))
          }
        });
      }
      next(error);
    }
  };
}; 