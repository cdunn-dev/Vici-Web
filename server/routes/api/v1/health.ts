import { Router } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { logger } from '../../../utils/logger';

/**
 * Create health check router
 */
export const createHealthRouter = (pool: Pool, redis: Redis): Router => {
  const router = Router();
  
  /**
   * Get system health status
   */
  router.get('/', async (req, res) => {
    try {
      const checks = {
        database: false,
        redis: false,
        timestamp: new Date().toISOString()
      };
      
      // Check database connection
      try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        checks.database = true;
      } catch (error) {
        logger.error('Database health check failed:', error);
      }
      
      // Check Redis connection
      try {
        await redis.ping();
        checks.redis = true;
      } catch (error) {
        logger.error('Redis health check failed:', error);
      }
      
      // Determine overall status
      const status = checks.database && checks.redis ? 'healthy' : 'unhealthy';
      const statusCode = status === 'healthy' ? 200 : 503;
      
      res.status(statusCode).json({
        status,
        checks
      });
    } catch (error) {
      logger.error('Health check failed:', error);
      
      res.status(503).json({
        status: 'error',
        message: 'Health check failed',
        timestamp: new Date().toISOString()
      });
    }
  });
  
  return router;
}; 