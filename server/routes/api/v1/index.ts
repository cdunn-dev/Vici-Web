import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { OpenAPIV3 } from 'openapi-types';
import { createAuthRouter } from './auth';
import { createUserRouter } from './user';
import { createTrainingRouter } from './training';
import { createWorkoutRouter } from './workout';
import { createHealthRouter } from './health';
import { createMonitoringRouter } from './monitoring';
import { validateApiKey } from '../../middleware/apiKey';
import { rateLimiter } from '../../middleware/rateLimiter';
import { logger } from '../../utils/logger';
import { Pool } from 'pg';
import { Redis } from 'ioredis';

// OpenAPI specification
const apiSpec: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {
    title: 'Vici API',
    version: '1.0.0',
    description: 'API for the Vici training platform',
  },
  servers: [
    {
      url: '/api/v1',
      description: 'Version 1',
    },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      },
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
  security: [
    {
      ApiKeyAuth: [],
      BearerAuth: [],
    },
  ],
  paths: {},
};

/**
 * Create v1 API router
 */
export const createV1Router = (pool: Pool, redis: Redis): Router => {
  const router = Router();

  // API documentation
  router.use('/docs', swaggerUi.serve);
  router.get('/docs', swaggerUi.setup(apiSpec));

  // Rate limiting and API key validation for all routes
  router.use(rateLimiter);
  router.use(validateApiKey);

  // Health check (no auth required)
  router.use('/health', createHealthRouter(pool, redis));

  // Monitoring endpoints (admin auth required)
  router.use('/monitoring', createMonitoringRouter(pool, redis));

  // Auth endpoints
  router.use('/auth', createAuthRouter(pool, redis));

  // Protected routes
  router.use('/users', createUserRouter(pool, redis));
  router.use('/training', createTrainingRouter(pool, redis));
  router.use('/workouts', createWorkoutRouter(pool, redis));

  // Log API requests
  router.use((req, res, next) => {
    logger.info('API request', {
      method: req.method,
      path: req.path,
      query: req.query,
      userId: req.user?.id,
    });
    next();
  });

  // Handle 404 for API routes
  router.use((req, res) => {
    res.status(404).json({
      error: {
        message: 'API endpoint not found',
        code: 'API_ENDPOINT_NOT_FOUND',
      },
    });
  });

  return router;
}; 