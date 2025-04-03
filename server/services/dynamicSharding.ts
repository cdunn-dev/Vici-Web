import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { ShardingService, ShardingConfig } from './sharding';

export interface DynamicShardingConfig extends ShardingConfig {
  initialShardCount: number;
  maxShardCount: number;
  minShardCount: number;
  loadThreshold: number;
  monitoringInterval: number;
  rebalanceThreshold: number;
}

interface ShardMetrics {
  shardId: number;
  loadPercentage: number;
  rowCount: number;
  queryCount: number;
  lastRebalanced: Date;
}

export class DynamicShardingService {
  private metrics: Map<number, ShardMetrics> = new Map();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private autoScalingInterval: NodeJS.Timeout | null = null;
  private shardingService: ShardingService;
  private config: DynamicShardingConfig;

  constructor(config: DynamicShardingConfig) {
    this.config = config;
    this.shardingService = ShardingService.getInstance();
  }

  /**
   * Initialize shards with the initial configuration
   */
  async initializeShards(): Promise<void> {
    logger.info('Initializing shards for dynamic sharding');
    
    // Initialize the base sharding service
    await this.shardingService.initialize({
      shards: this.config.shards,
      shardCount: this.config.initialShardCount,
      defaultShard: 0
    });
    
    // Initialize metrics for each shard
    for (let i = 0; i < this.config.initialShardCount; i++) {
      this.metrics.set(i, {
        shardId: i,
        loadPercentage: 0,
        rowCount: 0,
        queryCount: 0,
        lastRebalanced: new Date()
      });
    }
  }

  /**
   * Start monitoring shard metrics
   */
  async startMonitoring(): Promise<void> {
    logger.info('Starting shard monitoring');
    
    this.monitoringInterval = setInterval(async () => {
      await this.collectMetrics();
      await this.checkRebalancing();
    }, this.config.monitoringInterval);
  }

  /**
   * Start automatic scaling based on load
   */
  async startAutoScaling(): Promise<void> {
    logger.info('Starting automatic scaling');
    
    this.autoScalingInterval = setInterval(async () => {
      await this.checkScaling();
    }, this.config.monitoringInterval);
  }

  /**
   * Stop all monitoring and scaling processes
   */
  async stop(): Promise<void> {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    if (this.autoScalingInterval) {
      clearInterval(this.autoScalingInterval);
      this.autoScalingInterval = null;
    }
    
    await this.shardingService.cleanup();
  }

  /**
   * Get a shard pool for a specific shard ID
   */
  async getShardPool(shardId: number): Promise<Pool> {
    return this.shardingService.getShardPool(shardId);
  }

  /**
   * Collect metrics for all shards
   */
  private async collectMetrics(): Promise<void> {
    for (const [shardId, metrics] of this.metrics) {
      const pool = await this.getShardPool(shardId);
      
      try {
        // Get row count
        const rowCountResult = await pool.query(`
          SELECT COUNT(*) as count FROM (
            SELECT 'users' as table_name, COUNT(*) as count FROM users
            UNION ALL
            SELECT 'training_plans', COUNT(*) FROM training_plans
            UNION ALL
            SELECT 'workout_notes', COUNT(*) FROM workout_notes
          ) as counts
        `);
        
        // Get query count (from pg_stat_statements)
        const queryCountResult = await pool.query(`
          SELECT sum(calls) as total_queries
          FROM pg_stat_statements
        `);
        
        // Calculate load percentage based on row count and query count
        const rowCount = parseInt(rowCountResult.rows[0].count);
        const queryCount = parseInt(queryCountResult.rows[0].total_queries);
        const loadPercentage = this.calculateLoadPercentage(rowCount, queryCount);
        
        this.metrics.set(shardId, {
          ...metrics,
          rowCount,
          queryCount,
          loadPercentage
        });
        
        logger.debug(`Shard ${shardId} metrics updated`, {
          shardId,
          rowCount,
          queryCount,
          loadPercentage
        });
      } catch (error) {
        logger.error(`Failed to collect metrics for shard ${shardId}`, { error });
      }
    }
  }

  /**
   * Calculate load percentage based on row count and query count
   */
  private calculateLoadPercentage(rowCount: number, queryCount: number): number {
    // Simple load calculation - can be made more sophisticated
    const maxRows = 1000000; // Example max rows per shard
    const maxQueries = 10000; // Example max queries per interval
    
    const rowLoad = rowCount / maxRows;
    const queryLoad = queryCount / maxQueries;
    
    return Math.max(rowLoad, queryLoad);
  }

  /**
   * Check if rebalancing is needed
   */
  private async checkRebalancing(): Promise<void> {
    const metrics = Array.from(this.metrics.values());
    const avgLoad = metrics.reduce((sum, m) => sum + m.loadPercentage, 0) / metrics.length;
    
    // Find shards that need rebalancing
    const overloadedShards = metrics.filter(m => m.loadPercentage > avgLoad * (1 + this.config.rebalanceThreshold));
    const underloadedShards = metrics.filter(m => m.loadPercentage < avgLoad * (1 - this.config.rebalanceThreshold));
    
    if (overloadedShards.length > 0 && underloadedShards.length > 0) {
      logger.info('Rebalancing needed', {
        overloadedShards: overloadedShards.map(s => s.shardId),
        underloadedShards: underloadedShards.map(s => s.shardId)
      });
      
      await this.rebalanceShards(overloadedShards, underloadedShards);
    }
  }

  /**
   * Rebalance data between shards
   */
  private async rebalanceShards(
    overloadedShards: ShardMetrics[],
    underloadedShards: ShardMetrics[]
  ): Promise<void> {
    for (const overloaded of overloadedShards) {
      for (const underloaded of underloadedShards) {
        try {
          // Calculate how many rows to move
          const rowsToMove = Math.floor(
            (overloaded.rowCount - underloaded.rowCount) / 2
          );
          
          if (rowsToMove > 0) {
            await this.moveRowsBetweenShards(
              overloaded.shardId,
              underloaded.shardId,
              rowsToMove
            );
            
            // Update last rebalanced timestamp
            this.metrics.set(overloaded.shardId, {
              ...overloaded,
              lastRebalanced: new Date()
            });
            this.metrics.set(underloaded.shardId, {
              ...underloaded,
              lastRebalanced: new Date()
            });
          }
        } catch (error) {
          logger.error('Failed to rebalance shards', {
            error,
            fromShard: overloaded.shardId,
            toShard: underloaded.shardId
          });
        }
      }
    }
  }

  /**
   * Move rows from one shard to another
   */
  private async moveRowsBetweenShards(
    fromShardId: number,
    toShardId: number,
    rowCount: number
  ): Promise<void> {
    const fromPool = await this.getShardPool(fromShardId);
    const toPool = await this.getShardPool(toShardId);
    
    // Start transaction
    const fromClient = await fromPool.connect();
    const toClient = await toPool.connect();
    
    try {
      await fromClient.query('BEGIN');
      await toClient.query('BEGIN');
      
      // Move users
      const usersResult = await fromClient.query(`
        SELECT * FROM users
        ORDER BY id
        LIMIT $1
        FOR UPDATE
      `, [rowCount]);
      
      for (const user of usersResult.rows) {
        await toClient.query(`
          INSERT INTO users (id, email, password, email_verified, reset_token, reset_token_expires, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          user.id,
          user.email,
          user.password,
          user.email_verified,
          user.reset_token,
          user.reset_token_expires,
          user.created_at,
          user.updated_at
        ]);
        
        await fromClient.query('DELETE FROM users WHERE id = $1', [user.id]);
      }
      
      // Move training plans
      const plansResult = await fromClient.query(`
        SELECT * FROM training_plans
        WHERE user_id IN (${usersResult.rows.map(u => u.id).join(',')})
        FOR UPDATE
      `);
      
      for (const plan of plansResult.rows) {
        await toClient.query(`
          INSERT INTO training_plans (id, user_id, name, description, start_date, end_date, status, type, difficulty, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          plan.id,
          plan.user_id,
          plan.name,
          plan.description,
          plan.start_date,
          plan.end_date,
          plan.status,
          plan.type,
          plan.difficulty,
          plan.created_at,
          plan.updated_at
        ]);
        
        await fromClient.query('DELETE FROM training_plans WHERE id = $1', [plan.id]);
      }
      
      // Move workout notes
      const notesResult = await fromClient.query(`
        SELECT * FROM workout_notes
        WHERE user_id IN (${usersResult.rows.map(u => u.id).join(',')})
        FOR UPDATE
      `);
      
      for (const note of notesResult.rows) {
        await toClient.query(`
          INSERT INTO workout_notes (id, user_id, workout_id, content, type, rating, tags, metrics, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          note.id,
          note.user_id,
          note.workout_id,
          note.content,
          note.type,
          note.rating,
          note.tags,
          note.metrics,
          note.created_at,
          note.updated_at
        ]);
        
        await fromClient.query('DELETE FROM workout_notes WHERE id = $1', [note.id]);
      }
      
      await fromClient.query('COMMIT');
      await toClient.query('COMMIT');
      
      logger.info('Successfully moved rows between shards', {
        fromShard: fromShardId,
        toShard: toShardId,
        userCount: usersResult.rows.length,
        planCount: plansResult.rows.length,
        noteCount: notesResult.rows.length
      });
    } catch (error) {
      await fromClient.query('ROLLBACK');
      await toClient.query('ROLLBACK');
      throw error;
    } finally {
      fromClient.release();
      toClient.release();
    }
  }

  /**
   * Check if scaling is needed
   */
  private async checkScaling(): Promise<void> {
    const metrics = Array.from(this.metrics.values());
    const avgLoad = metrics.reduce((sum, m) => sum + m.loadPercentage, 0) / metrics.length;
    
    if (avgLoad > this.config.loadThreshold) {
      // Need to scale up
      if (this.metrics.size < this.config.maxShardCount) {
        await this.scaleUp();
      }
    } else if (avgLoad < this.config.loadThreshold / 2) {
      // Need to scale down
      if (this.metrics.size > this.config.minShardCount) {
        await this.scaleDown();
      }
    }
  }

  /**
   * Scale up by adding a new shard
   */
  private async scaleUp(): Promise<void> {
    const newShardId = this.metrics.size;
    logger.info('Scaling up by adding new shard', { newShardId });
    
    try {
      // Add new shard to the base service
      const newShard = this.config.shards[newShardId];
      if (!newShard) {
        throw new Error(`No configuration found for shard ${newShardId}`);
      }
      
      const pool = new Pool({
        host: newShard.host,
        port: newShard.port,
        database: newShard.database,
        user: newShard.user,
        password: newShard.password
      });
      
      // Test the connection
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      // Initialize metrics for the new shard
      this.metrics.set(newShardId, {
        shardId: newShardId,
        loadPercentage: 0,
        rowCount: 0,
        queryCount: 0,
        lastRebalanced: new Date()
      });
      
      // Trigger rebalancing to distribute load
      await this.checkRebalancing();
    } catch (error) {
      logger.error('Failed to scale up', { error, newShardId });
    }
  }

  /**
   * Scale down by removing a shard
   */
  private async scaleDown(): Promise<void> {
    const shardsToRemove = Array.from(this.metrics.values())
      .sort((a, b) => a.loadPercentage - b.loadPercentage)
      .slice(0, this.metrics.size - this.config.minShardCount);
    
    for (const shard of shardsToRemove) {
      logger.info('Scaling down by removing shard', { shardId: shard.shardId });
      
      try {
        // Move all data to other shards before removing
        const otherShards = Array.from(this.metrics.values())
          .filter(m => m.shardId !== shard.shardId);
        
        await this.rebalanceShards([shard], otherShards);
        
        // Remove the shard
        await this.removeShard(shard.shardId);
        this.metrics.delete(shard.shardId);
      } catch (error) {
        logger.error('Failed to scale down', { error, shardId: shard.shardId });
      }
    }
  }

  /**
   * Remove a shard
   */
  private async removeShard(shardId: number): Promise<void> {
    const pool = await this.getShardPool(shardId);
    await pool.end();
    // Additional cleanup if needed
  }
} 