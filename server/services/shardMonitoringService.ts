import { Pool } from 'pg';
import { logger } from '../utils/logger';

interface ShardMetrics {
  shardId: number;
  timestamp: Date;
  rowCount: number;
  queryCount: number;
  errorCount: number;
  avgResponseTime: number;
  activeConnections: number;
  loadPercentage: number;
}

export class ShardMonitoringService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Store metrics for a shard
   */
  async storeMetrics(metrics: ShardMetrics): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO shard_metrics 
         (shard_id, timestamp, row_count, query_count, error_count, 
          avg_response_time, active_connections, load_percentage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          metrics.shardId,
          metrics.timestamp,
          metrics.rowCount,
          metrics.queryCount,
          metrics.errorCount,
          metrics.avgResponseTime,
          metrics.activeConnections,
          metrics.loadPercentage
        ]
      );
    } catch (error) {
      logger.error('Failed to store shard metrics:', error);
      throw error;
    }
  }

  /**
   * Get the latest metrics for all shards
   */
  async getLatestMetrics(): Promise<ShardMetrics[]> {
    try {
      const result = await this.pool.query(
        `SELECT DISTINCT ON (shard_id) 
         shard_id as "shardId",
         timestamp,
         row_count as "rowCount",
         query_count as "queryCount",
         error_count as "errorCount",
         avg_response_time as "avgResponseTime",
         active_connections as "activeConnections",
         load_percentage as "loadPercentage"
         FROM shard_metrics
         ORDER BY shard_id, timestamp DESC`
      );
      return result.rows;
    } catch (error) {
      logger.error('Failed to get latest metrics:', error);
      throw error;
    }
  }

  /**
   * Get historical metrics for a shard
   */
  async getHistoricalMetrics(shardId: number, hours: number = 24): Promise<ShardMetrics[]> {
    try {
      const result = await this.pool.query(
        `SELECT 
         shard_id as "shardId",
         timestamp,
         row_count as "rowCount",
         query_count as "queryCount",
         error_count as "errorCount",
         avg_response_time as "avgResponseTime",
         active_connections as "activeConnections",
         load_percentage as "loadPercentage"
         FROM shard_metrics
         WHERE shard_id = $1
         AND timestamp >= NOW() - INTERVAL '${hours} hours'
         ORDER BY timestamp DESC`,
        [shardId]
      );
      return result.rows;
    } catch (error) {
      logger.error('Failed to get historical metrics:', error);
      throw error;
    }
  }
} 