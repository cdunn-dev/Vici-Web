import { Router } from 'express';
import { ErrorHandlingService, ErrorSeverity, ErrorCategory } from '../../services/errorHandlingService';
import { authenticateAdmin } from '../../middleware/auth';

/**
 * Create error logs router
 */
export const createErrorLogsRouter = (errorHandlingService: ErrorHandlingService): Router => {
  const router = Router();
  
  // Apply admin authentication middleware to all routes
  router.use(authenticateAdmin);
  
  /**
   * Get error logs with filtering and pagination
   */
  router.get('/', async (req, res) => {
    try {
      const {
        severity,
        category,
        startDate,
        endDate,
        limit = 100,
        offset = 0
      } = req.query;
      
      const options: any = {
        limit: parseInt(limit as string, 10),
        offset: parseInt(offset as string, 10)
      };
      
      if (severity) {
        options.severity = severity as ErrorSeverity;
      }
      
      if (category) {
        options.category = category as ErrorCategory;
      }
      
      if (startDate) {
        options.startDate = new Date(startDate as string);
      }
      
      if (endDate) {
        options.endDate = new Date(endDate as string);
      }
      
      const { logs, total } = await errorHandlingService.getErrorLogs(options);
      
      res.json({
        logs,
        total,
        limit: options.limit,
        offset: options.offset
      });
    } catch (error) {
      res.status(500).json({
        error: {
          message: 'Failed to get error logs',
          code: 'ERROR_LOGS_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Get error tracking data
   */
  router.get('/tracking', async (req, res) => {
    try {
      const {
        startDate,
        endDate,
        limit = 100,
        offset = 0
      } = req.query;
      
      const options: any = {
        limit: parseInt(limit as string, 10),
        offset: parseInt(offset as string, 10)
      };
      
      if (startDate) {
        options.startDate = new Date(startDate as string);
      }
      
      if (endDate) {
        options.endDate = new Date(endDate as string);
      }
      
      const { tracking, total } = await errorHandlingService.getErrorTracking(options);
      
      res.json({
        tracking,
        total,
        limit: options.limit,
        offset: options.offset
      });
    } catch (error) {
      res.status(500).json({
        error: {
          message: 'Failed to get error tracking data',
          code: 'ERROR_TRACKING_FETCH_FAILED'
        }
      });
    }
  });
  
  /**
   * Get error statistics
   */
  router.get('/stats', async (req, res) => {
    try {
      const client = await errorHandlingService['pool'].connect();
      
      try {
        // Get error counts by severity
        const severityResult = await client.query(`
          SELECT severity, COUNT(*) as count
          FROM error_log
          GROUP BY severity
          ORDER BY severity
        `);
        
        // Get error counts by category
        const categoryResult = await client.query(`
          SELECT category, COUNT(*) as count
          FROM error_log
          GROUP BY category
          ORDER BY category
        `);
        
        // Get error counts by day for the last 30 days
        const dailyResult = await client.query(`
          SELECT DATE(timestamp) as date, COUNT(*) as count
          FROM error_log
          WHERE timestamp >= NOW() - INTERVAL '30 days'
          GROUP BY DATE(timestamp)
          ORDER BY date
        `);
        
        // Get top 10 most frequent errors
        const topErrorsResult = await client.query(`
          SELECT message, code, COUNT(*) as count
          FROM error_log
          GROUP BY message, code
          ORDER BY count DESC
          LIMIT 10
        `);
        
        // Get recovery success rate
        const recoveryResult = await client.query(`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN recovery_attempted THEN 1 ELSE 0 END) as attempted,
            SUM(CASE WHEN recovery_successful THEN 1 ELSE 0 END) as successful
          FROM error_log
          WHERE recovery_attempted = TRUE
        `);
        
        res.json({
          severity: severityResult.rows,
          category: categoryResult.rows,
          daily: dailyResult.rows,
          topErrors: topErrorsResult.rows,
          recovery: recoveryResult.rows[0]
        });
      } finally {
        client.release();
      }
    } catch (error) {
      res.status(500).json({
        error: {
          message: 'Failed to get error statistics',
          code: 'ERROR_STATS_FETCH_FAILED'
        }
      });
    }
  });
  
  return router;
}; 