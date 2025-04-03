import { logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * Configuration for backup verification
 */
interface VerificationConfig {
  /**
   * Directory containing backups
   */
  backupDir: string;
  
  /**
   * Directory for test restores
   */
  testRestoreDir: string;
  
  /**
   * Number of backups to verify
   */
  verifyCount: number;
  
  /**
   * Whether to perform integrity checks
   */
  checkIntegrity: boolean;
  
  /**
   * Whether to test restore
   */
  testRestore: boolean;
}

/**
 * Verifies database backups
 * @param config Verification configuration
 * @returns Promise that resolves when verification is complete
 */
async function verifyBackup(config: VerificationConfig): Promise<void> {
  logger.info('Starting backup verification', { config });
  
  try {
    // Create test restore directory if it doesn't exist
    if (!fs.existsSync(config.testRestoreDir)) {
      fs.mkdirSync(config.testRestoreDir, { recursive: true });
    }
    
    // Get list of backup files
    const backupFiles = fs.readdirSync(config.backupDir)
      .filter(file => file.endsWith('.sql.gz'))
      .sort()
      .reverse()
      .slice(0, config.verifyCount);
    
    logger.info(`Found ${backupFiles.length} backup files to verify`);
    
    // Verify each backup
    for (const backupFile of backupFiles) {
      const backupPath = path.join(config.backupDir, backupFile);
      
      logger.info(`Verifying backup: ${backupFile}`);
      
      // Check file integrity
      if (config.checkIntegrity) {
        await checkBackupIntegrity(backupPath);
      }
      
      // Test restore if enabled
      if (config.testRestore) {
        await testBackupRestore(backupPath, config.testRestoreDir);
      }
      
      logger.info(`Backup verification completed: ${backupFile}`);
    }
    
    logger.info('Backup verification completed successfully');
  } catch (error) {
    logger.error('Backup verification failed', { error });
    throw error;
  }
}

/**
 * Checks the integrity of a backup file
 * @param backupPath Path to the backup file
 * @returns Promise that resolves when integrity check is complete
 */
async function checkBackupIntegrity(backupPath: string): Promise<void> {
  logger.info(`Checking integrity of backup: ${backupPath}`);
  
  try {
    // Check if file exists
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }
    
    // Check file size
    const stats = fs.statSync(backupPath);
    if (stats.size === 0) {
      throw new Error(`Backup file is empty: ${backupPath}`);
    }
    
    // Check if file is a valid gzip file
    const { stdout } = await execAsync(`gzip -t ${backupPath}`);
    if (stdout) {
      throw new Error(`Backup file is not a valid gzip file: ${backupPath}`);
    }
    
    // Check if file contains SQL data
    const { stdout: sqlCheck } = await execAsync(`gunzip -c ${backupPath} | head -n 1`);
    if (!sqlCheck.includes('-- PostgreSQL database dump')) {
      throw new Error(`Backup file does not contain valid SQL data: ${backupPath}`);
    }
    
    logger.info(`Integrity check passed for backup: ${backupPath}`);
  } catch (error) {
    logger.error(`Integrity check failed for backup: ${backupPath}`, { error });
    throw error;
  }
}

/**
 * Tests restoring a backup to a test database
 * @param backupPath Path to the backup file
 * @param testRestoreDir Directory for test restores
 * @returns Promise that resolves when test restore is complete
 */
async function testBackupRestore(backupPath: string, testRestoreDir: string): Promise<void> {
  logger.info(`Testing restore of backup: ${backupPath}`);
  
  try {
    // Create test database name
    const backupFileName = path.basename(backupPath, '.sql.gz');
    const testDbName = `test_restore_${backupFileName}`;
    
    // Create test database
    await execAsync(`createdb ${testDbName}`);
    
    try {
      // Restore backup to test database
      await execAsync(`gunzip -c ${backupPath} | psql ${testDbName}`);
      
      // Verify restore by checking table counts
      const { stdout: tableCounts } = await execAsync(`
        psql ${testDbName} -c "
          SELECT table_name, COUNT(*) as row_count
          FROM (
            SELECT 'users' as table_name, COUNT(*) FROM users
            UNION ALL
            SELECT 'training_plans', COUNT(*) FROM training_plans
            UNION ALL
            SELECT 'workout_notes', COUNT(*) FROM workout_notes
          ) as counts
          GROUP BY table_name
        "
      `);
      
      logger.info(`Test restore completed for ${testDbName}`, { tableCounts });
    } finally {
      // Drop test database
      await execAsync(`dropdb ${testDbName}`);
    }
  } catch (error) {
    logger.error(`Test restore failed for backup: ${backupPath}`, { error });
    throw error;
  }
}

// Main function
async function main(): Promise<void> {
  const config: VerificationConfig = {
    backupDir: process.env.BACKUP_DIR || '/var/lib/postgresql/backups',
    testRestoreDir: process.env.TEST_RESTORE_DIR || '/tmp/test_restores',
    verifyCount: parseInt(process.env.VERIFY_COUNT || '5'),
    checkIntegrity: process.env.CHECK_INTEGRITY !== 'false',
    testRestore: process.env.TEST_RESTORE !== 'false'
  };
  
  try {
    await verifyBackup(config);
    process.exit(0);
  } catch (error) {
    logger.error('Backup verification failed', { error });
    process.exit(1);
  }
}

// Run the script
main(); 