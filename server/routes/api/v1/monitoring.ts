import { Router } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import os from 'os';
import { logger } from '../../../utils/logger';
import { authenticateAdmin } from '../../../middleware/auth';

interface SystemMetrics {
  system: {
    uptime: number;
    loadAvg: number[];
    totalMem: number;
    freeMem: number;
    cpuUsage: NodeJS.CpuUsage;
    memoryUsage: NodeJS.MemoryUsage;
  };
  process: {
    uptime: number;
    pid: number;
    version: string;
    platform: NodeJS.Platform;
  };
  database?: {
    connections: number;
    db_size: number;
    active_queries: number;
    idle_connections: number;
  };
  redis?: {
    [key: string]: string;
  };
}

/**
 * Create monitoring router
 */
export const createMonitoringRouter = (pool: Pool, redis: Redis): Router => {
  const router = Router();
  
  // Require admin authentication for all monitoring routes
  router.use(authenticateAdmin);
  
  /**
   * Get system metrics
   */
  router.get('/metrics', async (req, res) => {
    try {
      const metrics: SystemMetrics = {
        system: {
          uptime: os.uptime(),
          loadAvg: os.loadavg(),
          totalMem: os.totalmem(),
          freeMem: os.freemem(),
          cpuUsage: process.cpuUsage(),
          memoryUsage: process.memoryUsage()
        },
        process: {
          uptime: process.uptime(),
          pid: process.pid,
          version: process.version,
          platform: process.platform
        }
      };
      
      // Get database metrics
      const dbMetrics = await pool.query(`
        SELECT
          (SELECT count(*) FROM pg_stat_activity) as connections,
          pg_database_size(current_database()) as db_size,
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') as active_queries,
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle') as idle_connections
      `);
      
      metrics.database = dbMetrics.rows[0];
      
      // Get Redis metrics
      const redisInfo = await redis.info();
      const redisMetrics: { [key: string]: string } = {};
      
      redisInfo.split('\n').forEach(line => {
        const [key, value] = line.split(':');
        if (key && value) {
          redisMetrics[key.trim()] = value.trim();
        }
      });
      
      metrics.redis = redisMetrics;
      
      res.json(metrics);
    } catch (error) {
      logger.error('Failed to get system metrics:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get system metrics',
          code: 'METRICS_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Get active connections
   */
  router.get('/connections', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          pid,
          usename as username,
          application_name,
          client_addr as client_address,
          client_port,
          backend_start,
          state,
          state_change,
          query
        FROM pg_stat_activity
        WHERE datname = current_database()
        ORDER BY backend_start DESC
      `);
      
      res.json(result.rows);
    } catch (error) {
      logger.error('Failed to get active connections:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get active connections',
          code: 'CONNECTIONS_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Get slow queries
   */
  router.get('/slow-queries', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          pid,
          usename as username,
          application_name,
          client_addr as client_address,
          query_start,
          state,
          wait_event,
          query
        FROM pg_stat_activity
        WHERE state = 'active'
          AND (now() - query_start) > interval '1 second'
        ORDER BY query_start ASC
      `);
      
      res.json(result.rows);
    } catch (error) {
      logger.error('Failed to get slow queries:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get slow queries',
          code: 'SLOW_QUERIES_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Get table sizes
   */
  router.get('/table-sizes', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          schemaname as schema,
          relname as table,
          pg_size_pretty(pg_total_relation_size(relid)) as total_size,
          pg_size_pretty(pg_relation_size(relid)) as table_size,
          pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) as index_size,
          pg_total_relation_size(relid) as size_bytes
        FROM pg_catalog.pg_statio_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
      `);
      
      res.json(result.rows);
    } catch (error) {
      logger.error('Failed to get table sizes:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get table sizes',
          code: 'TABLE_SIZES_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Get cache hit ratios
   */
  router.get('/cache-stats', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          relname as table,
          heap_blks_read as blocks_read,
          heap_blks_hit as blocks_hit,
          CASE heap_blks_hit + heap_blks_read
            WHEN 0 THEN 0
            ELSE round(100.0 * heap_blks_hit / (heap_blks_hit + heap_blks_read), 2)
          END as hit_ratio
        FROM pg_statio_user_tables
        ORDER BY heap_blks_hit + heap_blks_read DESC
      `);
      
      res.json(result.rows);
    } catch (error) {
      logger.error('Failed to get cache stats:', error);
      
      res.status(500).json({
        error: {
          message: 'Failed to get cache stats',
          code: 'CACHE_STATS_FETCH_FAILED'
        }
      });
    }
  });
  
  return router;
}; 