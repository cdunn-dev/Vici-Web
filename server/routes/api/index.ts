import express from 'express';
import { apiVersioning } from '../../middleware/apiVersioning';
import { apiVersioningConfig } from '../../config/apiVersioning';
import { oauthAuth, apiKeyAuth, requestSigning, ipWhitelist, requireScopes } from '../../middleware/apiSecurity';
import { logger } from '../../utils/logger';

// Import route handlers
import authRoutes from './auth';
import userRoutes from './user';
import trainingRoutes from './training';
import workoutRoutes from './workout';
import llmRoutes from './llm';
import versionDocsRoutes from './versionDocs';

// Create the router
const router = express.Router();

// Apply API versioning middleware
router.use(apiVersioning(apiVersioningConfig));

// Health check endpoint (no authentication required)
router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API documentation endpoints (no authentication required)
router.get('/docs', (req, res) => {
  res.json({
    message: 'API documentation is available at /docs/api/openapi.yaml',
    versions: apiVersioningConfig.supportedVersions,
    defaultVersion: apiVersioningConfig.defaultVersion
  });
});

// Version documentation endpoints (no authentication required)
router.use('/version-docs', versionDocsRoutes);

// Admin endpoints (require IP whitelisting and OAuth with admin scope)
router.use('/admin', ipWhitelist, oauthAuth, requireScopes(['admin']), (req, res, next) => {
  logger.info('Admin access granted', { userId: req.userId, ip: req.ip });
  next();
});

// Protected routes (require either OAuth or API key)
router.use('/auth', authRoutes);
router.use('/users', oauthAuth, userRoutes);
router.use('/training', oauthAuth, trainingRoutes);
router.use('/workouts', oauthAuth, workoutRoutes);

// LLM routes (require API key with specific scopes)
router.use('/llm', apiKeyAuth, requireScopes(['llm:access']), llmRoutes);

// Error handling middleware
router.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('API error', { error: err, path: req.path, method: req.method });
  
  res.status(err.status || 500).json({
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred',
      details: err.details || {}
    }
  });
});

export default router; 