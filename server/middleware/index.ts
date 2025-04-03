import { Express } from 'express';
import { errorHandler, requestIdMiddleware, correlationIdMiddleware, errorBoundary } from './errorHandler';
import { ErrorHandlingService } from '../services/errorHandlingService';

/**
 * Set up all middleware for the Express application
 */
export const setupMiddleware = (app: Express, errorHandlingService: ErrorHandlingService): void => {
  // Add request ID to all requests
  app.use(requestIdMiddleware);
  
  // Add correlation ID to all requests
  app.use(correlationIdMiddleware);
  
  // Add error boundary to catch unhandled errors
  app.use(errorBoundary(errorHandlingService));
  
  // Add error handler as the last middleware
  app.use(errorHandler(errorHandlingService));
}; 