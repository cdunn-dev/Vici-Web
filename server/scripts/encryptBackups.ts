import { logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const execAsync = promisify(exec);

/**
 * Configuration for backup encryption
 */
interface EncryptionConfig {
  /**
   * Source backup directory
   */
  sourceDir: string;
  
  /**
   * Encrypted backup directory
   */
  encryptedDir: string;
  
  /**
   * Path to the encryption key file
   */
  keyPath: string;
  
  /**
   * Encryption algorithm
   */
  algorithm: string;
  
  /**
   * Number of backups to encrypt
   */
  encryptCount: number;
  
  /**
   * Whether to verify encrypted backups
   */
  verifyAfterEncryption: boolean;
  
  /**
   * Whether to delete unencrypted backups after encryption
   */
  deleteAfterEncryption: boolean;
  
  /**
   * Whether to rotate encryption keys
   */
  rotateKeys: boolean;
  
  /**
   * Key rotation interval in days
   */
  keyRotationInterval: number;
}

/**
 * Encrypts database backups
 * @param config Encryption configuration
 * @returns Promise that resolves when encryption is complete
 */
async function encryptBackups(config: EncryptionConfig): Promise<void> {
  try {
    logger.info('Starting backup encryption');

    // Create encrypted directory if it doesn't exist
    if (!fs.existsSync(config.encryptedDir)) {
      fs.mkdirSync(config.encryptedDir, { recursive: true });
    }

    // Get list of backup files
    const backupFiles = fs.readdirSync(config.sourceDir)
      .filter(file => file.endsWith('.sql.gz'))
      .sort()
      .reverse()
      .slice(0, config.encryptCount);

    if (backupFiles.length === 0) {
      logger.info('No backup files found to encrypt');
      return;
    }

    // Read encryption key
    const key = fs.readFileSync(config.keyPath);

    // Encrypt each backup file
    for (const file of backupFiles) {
      const sourcePath = path.join(config.sourceDir, file);
      const encryptedPath = path.join(config.encryptedDir, `${file}.enc`);

      // Read backup file
      const data = fs.readFileSync(sourcePath);

      // Generate IV
      const iv = crypto.randomBytes(16);

      // Create cipher
      const cipher = crypto.createCipheriv(config.algorithm, key, iv);

      // Encrypt data
      const encrypted = Buffer.concat([
        cipher.update(data),
        cipher.final()
      ]);

      // Write encrypted file with IV prepended
      fs.writeFileSync(encryptedPath, Buffer.concat([iv, encrypted]));

      logger.info(`Encrypted backup file: ${file}`);

      // Verify encrypted backup if configured
      if (config.verifyAfterEncryption) {
        await verifyEncryptedBackup(encryptedPath, key, config.algorithm);
      }

      // Delete original backup if configured
      if (config.deleteAfterEncryption) {
        fs.unlinkSync(sourcePath);
        logger.info(`Deleted original backup file: ${file}`);
      }
    }

    // Check key rotation if configured
    if (config.rotateKeys) {
      await checkKeyRotation(config);
    }

    logger.info('Backup encryption completed successfully');
  } catch (error) {
    logger.error('Failed to encrypt backups:', error);
    throw error;
  }
}

/**
 * Verify an encrypted backup file
 */
async function verifyEncryptedBackup(
  encryptedPath: string,
  key: Buffer,
  algorithm: string
): Promise<void> {
  try {
    // Read encrypted file
    const data = fs.readFileSync(encryptedPath);

    // Extract IV and encrypted data
    const iv = data.slice(0, 16);
    const encrypted = data.slice(16);

    // Create decipher
    const decipher = crypto.createDecipheriv(algorithm, key, iv);

    // Decrypt data
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    // Verify decrypted data is valid gzip
    const { stdout } = await execAsync(`gzip -t -c "${decrypted}"`);
    if (stdout) {
      throw new Error('Invalid gzip data');
    }

    logger.info(`Verified encrypted backup: ${path.basename(encryptedPath)}`);
  } catch (error) {
    logger.error(`Failed to verify encrypted backup ${path.basename(encryptedPath)}:`, error);
    throw error;
  }
}

/**
 * Check and perform key rotation if needed
 */
async function checkKeyRotation(config: EncryptionConfig): Promise<void> {
  try {
    const keyStats = fs.statSync(config.keyPath);
    const keyAge = Date.now() - keyStats.mtimeMs;

    if (keyAge > config.keyRotationInterval) {
      logger.info('Starting key rotation');

      // Generate new key
      const newKey = crypto.randomBytes(32);
      const newKeyPath = `${config.keyPath}.new`;

      // Write new key
      fs.writeFileSync(newKeyPath, newKey);

      // Re-encrypt all backups with new key
      const encryptedFiles = fs.readdirSync(config.encryptedDir)
        .filter(file => file.endsWith('.enc'));

      for (const file of encryptedFiles) {
        const encryptedPath = path.join(config.encryptedDir, file);
        const tempPath = `${encryptedPath}.temp`;

        // Read encrypted file
        const data = fs.readFileSync(encryptedPath);

        // Extract IV and encrypted data
        const iv = data.slice(0, 16);
        const encrypted = data.slice(16);

        // Read old key
        const oldKey = fs.readFileSync(config.keyPath);

        // Decrypt with old key
        const decipher = crypto.createDecipheriv(config.algorithm, oldKey, iv);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final()
        ]);

        // Generate new IV
        const newIv = crypto.randomBytes(16);

        // Encrypt with new key
        const cipher = crypto.createCipheriv(config.algorithm, newKey, newIv);
        const reEncrypted = Buffer.concat([
          cipher.update(decrypted),
          cipher.final()
        ]);

        // Write re-encrypted file
        fs.writeFileSync(tempPath, Buffer.concat([newIv, reEncrypted]));

        // Replace old file with new one
        fs.renameSync(tempPath, encryptedPath);

        logger.info(`Re-encrypted backup with new key: ${file}`);
      }

      // Replace old key with new key
      fs.renameSync(newKeyPath, config.keyPath);

      logger.info('Key rotation completed successfully');
    }
  } catch (error) {
    logger.error('Failed to rotate encryption keys:', error);
    throw error;
  }
}

/**
 * Main function
 */
async function main(): Promise<void> {
  try {
    const config: EncryptionConfig = {
      sourceDir: process.env.BACKUP_SOURCE_DIR || '/var/lib/postgresql/backups',
      encryptedDir: process.env.BACKUP_ENCRYPTED_DIR || '/var/lib/postgresql/encrypted_backups',
      keyPath: process.env.ENCRYPTION_KEY_PATH || '/etc/postgresql/encryption.key',
      algorithm: 'aes-256-gcm',
      encryptCount: parseInt(process.env.BACKUP_ENCRYPT_COUNT || '5'),
      verifyAfterEncryption: process.env.VERIFY_AFTER_ENCRYPTION === 'true',
      deleteAfterEncryption: process.env.DELETE_AFTER_ENCRYPTION === 'true',
      rotateKeys: process.env.ROTATE_KEYS === 'true',
      keyRotationInterval: parseInt(process.env.KEY_ROTATION_INTERVAL || '2592000000') // 30 days
    };

    await encryptBackups(config);
  } catch (error) {
    logger.error('Backup encryption failed:', error);
    process.exit(1);
  }
}

// Run the script
main(); 