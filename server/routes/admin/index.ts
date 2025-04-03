import { Router } from 'express';
import { createErrorLogsRouter } from './errorLogs';
import { ErrorHandlingService } from '../../services/errorHandlingService';

/**
 * Create admin router
 */
export const createAdminRouter = (errorHandlingService: ErrorHandlingService): Router => {
  const router = Router();
  
  // Register error logs routes
  router.use('/error-logs', createErrorLogsRouter(errorHandlingService));
  
  return router;
}; 