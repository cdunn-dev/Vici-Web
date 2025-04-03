import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface Permission {
  id: string;
  name: string;
  description: string;
  resource: string;
  action: string;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRole {
  userId: string;
  roleId: string;
  assignedAt: Date;
  assignedBy: string;
}

interface RBACConfig {
  /**
   * Whether to cache roles and permissions
   */
  enableCaching: boolean;
  
  /**
   * Cache TTL in milliseconds
   */
  cacheTTL: number;
  
  /**
   * Whether to enable role inheritance
   */
  enableRoleInheritance: boolean;
  
  /**
   * Whether to enable permission inheritance
   */
  enablePermissionInheritance: boolean;
  
  /**
   * Whether to enable audit logging
   */
  enableAuditLogging: boolean;
}

export class RBACService extends EventEmitter {
  private pool: Pool;
  private config: RBACConfig;
  private roleCache: Map<string, Role> = new Map();
  private permissionCache: Map<string, Permission> = new Map();
  private userRoleCache: Map<string, Set<string>> = new Map();
  private cacheTimeout: NodeJS.Timeout | null = null;

  constructor(pool: Pool, config: Partial<RBACConfig> = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      enableCaching: true,
      cacheTTL: 300000, // 5 minutes
      enableRoleInheritance: true,
      enablePermissionInheritance: true,
      enableAuditLogging: true,
      ...config
    };
  }

  /**
   * Initialize the RBAC service
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing RBAC service');
      
      // Create necessary tables if they don't exist
      await this.createTables();
      
      // Start cache cleanup if caching is enabled
      if (this.config.enableCaching) {
        this.startCacheCleanup();
      }
      
      logger.info('RBAC service initialized');
    } catch (error) {
      logger.error('Failed to initialize RBAC service:', error);
      throw error;
    }
  }

  /**
   * Create necessary tables for RBAC
   */
  private async createTables(): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create roles table
      await client.query(`
        CREATE TABLE IF NOT EXISTS roles (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL UNIQUE,
          description TEXT,
          permissions TEXT[] NOT NULL DEFAULT '{}',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Create permissions table
      await client.query(`
        CREATE TABLE IF NOT EXISTS permissions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL UNIQUE,
          description TEXT,
          resource VARCHAR(255) NOT NULL,
          action VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Create user_roles table
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_roles (
          user_id UUID NOT NULL,
          role_id UUID NOT NULL,
          assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          assigned_by UUID NOT NULL,
          PRIMARY KEY (user_id, role_id),
          FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
        )
      `);
      
      // Create role_inheritance table if role inheritance is enabled
      if (this.config.enableRoleInheritance) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS role_inheritance (
            parent_role_id UUID NOT NULL,
            child_role_id UUID NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (parent_role_id, child_role_id),
            FOREIGN KEY (parent_role_id) REFERENCES roles(id) ON DELETE CASCADE,
            FOREIGN KEY (child_role_id) REFERENCES roles(id) ON DELETE CASCADE
          )
        `);
      }
      
      // Create audit_log table if audit logging is enabled
      if (this.config.enableAuditLogging) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS audit_log (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL,
            action VARCHAR(255) NOT NULL,
            resource VARCHAR(255) NOT NULL,
            details JSONB,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          )
        `);
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Start cache cleanup interval
   */
  private startCacheCleanup(): void {
    if (this.cacheTimeout) {
      clearInterval(this.cacheTimeout);
    }
    
    this.cacheTimeout = setInterval(() => {
      this.clearCache();
    }, this.config.cacheTTL);
  }

  /**
   * Clear all caches
   */
  private clearCache(): void {
    this.roleCache.clear();
    this.permissionCache.clear();
    this.userRoleCache.clear();
    logger.debug('RBAC cache cleared');
  }

  /**
   * Create a new role
   */
  async createRole(name: string, description: string, permissions: string[]): Promise<Role> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const result = await client.query(
        `INSERT INTO roles (name, description, permissions)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [name, description, permissions]
      );
      
      const role = result.rows[0];
      
      if (this.config.enableCaching) {
        this.roleCache.set(role.id, role);
      }
      
      if (this.config.enableAuditLogging) {
        await this.logAudit('CREATE', 'role', { roleId: role.id, name, permissions });
      }
      
      await client.query('COMMIT');
      return role;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get a role by ID
   */
  async getRole(roleId: string): Promise<Role | null> {
    // Check cache first
    if (this.config.enableCaching) {
      const cachedRole = this.roleCache.get(roleId);
      if (cachedRole) {
        return cachedRole;
      }
    }
    
    const result = await this.pool.query(
      'SELECT * FROM roles WHERE id = $1',
      [roleId]
    );
    
    const role = result.rows[0] || null;
    
    if (role && this.config.enableCaching) {
      this.roleCache.set(role.id, role);
    }
    
    return role;
  }

  /**
   * Update a role
   */
  async updateRole(roleId: string, updates: Partial<Role>): Promise<Role> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const setClause = Object.keys(updates)
        .map((key, index) => `${key} = $${index + 2}`)
        .join(', ');
      
      const values = [roleId, ...Object.values(updates)];
      
      const result = await client.query(
        `UPDATE roles
         SET ${setClause}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        values
      );
      
      const role = result.rows[0];
      
      if (this.config.enableCaching) {
        this.roleCache.set(role.id, role);
      }
      
      if (this.config.enableAuditLogging) {
        await this.logAudit('UPDATE', 'role', { roleId, updates });
      }
      
      await client.query('COMMIT');
      return role;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a role
   */
  async deleteRole(roleId: string): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(
        'DELETE FROM roles WHERE id = $1',
        [roleId]
      );
      
      if (this.config.enableCaching) {
        this.roleCache.delete(roleId);
      }
      
      if (this.config.enableAuditLogging) {
        await this.logAudit('DELETE', 'role', { roleId });
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Assign a role to a user
   */
  async assignRole(userId: string, roleId: string, assignedBy: string): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, assigned_by)
         VALUES ($1, $2, $3)`,
        [userId, roleId, assignedBy]
      );
      
      if (this.config.enableCaching) {
        const userRoles = this.userRoleCache.get(userId) || new Set();
        userRoles.add(roleId);
        this.userRoleCache.set(userId, userRoles);
      }
      
      if (this.config.enableAuditLogging) {
        await this.logAudit('ASSIGN', 'role', { userId, roleId, assignedBy });
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Remove a role from a user
   */
  async removeRole(userId: string, roleId: string): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(
        'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2',
        [userId, roleId]
      );
      
      if (this.config.enableCaching) {
        const userRoles = this.userRoleCache.get(userId);
        if (userRoles) {
          userRoles.delete(roleId);
        }
      }
      
      if (this.config.enableAuditLogging) {
        await this.logAudit('REMOVE', 'role', { userId, roleId });
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all roles assigned to a user
   */
  async getUserRoles(userId: string): Promise<Role[]> {
    // Check cache first
    if (this.config.enableCaching) {
      const cachedRoleIds = this.userRoleCache.get(userId);
      if (cachedRoleIds) {
        const roles: Role[] = [];
        for (const roleId of cachedRoleIds) {
          const role = this.roleCache.get(roleId);
          if (role) {
            roles.push(role);
          }
        }
        if (roles.length === cachedRoleIds.size) {
          return roles;
        }
      }
    }
    
    const result = await this.pool.query(
      `SELECT r.* FROM roles r
       JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [userId]
    );
    
    const roles = result.rows;
    
    if (this.config.enableCaching) {
      const roleIds = new Set<string>();
      roles.forEach(role => {
        this.roleCache.set(role.id, role);
        roleIds.add(role.id);
      });
      this.userRoleCache.set(userId, roleIds);
    }
    
    return roles;
  }

  /**
   * Check if a user has a specific permission
   */
  async hasPermission(userId: string, permission: string): Promise<boolean> {
    const roles = await this.getUserRoles(userId);
    
    for (const role of roles) {
      if (role.permissions.includes(permission)) {
        return true;
      }
      
      // Check inherited roles if role inheritance is enabled
      if (this.config.enableRoleInheritance) {
        const inheritedRoles = await this.getInheritedRoles(role.id);
        for (const inheritedRole of inheritedRoles) {
          if (inheritedRole.permissions.includes(permission)) {
            return true;
          }
        }
      }
    }
    
    return false;
  }

  /**
   * Get all inherited roles for a role
   */
  private async getInheritedRoles(roleId: string): Promise<Role[]> {
    const result = await this.pool.query(
      `WITH RECURSIVE role_tree AS (
        SELECT r.*, 1 as level
        FROM roles r
        JOIN role_inheritance ri ON r.id = ri.child_role_id
        WHERE ri.parent_role_id = $1
        
        UNION ALL
        
        SELECT r.*, rt.level + 1
        FROM roles r
        JOIN role_inheritance ri ON r.id = ri.child_role_id
        JOIN role_tree rt ON ri.parent_role_id = rt.id
        WHERE rt.level < 10
      )
      SELECT DISTINCT * FROM role_tree`,
      [roleId]
    );
    
    return result.rows;
  }

  /**
   * Log an audit event
   */
  private async logAudit(action: string, resource: string, details: any): Promise<void> {
    if (!this.config.enableAuditLogging) {
      return;
    }
    
    try {
      await this.pool.query(
        `INSERT INTO audit_log (user_id, action, resource, details)
         VALUES ($1, $2, $3, $4)`,
        [details.userId, action, resource, details]
      );
    } catch (error) {
      logger.error('Failed to log audit event:', error);
    }
  }

  /**
   * End the RBAC service
   */
  async end(): Promise<void> {
    try {
      logger.info('Ending RBAC service');
      
      // Stop cache cleanup
      if (this.cacheTimeout) {
        clearInterval(this.cacheTimeout);
        this.cacheTimeout = null;
      }
      
      // Clear caches
      this.clearCache();
      
      logger.info('RBAC service ended');
    } catch (error) {
      logger.error('Failed to end RBAC service:', error);
      throw error;
    }
  }
} 