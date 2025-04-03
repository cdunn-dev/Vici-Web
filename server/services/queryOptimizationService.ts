import { Pool } from 'pg';
import { logger } from '../utils/logger';

interface QueryStats {
  queryId: string;
  query: string;
  calls: number;
  totalTime: number;
  meanTime: number;
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  sharedBlksWritten: number;
  tempBlksRead: number;
  tempBlksWritten: number;
  blkReadTime: number;
  blkWriteTime: number;
  timestamp: Date;
}

interface QueryOptimization {
  queryId: string;
  originalQuery: string;
  optimizedQuery: string;
  estimatedImprovement: number;
  explanation: string;
  applied: boolean;
  appliedAt: Date | null;
}

export class QueryOptimizationService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Initialize the query optimization service
   */
  async initialize(): Promise<void> {
    try {
      // Enable pg_stat_statements extension if not already enabled
      await this.pool.query(`
        CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
      `);

      // Create query_optimizations table if it doesn't exist
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS query_optimizations (
          query_id TEXT PRIMARY KEY,
          original_query TEXT NOT NULL,
          optimized_query TEXT NOT NULL,
          estimated_improvement FLOAT NOT NULL,
          explanation TEXT NOT NULL,
          applied BOOLEAN DEFAULT FALSE,
          applied_at TIMESTAMP
        );
      `);

      logger.info('Query optimization service initialized');
    } catch (error) {
      logger.error('Failed to initialize query optimization service:', error);
      throw error;
    }
  }

  /**
   * Collect query statistics from pg_stat_statements
   */
  async collectQueryStats(): Promise<QueryStats[]> {
    try {
      const result = await this.pool.query(`
        SELECT 
          queryid::text as "queryId",
          query as "query",
          calls as "calls",
          total_time as "totalTime",
          mean_time as "meanTime",
          rows as "rows",
          shared_blks_hit as "sharedBlksHit",
          shared_blks_read as "sharedBlksRead",
          shared_blks_written as "sharedBlksWritten",
          temp_blks_read as "tempBlksRead",
          temp_blks_written as "tempBlksWritten",
          blk_read_time as "blkReadTime",
          blk_write_time as "blkWriteTime",
          NOW() as "timestamp"
        FROM pg_stat_statements
        WHERE calls > 10
        ORDER BY total_time DESC
        LIMIT 100
      `);

      return result.rows;
    } catch (error) {
      logger.error('Failed to collect query statistics:', error);
      throw error;
    }
  }

  /**
   * Analyze a query for potential optimizations
   */
  async analyzeQuery(query: string): Promise<QueryOptimization | null> {
    try {
      // Get query plan
      const planResult = await this.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
      const plan = planResult.rows[0]['QUERY PLAN'][0];

      // Check for sequential scans on large tables
      const sequentialScans = this.detectSequentialScans(plan);
      if (sequentialScans.length > 0) {
        const tableNames = sequentialScans.join(', ');
        const optimizedQuery = this.optimizeSequentialScans(query, sequentialScans);
        
        return {
          queryId: this.generateQueryId(query),
          originalQuery: query,
          optimizedQuery,
          estimatedImprovement: 50, // Estimated 50% improvement for replacing sequential scans
          explanation: `Replace sequential scans on tables: ${tableNames} with indexed lookups`,
          applied: false,
          appliedAt: null
        };
      }

      // Check for missing indexes
      const missingIndexes = this.findMissingIndexes(plan);
      if (missingIndexes.length > 0) {
        const indexSuggestions = missingIndexes.map(idx => 
          `CREATE INDEX idx_${idx.tableName}_${idx.columnName} ON ${idx.tableName} (${idx.columnName});`
        ).join('\n');
        
        return {
          queryId: this.generateQueryId(query),
          originalQuery: query,
          optimizedQuery: query, // Query remains the same, but indexes should be added
          estimatedImprovement: 30, // Estimated 30% improvement for adding indexes
          explanation: `Add the following indexes:\n${indexSuggestions}`,
          applied: false,
          appliedAt: null
        };
      }

      // Check for nested loops with large tables
      const nestedLoops = this.findNestedLoops(plan);
      if (nestedLoops.length > 0) {
        const optimizedQuery = this.optimizeNestedLoops(query, nestedLoops);
        
        return {
          queryId: this.generateQueryId(query),
          originalQuery: query,
          optimizedQuery,
          estimatedImprovement: 40, // Estimated 40% improvement for optimizing nested loops
          explanation: `Optimize nested loops by adding appropriate join conditions or using EXISTS/IN instead of IN/NOT IN`,
          applied: false,
          appliedAt: null
        };
      }

      // No optimizations found
      return null;
    } catch (error) {
      logger.error('Failed to analyze query:', error);
      throw error;
    }
  }

  /**
   * Find sequential scans in the query plan
   */
  private detectSequentialScans(plan: any): string[] {
    const sequentialScans: string[] = [];
    
    const findSequentialScans = (node: any) => {
      if (node['Node Type'] === 'Seq Scan') {
        sequentialScans.push(node['Relation Name']);
      }
      
      if (node['Plans']) {
        node['Plans'].forEach((plan: any) => findSequentialScans(plan));
      }
    };
    
    findSequentialScans(plan);
    return sequentialScans;
  }

  /**
   * Find missing indexes in the query plan
   */
  private findMissingIndexes(plan: any): Array<{ tableName: string, columnName: string }> {
    const missingIndexes: Array<{ tableName: string, columnName: string }> = [];
    
    const findMissingIndexes = (node: any) => {
      if (node['Node Type'] === 'Seq Scan' && node['Filter']) {
        // Extract column names from filter conditions
        const filter = node['Filter'];
        const columnMatches = filter.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*[=<>]/g);
        
        if (columnMatches) {
          columnMatches.forEach(match => {
            const columnName = match.split(/\s+/)[0];
            missingIndexes.push({
              tableName: node['Relation Name'],
              columnName
            });
          });
        }
      }
      
      if (node['Plans']) {
        node['Plans'].forEach(findMissingIndexes);
      }
    };
    
    findMissingIndexes(plan);
    return missingIndexes;
  }

  /**
   * Find nested loops in the query plan
   */
  private findNestedLoops(plan: any): Array<{ outerTable: string, innerTable: string, rows: number }> {
    const nestedLoops: Array<{ outerTable: string, innerTable: string, rows: number }> = [];
    
    const findLoops = (node: any) => {
      if (node['Node Type'] === 'Nested Loop' && node['Plan Rows'] > 1000) {
        const outerPlan = node['Plans'][0];
        const innerPlan = node['Plans'][1];
        
        if (outerPlan['Node Type'] === 'Seq Scan' && innerPlan['Node Type'] === 'Seq Scan') {
          nestedLoops.push({
            outerTable: outerPlan['Relation Name'],
            innerTable: innerPlan['Relation Name'],
            rows: node['Plan Rows']
          });
        }
      }
      
      if (node['Plans']) {
        node['Plans'].forEach(findLoops);
      }
    };
    
    findLoops(plan);
    return nestedLoops;
  }

  /**
   * Optimize a query by replacing sequential scans with indexed lookups
   */
  private optimizeSequentialScans(query: string, sequentialScans: string[]): string {
    // This is a simplified implementation
    // In a real-world scenario, you would need to analyze the query more thoroughly
    let optimizedQuery = query;
    
    sequentialScans.forEach((scan: string) => {
      // Add a WHERE clause with a common filter column if possible
      // This is just a placeholder - in reality, you would need to analyze the data
      const whereClause = `WHERE ${scan}.id IN (SELECT id FROM ${scan} WHERE id % 10 = 0)`;
      
      // Replace the table reference with a subquery
      const tableRegex = new RegExp(`FROM\\s+${scan}\\b`, 'i');
      optimizedQuery = optimizedQuery.replace(tableRegex, function(match: string): string {
        return `FROM (SELECT * FROM ${scan} ${whereClause}) AS ${scan}`;
      });
    });
    
    return optimizedQuery;
  }

  /**
   * Optimize a query by improving nested loops
   */
  private optimizeNestedLoops(query: string, nestedLoops: Array<{ outerTable: string, innerTable: string, rows: number }>): string {
    // This is a simplified implementation
    // In a real-world scenario, you would need to analyze the query more thoroughly
    
    let optimizedQuery = query;
    
    nestedLoops.forEach(loop => {
      // Replace IN/NOT IN with EXISTS/NOT EXISTS where appropriate
      const inRegex = new RegExp(`${loop.outerTable}\\.id\\s+IN\\s*\\(\\s*SELECT\\s+${loop.innerTable}\\.id\\s+FROM\\s+${loop.innerTable}`, 'i');
      if (inRegex.test(optimizedQuery)) {
        optimizedQuery = optimizedQuery.replace(inRegex, `EXISTS (SELECT 1 FROM ${loop.innerTable} WHERE ${loop.innerTable}.id = ${loop.outerTable}.id`);
      }
    });
    
    return optimizedQuery;
  }

  /**
   * Generate a unique ID for a query
   */
  private generateQueryId(query: string): string {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(query).digest('hex');
  }

  /**
   * Save a query optimization
   */
  async saveOptimization(optimization: QueryOptimization): Promise<void> {
    try {
      await this.pool.query(`
        INSERT INTO query_optimizations 
        (query_id, original_query, optimized_query, estimated_improvement, explanation, applied, applied_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (query_id) DO UPDATE SET
          optimized_query = $3,
          estimated_improvement = $4,
          explanation = $5,
          applied = $6,
          applied_at = $7
      `, [
        optimization.queryId,
        optimization.originalQuery,
        optimization.optimizedQuery,
        optimization.estimatedImprovement,
        optimization.explanation,
        optimization.applied,
        optimization.appliedAt
      ]);
      
      logger.info(`Saved optimization for query: ${optimization.queryId}`);
    } catch (error) {
      logger.error('Failed to save query optimization:', error);
      throw error;
    }
  }

  /**
   * Get all saved optimizations
   */
  async getOptimizations(): Promise<QueryOptimization[]> {
    try {
      const result = await this.pool.query(`
        SELECT 
          query_id as "queryId",
          original_query as "originalQuery",
          optimized_query as "optimizedQuery",
          estimated_improvement as "estimatedImprovement",
          explanation as "explanation",
          applied as "applied",
          applied_at as "appliedAt"
        FROM query_optimizations
        ORDER BY estimated_improvement DESC
      `);
      
      return result.rows;
    } catch (error) {
      logger.error('Failed to get query optimizations:', error);
      throw error;
    }
  }

  /**
   * Apply a query optimization
   */
  async applyOptimization(queryId: string): Promise<void> {
    try {
      const result = await this.pool.query(`
        SELECT * FROM query_optimizations WHERE query_id = $1
      `, [queryId]);
      
      if (result.rows.length === 0) {
        throw new Error(`Optimization not found: ${queryId}`);
      }
      
      const optimization = result.rows[0];
      
      // In a real-world scenario, you would need to update the application code
      // or stored procedures to use the optimized query
      // For this example, we'll just mark it as applied
      
      await this.pool.query(`
        UPDATE query_optimizations
        SET applied = TRUE, applied_at = NOW()
        WHERE query_id = $1
      `, [queryId]);
      
      logger.info(`Applied optimization for query: ${queryId}`);
    } catch (error) {
      logger.error('Failed to apply query optimization:', error);
      throw error;
    }
  }

  /**
   * Run the query optimization process
   */
  async runOptimizationProcess(): Promise<void> {
    try {
      logger.info('Starting query optimization process');
      
      // Collect query statistics
      const queryStats = await this.collectQueryStats();
      logger.info(`Collected statistics for ${queryStats.length} queries`);
      
      // Analyze each query
      for (const stat of queryStats) {
        // Skip queries that are already optimized
        const existingOptimization = await this.pool.query(`
          SELECT * FROM query_optimizations WHERE query_id = $1
        `, [stat.queryId]);
        
        if (existingOptimization.rows.length > 0) {
          continue;
        }
        
        // Analyze the query
        const optimization = await this.analyzeQuery(stat.query);
        
        if (optimization) {
          // Save the optimization
          await this.saveOptimization(optimization);
          logger.info(`Found optimization for query: ${stat.queryId}`);
        }
      }
      
      logger.info('Query optimization process completed');
    } catch (error) {
      logger.error('Failed to run query optimization process:', error);
      throw error;
    }
  }
} 