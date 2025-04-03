import { Pool } from 'pg';
import { logger } from '../utils/logger';

export class ShardingService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Get the current number of shards
   */
  async getShardCount(): Promise<number> {
    try {
      const result = await this.pool.query(
        'SELECT COUNT(*) as count FROM shard_metadata'
      );
      return parseInt(result.rows[0].count);
    } catch (error) {
      logger.error('Failed to get shard count:', error);
      throw error;
    }
  }
} 