import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

interface AuditEvent {
  id: string;
  userId: string;
  action: string;
  resource: string;
  details: any;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
}

interface AuditLogConfig {
  /**
   * Whether to enable audit logging
   */
  enabled: boolean;
  
  /**
   * Log retention period in days
   */
  retentionPeriod: number;
  
  /**
   * Whether to log IP addresses
   */
  logIpAddresses: boolean;
  
  /**
   * Whether to log user agents
   */
  logUserAgents: boolean;
  
  /**
   * Whether to log request details
   */
  logRequestDetails: boolean;
  
  /**
   * Whether to log response details
   */
  logResponseDetails: boolean;
  
  /**
   * Whether to log performance metrics
   */
  logPerformanceMetrics: boolean;
  
  /**
   * Whether to enable real-time alerts
   */
  enableAlerts: boolean;
  
  /**
   * Alert threshold for failed operations
   */
  alertThreshold: number;
  
  /**
   * Alert cooldown period in milliseconds
   */
  alertCooldown: number;
}

interface AlertRule {
  id: string;
  name: string;
  description: string;
  condition: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class AuditLoggingService extends EventEmitter {
  private pool: Pool;
  private config: AuditLogConfig;
  private alertRules: Map<string, AlertRule> = new Map();
  private alertCounts: Map<string, number> = new Map();
  private alertTimestamps: Map<string, number> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(pool: Pool, config: Partial<AuditLogConfig> = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      enabled: true,
      retentionPeriod: 90, // 90 days
      logIpAddresses: true,
      logUserAgents: true,
      logRequestDetails: true,
      logResponseDetails: false,
      logPerformanceMetrics: true,
      enableAlerts: true,
      alertThreshold: 5,
      alertCooldown: 300000, // 5 minutes
      ...config
    };
  }

  /**
   * Initialize the audit logging service
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing audit logging service');
      
      // Create necessary tables if they don't exist
      await this.createTables();
      
      // Load alert rules
      await this.loadAlertRules();
      
      // Start cleanup interval
      this.startCleanupInterval();
      
      logger.info('Audit logging service initialized');
    } catch (error) {
      logger.error('Failed to initialize audit logging service:', error);
      throw error;
    }
  }

  /**
   * Create necessary tables for audit logging
   */
  private async createTables(): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create audit_log table
      await client.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          action VARCHAR(255) NOT NULL,
          resource VARCHAR(255) NOT NULL,
          details JSONB,
          ip_address VARCHAR(45),
          user_agent TEXT,
          timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Create alert_rules table
      await client.query(`
        CREATE TABLE IF NOT EXISTS alert_rules (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL UNIQUE,
          description TEXT,
          condition TEXT NOT NULL,
          severity VARCHAR(20) NOT NULL,
          enabled BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Create alert_log table
      await client.query(`
        CREATE TABLE IF NOT EXISTS alert_log (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          rule_id UUID NOT NULL,
          event_id UUID NOT NULL,
          severity VARCHAR(20) NOT NULL,
          details JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
        )
      `);
      
      // Create indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
        CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource);
        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_alert_log_rule_id ON alert_log(rule_id);
        CREATE INDEX IF NOT EXISTS idx_alert_log_severity ON alert_log(severity);
        CREATE INDEX IF NOT EXISTS idx_alert_log_created_at ON alert_log(created_at);
      `);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Start cleanup interval
   */
  private startCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Run cleanup daily
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupOldLogs();
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * Clean up old audit logs
   */
  private async cleanupOldLogs(): Promise<void> {
    try {
      const client = await this.pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // Delete old audit logs
        await client.query(
          `DELETE FROM audit_log
           WHERE timestamp < NOW() - INTERVAL '${this.config.retentionPeriod} days'`
        );
        
        // Delete old alert logs
        await client.query(
          `DELETE FROM alert_log
           WHERE created_at < NOW() - INTERVAL '${this.config.retentionPeriod} days'`
        );
        
        await client.query('COMMIT');
        logger.info('Cleaned up old audit logs');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Failed to clean up old audit logs:', error);
    }
  }

  /**
   * Load alert rules from the database
   */
  private async loadAlertRules(): Promise<void> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM alert_rules WHERE enabled = TRUE'
      );
      
      this.alertRules.clear();
      
      result.rows.forEach(rule => {
        this.alertRules.set(rule.id, rule);
      });
      
      logger.info(`Loaded ${this.alertRules.size} alert rules`);
    } catch (error) {
      logger.error('Failed to load alert rules:', error);
    }
  }

  /**
   * Log an audit event
   */
  async logEvent(
    userId: string,
    action: string,
    resource: string,
    details: any,
    options: { ipAddress?: string; userAgent?: string } = {}
  ): Promise<string> {
    if (!this.config.enabled) {
      return '';
    }
    
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const result = await client.query(
        `INSERT INTO audit_log (
          user_id, action, resource, details, ip_address, user_agent
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id`,
        [
          userId,
          action,
          resource,
          details,
          this.config.logIpAddresses ? options.ipAddress : null,
          this.config.logUserAgents ? options.userAgent : null
        ]
      );
      
      const eventId = result.rows[0].id;
      
      // Check alert rules
      if (this.config.enableAlerts) {
        await this.checkAlertRules(eventId, action, resource, details);
      }
      
      await client.query('COMMIT');
      
      // Emit event
      this.emit('audit-event', {
        id: eventId,
        userId,
        action,
        resource,
        details,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
        timestamp: new Date()
      });
      
      return eventId;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to log audit event:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check alert rules for an event
   */
  private async checkAlertRules(
    eventId: string,
    action: string,
    resource: string,
    details: any
  ): Promise<void> {
    for (const [ruleId, rule] of this.alertRules.entries()) {
      try {
        // Evaluate condition
        const condition = rule.condition
          .replace('${action}', `'${action}'`)
          .replace('${resource}', `'${resource}'`);
        
        // Simple evaluation - in a real-world scenario, you would use a more robust approach
        const matches = eval(`(${condition})`);
        
        if (matches) {
          // Check cooldown
          const lastAlert = this.alertTimestamps.get(ruleId) || 0;
          const now = Date.now();
          
          if (now - lastAlert < this.config.alertCooldown) {
            // Increment count
            const count = (this.alertCounts.get(ruleId) || 0) + 1;
            this.alertCounts.set(ruleId, count);
            
            // Skip if below threshold
            if (count < this.config.alertThreshold) {
              continue;
            }
          }
          
          // Log alert
          await this.logAlert(ruleId, eventId, rule.severity, {
            action,
            resource,
            details
          });
          
          // Update timestamp and reset count
          this.alertTimestamps.set(ruleId, now);
          this.alertCounts.set(ruleId, 0);
          
          // Emit alert
          this.emit('alert', {
            ruleId,
            ruleName: rule.name,
            severity: rule.severity,
            eventId,
            details: {
              action,
              resource,
              details
            }
          });
        }
      } catch (error) {
        logger.error(`Failed to evaluate alert rule ${rule.name}:`, error);
      }
    }
  }

  /**
   * Log an alert
   */
  private async logAlert(
    ruleId: string,
    eventId: string,
    severity: string,
    details: any
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO alert_log (rule_id, event_id, severity, details)
         VALUES ($1, $2, $3, $4)`,
        [ruleId, eventId, severity, details]
      );
    } catch (error) {
      logger.error('Failed to log alert:', error);
    }
  }

  /**
   * Create a new alert rule
   */
  async createAlertRule(
    name: string,
    description: string,
    condition: string,
    severity: 'low' | 'medium' | 'high' | 'critical'
  ): Promise<AlertRule> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const result = await client.query(
        `INSERT INTO alert_rules (name, description, condition, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [name, description, condition, severity]
      );
      
      const rule = result.rows[0];
      
      if (rule.enabled) {
        this.alertRules.set(rule.id, rule);
      }
      
      await client.query('COMMIT');
      return rule;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update an alert rule
   */
  async updateAlertRule(
    ruleId: string,
    updates: Partial<AlertRule>
  ): Promise<AlertRule> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const setClause = Object.keys(updates)
        .map((key, index) => `${key} = $${index + 2}`)
        .join(', ');
      
      const values = [ruleId, ...Object.values(updates)];
      
      const result = await client.query(
        `UPDATE alert_rules
         SET ${setClause}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        values
      );
      
      const rule = result.rows[0];
      
      if (rule.enabled) {
        this.alertRules.set(rule.id, rule);
      } else {
        this.alertRules.delete(rule.id);
      }
      
      await client.query('COMMIT');
      return rule;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete an alert rule
   */
  async deleteAlertRule(ruleId: string): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(
        'DELETE FROM alert_rules WHERE id = $1',
        [ruleId]
      );
      
      this.alertRules.delete(ruleId);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get audit logs with filtering
   */
  async getAuditLogs(options: {
    userId?: string;
    action?: string;
    resource?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ logs: AuditEvent[]; total: number }> {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (options.userId) {
      conditions.push(`user_id = $${paramIndex}`);
      values.push(options.userId);
      paramIndex++;
    }
    
    if (options.action) {
      conditions.push(`action = $${paramIndex}`);
      values.push(options.action);
      paramIndex++;
    }
    
    if (options.resource) {
      conditions.push(`resource = $${paramIndex}`);
      values.push(options.resource);
      paramIndex++;
    }
    
    if (options.startDate) {
      conditions.push(`timestamp >= $${paramIndex}`);
      values.push(options.startDate);
      paramIndex++;
    }
    
    if (options.endDate) {
      conditions.push(`timestamp <= $${paramIndex}`);
      values.push(options.endDate);
      paramIndex++;
    }
    
    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';
    
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    
    // Get total count
    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM audit_log ${whereClause}`,
      values
    );
    
    const total = parseInt(countResult.rows[0].count);
    
    // Get logs
    const result = await this.pool.query(
      `SELECT * FROM audit_log
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    );
    
    return {
      logs: result.rows,
      total
    };
  }

  /**
   * Get alert logs with filtering
   */
  async getAlertLogs(options: {
    ruleId?: string;
    severity?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ logs: any[]; total: number }> {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (options.ruleId) {
      conditions.push(`rule_id = $${paramIndex}`);
      values.push(options.ruleId);
      paramIndex++;
    }
    
    if (options.severity) {
      conditions.push(`severity = $${paramIndex}`);
      values.push(options.severity);
      paramIndex++;
    }
    
    if (options.startDate) {
      conditions.push(`created_at >= $${paramIndex}`);
      values.push(options.startDate);
      paramIndex++;
    }
    
    if (options.endDate) {
      conditions.push(`created_at <= $${paramIndex}`);
      values.push(options.endDate);
      paramIndex++;
    }
    
    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';
    
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    
    // Get total count
    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM alert_log ${whereClause}`,
      values
    );
    
    const total = parseInt(countResult.rows[0].count);
    
    // Get logs with rule details
    const result = await this.pool.query(
      `SELECT al.*, ar.name as rule_name, ar.description as rule_description
       FROM alert_log al
       JOIN alert_rules ar ON al.rule_id = ar.id
       ${whereClause}
       ORDER BY al.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    );
    
    return {
      logs: result.rows,
      total
    };
  }

  /**
   * Get alert rules
   */
  async getAlertRules(): Promise<AlertRule[]> {
    const result = await this.pool.query(
      'SELECT * FROM alert_rules ORDER BY name'
    );
    
    return result.rows;
  }

  /**
   * End the audit logging service
   */
  async end(): Promise<void> {
    try {
      logger.info('Ending audit logging service');
      
      // Stop cleanup interval
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      
      logger.info('Audit logging service ended');
    } catch (error) {
      logger.error('Failed to end audit logging service:', error);
      throw error;
    }
  }
} 