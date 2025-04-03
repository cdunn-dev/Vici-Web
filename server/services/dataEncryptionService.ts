import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { promisify } from 'util';

// Promisify crypto functions
const randomBytes = promisify(crypto.randomBytes);
const pbkdf2 = promisify(crypto.pbkdf2);

interface EncryptionConfig {
  /**
   * Whether encryption is enabled
   */
  enabled: boolean;
  
  /**
   * Algorithm to use for encryption
   */
  algorithm: string;
  
  /**
   * Key derivation function
   */
  keyDerivationFunction: string;
  
  /**
   * Number of iterations for key derivation
   */
  keyDerivationIterations: number;
  
  /**
   * Key length in bytes
   */
  keyLength: number;
  
  /**
   * Salt length in bytes
   */
  saltLength: number;
  
  /**
   * IV length in bytes
   */
  ivLength: number;
  
  /**
   * Key rotation interval in days
   */
  keyRotationInterval: number;
  
  /**
   * Whether to use hardware acceleration if available
   */
  useHardwareAcceleration: boolean;
}

interface EncryptionKey {
  id: string;
  key: Buffer;
  salt: Buffer;
  createdAt: Date;
  expiresAt: Date;
  isActive: boolean;
}

interface EncryptedData {
  encryptedData: string;
  iv: string;
  salt: string;
  keyId: string;
}

export class DataEncryptionService extends EventEmitter {
  private pool: Pool;
  private config: EncryptionConfig;
  private activeKey: EncryptionKey | null = null;
  private keyCache: Map<string, EncryptionKey> = new Map();
  private keyRotationInterval: NodeJS.Timeout | null = null;

  constructor(pool: Pool, config: Partial<EncryptionConfig> = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      enabled: true,
      algorithm: 'aes-256-gcm',
      keyDerivationFunction: 'pbkdf2',
      keyDerivationIterations: 100000,
      keyLength: 32, // 256 bits
      saltLength: 16,
      ivLength: 12,
      keyRotationInterval: 90, // 90 days
      useHardwareAcceleration: true,
      ...config
    };
  }

  /**
   * Initialize the encryption service
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing data encryption service');
      
      // Create necessary tables if they don't exist
      await this.createTables();
      
      // Load active key
      await this.loadActiveKey();
      
      // Start key rotation interval
      this.startKeyRotationInterval();
      
      logger.info('Data encryption service initialized');
    } catch (error) {
      logger.error('Failed to initialize data encryption service:', error);
      throw error;
    }
  }

  /**
   * Create necessary tables for encryption
   */
  private async createTables(): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create encryption_keys table
      await client.query(`
        CREATE TABLE IF NOT EXISTS encryption_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          key_data BYTEA NOT NULL,
          salt BYTEA NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          is_active BOOLEAN DEFAULT FALSE
        )
      `);
      
      // Create encrypted_columns table to track encrypted columns
      await client.query(`
        CREATE TABLE IF NOT EXISTS encrypted_columns (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          table_name VARCHAR(255) NOT NULL,
          column_name VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (table_name, column_name)
        )
      `);
      
      // Create indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_encryption_keys_is_active ON encryption_keys(is_active);
        CREATE INDEX IF NOT EXISTS idx_encryption_keys_expires_at ON encryption_keys(expires_at);
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
   * Start key rotation interval
   */
  private startKeyRotationInterval(): void {
    if (this.keyRotationInterval) {
      clearInterval(this.keyRotationInterval);
    }
    
    // Check for key rotation daily
    this.keyRotationInterval = setInterval(async () => {
      await this.checkKeyRotation();
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * Check if key rotation is needed
   */
  private async checkKeyRotation(): Promise<void> {
    if (!this.activeKey) {
      await this.generateNewKey();
      return;
    }
    
    // Check if key is about to expire (within 7 days)
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    
    if (this.activeKey.expiresAt <= sevenDaysFromNow) {
      logger.info('Key rotation needed, generating new key');
      await this.generateNewKey();
    }
  }

  /**
   * Load active key from database
   */
  private async loadActiveKey(): Promise<void> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM encryption_keys WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1'
      );
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        this.activeKey = {
          id: row.id,
          key: row.key_data,
          salt: row.salt,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          isActive: row.is_active
        };
        
        this.keyCache.set(this.activeKey.id, this.activeKey);
        logger.info(`Loaded active encryption key (ID: ${this.activeKey.id})`);
      } else {
        // No active key found, generate a new one
        await this.generateNewKey();
      }
    } catch (error) {
      logger.error('Failed to load active key:', error);
      throw error;
    }
  }

  /**
   * Generate a new encryption key
   */
  private async generateNewKey(): Promise<EncryptionKey> {
    try {
      // Generate salt
      const salt = await randomBytes(this.config.saltLength);
      
      // Generate master key (in a real-world scenario, this would be securely stored)
      const masterKey = process.env.ENCRYPTION_MASTER_KEY || 'default-master-key-change-in-production';
      
      // Derive encryption key
      const key = await pbkdf2(
        masterKey,
        salt,
        this.config.keyDerivationIterations,
        this.config.keyLength,
        'sha512'
      );
      
      // Calculate expiration date
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + this.config.keyRotationInterval);
      
      // Store key in database
      const client = await this.pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // Deactivate current active key
        if (this.activeKey) {
          await client.query(
            'UPDATE encryption_keys SET is_active = FALSE WHERE id = $1',
            [this.activeKey.id]
          );
        }
        
        // Insert new key
        const result = await client.query(
          `INSERT INTO encryption_keys (key_data, salt, expires_at, is_active)
           VALUES ($1, $2, $3, TRUE)
           RETURNING id, created_at`,
          [key, salt, expiresAt]
        );
        
        const newKey: EncryptionKey = {
          id: result.rows[0].id,
          key,
          salt,
          createdAt: result.rows[0].created_at,
          expiresAt,
          isActive: true
        };
        
        // Update active key
        this.activeKey = newKey;
        this.keyCache.set(newKey.id, newKey);
        
        await client.query('COMMIT');
        
        logger.info(`Generated new encryption key (ID: ${newKey.id})`);
        
        // Emit event
        this.emit('key-rotated', newKey);
        
        return newKey;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Failed to generate new key:', error);
      throw error;
    }
  }

  /**
   * Get encryption key by ID
   */
  private async getKeyById(keyId: string): Promise<EncryptionKey> {
    // Check cache first
    if (this.keyCache.has(keyId)) {
      return this.keyCache.get(keyId)!;
    }
    
    // Load from database
    const result = await this.pool.query(
      'SELECT * FROM encryption_keys WHERE id = $1',
      [keyId]
    );
    
    if (result.rows.length === 0) {
      throw new Error(`Encryption key not found: ${keyId}`);
    }
    
    const row = result.rows[0];
    const key: EncryptionKey = {
      id: row.id,
      key: row.key_data,
      salt: row.salt,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      isActive: row.is_active
    };
    
    // Cache key
    this.keyCache.set(key.id, key);
    
    return key;
  }

  /**
   * Encrypt data
   */
  async encrypt(data: string): Promise<EncryptedData> {
    if (!this.config.enabled) {
      return {
        encryptedData: data,
        iv: '',
        salt: '',
        keyId: ''
      };
    }
    
    if (!this.activeKey) {
      throw new Error('No active encryption key available');
    }
    
    try {
      // Generate IV
      const iv = await randomBytes(this.config.ivLength);
      
      // Create cipher
      const cipher = crypto.createCipheriv(
        this.config.algorithm,
        this.activeKey.key,
        iv,
        { authTagLength: 16 } as any
      ) as any;
      
      // Encrypt data
      let encryptedData = cipher.update(data, 'utf8', 'base64');
      encryptedData += cipher.final('base64');
      
      // Get auth tag
      const authTag = cipher.getAuthTag();
      
      // Combine encrypted data and auth tag
      const combinedData = Buffer.concat([
        Buffer.from(encryptedData, 'base64'),
        authTag
      ]).toString('base64');
      
      return {
        encryptedData: combinedData,
        iv: iv.toString('base64'),
        salt: this.activeKey.salt.toString('base64'),
        keyId: this.activeKey.id
      };
    } catch (error) {
      logger.error('Failed to encrypt data:', error);
      throw error;
    }
  }

  /**
   * Decrypt data
   */
  async decrypt(encryptedData: EncryptedData): Promise<string> {
    if (!this.config.enabled) {
      return encryptedData.encryptedData;
    }
    
    try {
      // Get encryption key
      const key = await this.getKeyById(encryptedData.keyId);
      
      // Decode IV and encrypted data
      const iv = Buffer.from(encryptedData.iv, 'base64');
      const combinedData = Buffer.from(encryptedData.encryptedData, 'base64');
      
      // Extract auth tag (last 16 bytes)
      const authTag = combinedData.slice(-16);
      const data = combinedData.slice(0, -16);
      
      // Create decipher
      const decipher = crypto.createDecipheriv(
        this.config.algorithm,
        key.key,
        iv,
        { authTagLength: 16 } as any
      ) as any;
      
      // Set auth tag
      decipher.setAuthTag(authTag);
      
      // Decrypt data
      let decryptedData = decipher.update(data);
      decryptedData = Buffer.concat([decryptedData, decipher.final()]);
      
      return decryptedData.toString('utf8');
    } catch (error) {
      logger.error('Failed to decrypt data:', error);
      throw error;
    }
  }

  /**
   * Register a column for encryption
   */
  async registerEncryptedColumn(tableName: string, columnName: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO encrypted_columns (table_name, column_name)
         VALUES ($1, $2)
         ON CONFLICT (table_name, column_name) DO NOTHING`,
        [tableName, columnName]
      );
      
      logger.info(`Registered encrypted column: ${tableName}.${columnName}`);
    } catch (error) {
      logger.error(`Failed to register encrypted column ${tableName}.${columnName}:`, error);
      throw error;
    }
  }

  /**
   * Get all encrypted columns
   */
  async getEncryptedColumns(): Promise<{ tableName: string; columnName: string }[]> {
    try {
      const result = await this.pool.query(
        'SELECT table_name, column_name FROM encrypted_columns ORDER BY table_name, column_name'
      );
      
      return result.rows.map(row => ({
        tableName: row.table_name,
        columnName: row.column_name
      }));
    } catch (error) {
      logger.error('Failed to get encrypted columns:', error);
      throw error;
    }
  }

  /**
   * Check if a column is encrypted
   */
  async isColumnEncrypted(tableName: string, columnName: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'SELECT COUNT(*) FROM encrypted_columns WHERE table_name = $1 AND column_name = $2',
        [tableName, columnName]
      );
      
      return parseInt(result.rows[0].count) > 0;
    } catch (error) {
      logger.error(`Failed to check if column ${tableName}.${columnName} is encrypted:`, error);
      throw error;
    }
  }

  /**
   * Re-encrypt data with a new key
   */
  async reencryptData(
    tableName: string,
    columnName: string,
    batchSize: number = 1000
  ): Promise<{ processed: number; encrypted: number }> {
    if (!this.activeKey) {
      throw new Error('No active encryption key available');
    }
    
    try {
      // Check if column is registered for encryption
      const isEncrypted = await this.isColumnEncrypted(tableName, columnName);
      
      if (!isEncrypted) {
        throw new Error(`Column ${tableName}.${columnName} is not registered for encryption`);
      }
      
      // Get total count
      const countResult = await this.pool.query(
        `SELECT COUNT(*) FROM ${tableName}`
      );
      
      const totalCount = parseInt(countResult.rows[0].count);
      
      if (totalCount === 0) {
        return { processed: 0, encrypted: 0 };
      }
      
      // Process in batches
      let processed = 0;
      let encrypted = 0;
      
      while (processed < totalCount) {
        const client = await this.pool.connect();
        
        try {
          await client.query('BEGIN');
          
          // Get batch of records
          const result = await client.query(
            `SELECT id, ${columnName} FROM ${tableName}
             ORDER BY id
             LIMIT $1 OFFSET $2`,
            [batchSize, processed]
          );
          
          if (result.rows.length === 0) {
            break;
          }
          
          // Process each record
          for (const row of result.rows) {
            if (row[columnName]) {
              try {
                // Check if data is already encrypted
                let data = row[columnName];
                let isAlreadyEncrypted = false;
                
                try {
                  // Try to parse as JSON to check if it's an EncryptedData object
                  const parsed = JSON.parse(data);
                  isAlreadyEncrypted = parsed.encryptedData && parsed.iv && parsed.keyId;
                } catch (e) {
                  // Not JSON, assume it's plain text
                  isAlreadyEncrypted = false;
                }
                
                if (!isAlreadyEncrypted) {
                  // Encrypt data
                  const encryptedData = await this.encrypt(data);
                  
                  // Update record
                  await client.query(
                    `UPDATE ${tableName}
                     SET ${columnName} = $1
                     WHERE id = $2`,
                    [JSON.stringify(encryptedData), row.id]
                  );
                  
                  encrypted++;
                }
              } catch (error) {
                logger.error(`Failed to encrypt data for record ${row.id}:`, error);
              }
            }
          }
          
          await client.query('COMMIT');
          
          processed += result.rows.length;
          logger.info(`Re-encrypted ${encrypted} records out of ${processed} processed`);
          
          // Emit progress event
          this.emit('reencryption-progress', {
            tableName,
            columnName,
            processed,
            total: totalCount,
            encrypted
          });
        } catch (error) {
          await client.query('ROLLBACK');
          logger.error(`Failed to process batch at offset ${processed}:`, error);
        } finally {
          client.release();
        }
      }
      
      return { processed, encrypted };
    } catch (error) {
      logger.error(`Failed to re-encrypt data for ${tableName}.${columnName}:`, error);
      throw error;
    }
  }

  /**
   * Get key rotation history
   */
  async getKeyHistory(): Promise<EncryptionKey[]> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM encryption_keys ORDER BY created_at DESC'
      );
      
      return result.rows.map(row => ({
        id: row.id,
        key: row.key_data,
        salt: row.salt,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        isActive: row.is_active
      }));
    } catch (error) {
      logger.error('Failed to get key history:', error);
      throw error;
    }
  }

  /**
   * End the encryption service
   */
  async end(): Promise<void> {
    try {
      logger.info('Ending data encryption service');
      
      // Stop key rotation interval
      if (this.keyRotationInterval) {
        clearInterval(this.keyRotationInterval);
        this.keyRotationInterval = null;
      }
      
      logger.info('Data encryption service ended');
    } catch (error) {
      logger.error('Failed to end data encryption service:', error);
      throw error;
    }
  }
} 