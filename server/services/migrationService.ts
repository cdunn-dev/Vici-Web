import { logger } from '../utils/logger';
import ReadReplicaManager from './readReplicaManager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface Migration {
  /**
   * The unique identifier for the migration
   */
  id: string;
  
  /**
   * The name of the migration
   */
  name: string;
  
  /**
   * The timestamp when the migration was created
   */
  timestamp: Date;
  
  /**
   * The SQL for applying the migration
   */
  up: string;
  
  /**
   * The SQL for rolling back the migration
   */
  down: string;
  
  /**
   * The checksum of the migration file
   */
  checksum: string;
  
  /**
   * Whether the migration has been applied
   */
  applied: boolean;
  
  /**
   * The timestamp when the migration was applied
   */
  appliedAt?: Date;
  
  /**
   * The user who applied the migration
   */
  appliedBy?: string;
  
  /**
   * Any notes about the migration
   */
  notes?: string;
}

export interface MigrationOptions {
  /**
   * The directory containing migration files
   */
  migrationsDir: string;
  
  /**
   * The table name for tracking migrations
   */
  migrationsTable: string;
  
  /**
   * Whether to use transactions for migrations
   */
  useTransactions: boolean;
  
  /**
   * The timeout for migrations in milliseconds
   */
  timeout: number;
  
  /**
   * Whether to validate migration files before applying them
   */
  validateBeforeApply: boolean;
  
  /**
   * Whether to create a backup before applying migrations
   */
  createBackup: boolean;
  
  /**
   * The directory for backup files
   */
  backupDir: string;
  
  /**
   * Whether to log migration details
   */
  logMigrations: boolean;
  
  /**
   * The user to use for applying migrations
   */
  migrationUser: string;
}

export class MigrationService {
  private options: MigrationOptions;
  private isInitialized = false;
  private migrations: Migration[] = [];

  constructor(options: Partial<MigrationOptions>) {
    this.options = {
      migrationsDir: path.join(process.cwd(), 'migrations'),
      migrationsTable: 'migrations',
      useTransactions: true,
      timeout: 30000,
      validateBeforeApply: true,
      createBackup: true,
      backupDir: path.join(process.cwd(), 'backups'),
      logMigrations: true,
      migrationUser: 'system',
      ...options
    };
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Create migrations directory if it doesn't exist
      if (!fs.existsSync(this.options.migrationsDir)) {
        fs.mkdirSync(this.options.migrationsDir, { recursive: true });
      }

      // Create backup directory if it doesn't exist
      if (this.options.createBackup && !fs.existsSync(this.options.backupDir)) {
        fs.mkdirSync(this.options.backupDir, { recursive: true });
      }

      // Create migrations table if it doesn't exist
      await this.createMigrationsTable();

      // Load migrations from the database
      await this.loadMigrations();

      // Load migration files
      await this.loadMigrationFiles();

      this.isInitialized = true;
      logger.info('Migration service initialized');
    } catch (error) {
      logger.error('Failed to initialize migration service', error);
      throw error;
    }
  }

  private async createMigrationsTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS ${this.options.migrationsTable} (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied BOOLEAN NOT NULL DEFAULT FALSE,
        applied_at TIMESTAMP,
        applied_by VARCHAR(255),
        notes TEXT
      )
    `;

    await ReadReplicaManager.getInstance().query(query);
    logger.info(`Created migrations table ${this.options.migrationsTable}`);
  }

  private async loadMigrations(): Promise<void> {
    const query = `
      SELECT * FROM ${this.options.migrationsTable}
      ORDER BY timestamp ASC
    `;

    const result = await ReadReplicaManager.getInstance().query(query);
    
    this.migrations = result.rows.map((row: {
      id: string;
      name: string;
      timestamp: string;
      checksum: string;
      applied: boolean;
      applied_at: string | null;
      applied_by: string | null;
      notes: string | null;
    }) => ({
      id: row.id,
      name: row.name,
      timestamp: new Date(row.timestamp),
      up: '', // Will be loaded from file
      down: '', // Will be loaded from file
      checksum: row.checksum,
      applied: row.applied,
      appliedAt: row.applied_at ? new Date(row.applied_at) : undefined,
      appliedBy: row.applied_by,
      notes: row.notes
    }));
    
    logger.info(`Loaded ${this.migrations.length} migrations from database`);
  }

  private async loadMigrationFiles(): Promise<void> {
    // Get all migration files
    const files = fs.readdirSync(this.options.migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    for (const file of files) {
      const filePath = path.join(this.options.migrationsDir, file);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      
      // Parse the migration file
      const migration = this.parseMigrationFile(file, fileContent);
      
      // Check if the migration exists in the database
      const existingMigration = this.migrations.find(m => m.id === migration.id);
      
      if (existingMigration) {
        // Update the migration with the file content
        existingMigration.up = migration.up;
        existingMigration.down = migration.down;
        
        // Check if the checksum has changed
        if (existingMigration.checksum !== migration.checksum) {
          logger.warn(`Migration ${migration.id} has been modified since it was applied`);
        }
      } else {
        // Add the migration to the list
        this.migrations.push(migration);
        
        // Insert the migration into the database
        await this.insertMigration(migration);
      }
    }
    
    // Sort migrations by timestamp
    this.migrations.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    logger.info(`Loaded ${files.length} migration files`);
  }

  private parseMigrationFile(file: string, content: string): Migration {
    // Extract the migration ID and name from the filename
    // Format: YYYYMMDDHHMMSS_name.sql
    const match = file.match(/^(\d{14})_(.+)\.sql$/);
    
    if (!match) {
      throw new Error(`Invalid migration filename: ${file}`);
    }
    
    const [, timestamp, name] = match;
    
    // Parse the migration content
    // Format:
    // -- Up Migration
    // SQL statements for applying the migration
    // 
    // -- Down Migration
    // SQL statements for rolling back the migration
    const upMatch = content.match(/-- Up Migration\n([\s\S]*?)(?:\n-- Down Migration|$)/);
    const downMatch = content.match(/-- Down Migration\n([\s\S]*?)$/);
    
    if (!upMatch) {
      throw new Error(`Invalid migration file: ${file} (missing Up Migration)`);
    }
    
    const up = upMatch[1].trim();
    const down = downMatch ? downMatch[1].trim() : '';
    
    // Generate a checksum for the migration
    const checksum = crypto.createHash('sha256').update(content).digest('hex');
    
    return {
      id: timestamp,
      name,
      timestamp: new Date(
        parseInt(timestamp.substring(0, 4)), // Year
        parseInt(timestamp.substring(4, 6)) - 1, // Month (0-based)
        parseInt(timestamp.substring(6, 8)), // Day
        parseInt(timestamp.substring(8, 10)), // Hour
        parseInt(timestamp.substring(10, 12)), // Minute
        parseInt(timestamp.substring(12, 14)) // Second
      ),
      up,
      down,
      checksum,
      applied: false
    };
  }

  private async insertMigration(migration: Migration): Promise<void> {
    const query = `
      INSERT INTO ${this.options.migrationsTable} (
        id, name, timestamp, checksum, applied, applied_at, applied_by, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    
    await ReadReplicaManager.getInstance().query(query, [
      migration.id,
      migration.name,
      migration.timestamp,
      migration.checksum,
      migration.applied,
      migration.appliedAt,
      migration.appliedBy,
      migration.notes
    ]);
    
    logger.info(`Inserted migration ${migration.id} into database`);
  }

  private async updateMigration(migration: Migration): Promise<void> {
    const query = `
      UPDATE ${this.options.migrationsTable}
      SET applied = $1, applied_at = $2, applied_by = $3, notes = $4
      WHERE id = $5
    `;
    
    await ReadReplicaManager.getInstance().query(query, [
      migration.applied,
      migration.appliedAt,
      migration.appliedBy,
      migration.notes,
      migration.id
    ]);
    
    logger.info(`Updated migration ${migration.id} in database`);
  }

  public async createMigration(name: string, up: string, down: string, notes?: string): Promise<Migration> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Generate a timestamp for the migration ID
    const timestamp = new Date();
    const id = timestamp.toISOString()
      .replace(/[-:T]/g, '')
      .replace(/\..+/, '');
    
    // Create the migration file
    const fileName = `${id}_${name.toLowerCase().replace(/\s+/g, '_')}.sql`;
    const filePath = path.join(this.options.migrationsDir, fileName);
    
    const fileContent = `-- Up Migration
${up}

-- Down Migration
${down}
`;
    
    fs.writeFileSync(filePath, fileContent);
    
    // Generate a checksum for the migration
    const checksum = crypto.createHash('sha256').update(fileContent).digest('hex');
    
    // Create the migration object
    const migration: Migration = {
      id,
      name,
      timestamp,
      up,
      down,
      checksum,
      applied: false,
      notes
    };
    
    // Add the migration to the list
    this.migrations.push(migration);
    
    // Insert the migration into the database
    await this.insertMigration(migration);
    
    logger.info(`Created migration ${id}: ${name}`);
    
    return migration;
  }

  public async applyMigration(migrationId: string, user: string = this.options.migrationUser): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Find the migration
    const migration = this.migrations.find(m => m.id === migrationId);
    
    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`);
    }
    
    if (migration.applied) {
      logger.warn(`Migration ${migrationId} has already been applied`);
      return;
    }
    
    // Validate the migration if needed
    if (this.options.validateBeforeApply) {
      await this.validateMigration(migration);
    }
    
    // Create a backup if needed
    if (this.options.createBackup) {
      await this.createBackup(migration);
    }
    
    // Apply the migration
    if (this.options.useTransactions) {
      await ReadReplicaManager.getInstance().transaction(async (client) => {
        await client.query(migration.up);
        
        // Update the migration status
        migration.applied = true;
        migration.appliedAt = new Date();
        migration.appliedBy = user;
        
        await this.updateMigration(migration);
      });
    } else {
      await ReadReplicaManager.getInstance().query(migration.up);
      
      // Update the migration status
      migration.applied = true;
      migration.appliedAt = new Date();
      migration.appliedBy = user;
      
      await this.updateMigration(migration);
    }
    
    logger.info(`Applied migration ${migrationId}: ${migration.name}`);
  }

  public async rollbackMigration(migrationId: string, user: string = this.options.migrationUser): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Find the migration
    const migration = this.migrations.find(m => m.id === migrationId);
    
    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`);
    }
    
    if (!migration.applied) {
      logger.warn(`Migration ${migrationId} has not been applied`);
      return;
    }
    
    if (!migration.down) {
      throw new Error(`Migration ${migrationId} does not have a rollback script`);
    }
    
    // Create a backup if needed
    if (this.options.createBackup) {
      await this.createBackup(migration, 'rollback');
    }
    
    // Roll back the migration
    if (this.options.useTransactions) {
      await ReadReplicaManager.getInstance().transaction(async (client) => {
        await client.query(migration.down);
        
        // Update the migration status
        migration.applied = false;
        migration.appliedAt = undefined;
        migration.appliedBy = undefined;
        
        await this.updateMigration(migration);
      });
    } else {
      await ReadReplicaManager.getInstance().query(migration.down);
      
      // Update the migration status
      migration.applied = false;
      migration.appliedAt = undefined;
      migration.appliedBy = undefined;
      
      await this.updateMigration(migration);
    }
    
    logger.info(`Rolled back migration ${migrationId}: ${migration.name}`);
  }

  public async applyPendingMigrations(user: string = this.options.migrationUser): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Find pending migrations
    const pendingMigrations = this.migrations.filter(m => !m.applied);
    
    if (pendingMigrations.length === 0) {
      logger.info('No pending migrations to apply');
      return;
    }
    
    logger.info(`Applying ${pendingMigrations.length} pending migrations`);
    
    // Apply each migration in order
    for (const migration of pendingMigrations) {
      await this.applyMigration(migration.id, user);
    }
    
    logger.info('All pending migrations applied');
  }

  public async rollbackLastMigration(user: string = this.options.migrationUser): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Find the last applied migration
    const lastAppliedMigration = [...this.migrations]
      .reverse()
      .find(m => m.applied);
    
    if (!lastAppliedMigration) {
      logger.warn('No applied migrations to roll back');
      return;
    }
    
    await this.rollbackMigration(lastAppliedMigration.id, user);
  }

  public async rollbackToMigration(migrationId: string, user: string = this.options.migrationUser): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Find the migration
    const migration = this.migrations.find(m => m.id === migrationId);
    
    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`);
    }
    
    // Find migrations to roll back
    const migrationsToRollBack = this.migrations
      .filter(m => m.applied && m.timestamp > migration.timestamp)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    if (migrationsToRollBack.length === 0) {
      logger.warn(`No migrations to roll back to ${migrationId}`);
      return;
    }
    
    logger.info(`Rolling back ${migrationsToRollBack.length} migrations to ${migrationId}`);
    
    // Roll back each migration in reverse order
    for (const migrationToRollBack of migrationsToRollBack) {
      await this.rollbackMigration(migrationToRollBack.id, user);
    }
    
    logger.info(`Rolled back to migration ${migrationId}`);
  }

  private async validateMigration(migration: Migration): Promise<void> {
    // Check if the migration has a valid up script
    if (!migration.up) {
      throw new Error(`Migration ${migration.id} does not have a valid up script`);
    }
    
    // Check if the migration has a valid down script
    if (!migration.down) {
      logger.warn(`Migration ${migration.id} does not have a down script for rollback`);
    }
    
    // Check if the migration has been modified
    const filePath = path.join(this.options.migrationsDir, `${migration.id}_${migration.name.toLowerCase().replace(/\s+/g, '_')}.sql`);
    
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const checksum = crypto.createHash('sha256').update(fileContent).digest('hex');
      
      if (checksum !== migration.checksum) {
        throw new Error(`Migration ${migration.id} has been modified since it was created`);
      }
    }
    
    // Validate the SQL syntax
    await this.validateSqlSyntax(migration.up);
    
    if (migration.down) {
      await this.validateSqlSyntax(migration.down);
    }
  }

  private async validateSqlSyntax(sql: string): Promise<void> {
    // This is a simplified implementation
    // In a real-world scenario, you would need to use a SQL parser to validate the syntax
    logger.info('SQL syntax validation is not implemented');
  }

  private async createBackup(migration: Migration, type: 'apply' | 'rollback' = 'apply'): Promise<void> {
    // Generate a backup filename
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+/, '');
    const fileName = `${timestamp}_${migration.id}_${type}.sql`;
    const filePath = path.join(this.options.backupDir, fileName);
    
    // Get the tables that will be affected by the migration
    const affectedTables = this.extractAffectedTables(migration.up);
    
    // Create a backup of each affected table
    for (const table of affectedTables) {
      const backupQuery = `
        COPY ${table} TO STDOUT WITH CSV HEADER
      `;
      
      const backupData = await ReadReplicaManager.getInstance().query(backupQuery);
      
      // Write the backup to a file
      fs.writeFileSync(filePath, backupData);
    }
    
    logger.info(`Created backup for migration ${migration.id} (${type})`);
  }

  private extractAffectedTables(sql: string): string[] {
    // This is a simplified implementation
    // In a real-world scenario, you would need to use a SQL parser to extract the affected tables
    const tables: string[] = [];
    
    // Extract table names from INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE statements
    const insertMatch = sql.match(/INSERT\s+INTO\s+([^\s;]+)/gi);
    const updateMatch = sql.match(/UPDATE\s+([^\s;]+)/gi);
    const deleteMatch = sql.match(/DELETE\s+FROM\s+([^\s;]+)/gi);
    const createTableMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s;]+)/gi);
    const alterTableMatch = sql.match(/ALTER\s+TABLE\s+([^\s;]+)/gi);
    
    if (insertMatch) {
      tables.push(...insertMatch.map(m => m.replace(/INSERT\s+INTO\s+/i, '').trim()));
    }
    
    if (updateMatch) {
      tables.push(...updateMatch.map(m => m.replace(/UPDATE\s+/i, '').trim()));
    }
    
    if (deleteMatch) {
      tables.push(...deleteMatch.map(m => m.replace(/DELETE\s+FROM\s+/i, '').trim()));
    }
    
    if (createTableMatch) {
      tables.push(...createTableMatch.map(m => m.replace(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i, '').trim()));
    }
    
    if (alterTableMatch) {
      tables.push(...alterTableMatch.map(m => m.replace(/ALTER\s+TABLE\s+/i, '').trim()));
    }
    
    return [...new Set(tables)];
  }

  public getMigrations(): Migration[] {
    return [...this.migrations];
  }

  public getPendingMigrations(): Migration[] {
    return this.migrations.filter(m => !m.applied);
  }

  public getAppliedMigrations(): Migration[] {
    return this.migrations.filter(m => m.applied);
  }

  public async end(): Promise<void> {
    this.isInitialized = false;
    logger.info('Migration service ended');
  }
} 