// User types
export interface User {
  id: number;
  email: string;
  name: string;
  emailVerified: boolean;
  country?: string;
  region?: string;
  city?: string;
  latitude?: string;
  longitude?: string;
  timezone?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserResponse {
  user: Omit<User, 'password' | 'resetToken' | 'resetTokenExpires'>;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: Omit<User, 'password' | 'resetToken' | 'resetTokenExpires'>;
  token: string;
  refreshToken: string;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface UpdateProfileRequest {
  name?: string;
  email?: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

// API key types
export interface ApiKey {
  id: number;
  userId: number;
  name: string;
  isActive: boolean;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateApiKeyRequest {
  name: string;
  expiresAt?: string;
}

export interface ApiKeyResponse {
  apiKey: Omit<ApiKey, 'keyHash'> & {
    key: string;
  };
}

// Training program types
export interface TrainingProgram {
  id: number;
  userId: number;
  name: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTrainingProgramRequest {
  name: string;
  description?: string;
  startDate: string;
  endDate: string;
}

export interface UpdateTrainingProgramRequest {
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
}

export interface TrainingProgramResponse {
  program: TrainingProgram;
}

// Workout types
export interface WorkoutExercise {
  id: number;
  workoutId: number;
  name: string;
  sets?: number;
  reps?: number;
  weight?: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Workout {
  id: number;
  userId: number;
  programId?: number;
  name: string;
  description?: string;
  date: Date;
  completed: boolean;
  exercises?: WorkoutExercise[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkoutRequest {
  programId?: number;
  name: string;
  description?: string;
  date: string;
  exercises?: Array<{
    name: string;
    sets?: number;
    reps?: number;
    weight?: number;
    notes?: string;
  }>;
}

export interface UpdateWorkoutRequest {
  name?: string;
  description?: string;
  date?: string;
  completed?: boolean;
  exercises?: Array<{
    name: string;
    sets?: number;
    reps?: number;
    weight?: number;
    notes?: string;
  }>;
}

export interface WorkoutResponse {
  workout: Workout;
}

// Error types
export interface ApiError {
  error: {
    message: string;
    code: string;
    details?: Array<{
      path: string;
      message: string;
    }>;
  };
} 