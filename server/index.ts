import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { apiVersioning } from './middleware/apiVersioning';
import { apiVersioningConfig } from './config/apiVersioning';
import { securityHeaders, cors, rateLimitHeaders } from './middleware/securityHeaders';
import { logger } from './utils/logger';

// Import routes
import apiRoutes from './routes/api';

// Create the Express app
const app = express();

// Apply basic security middleware
app.use(helmet());

// Apply compression
app.use(compression());

// Apply security headers
app.use(securityHeaders);

// Apply CORS
app.use(cors);

// Apply rate limit headers
app.use(rateLimitHeaders);

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Apply API versioning middleware
app.use('/api', apiVersioning(apiVersioningConfig));

// API routes
app.use('/api', apiRoutes);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err, path: req.path, method: req.method });
  
  res.status(err.status || 500).json({
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred',
      details: err.details || {}
    }
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});

export default app; 