import { logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * Configuration for backup replication
 */
interface ReplicationConfig {
  /**
   * Source backup directory
   */
  sourceDir: string;
  
  /**
   * Target regions and their backup directories
   */
  targetRegions: {
    [region: string]: {
      /**
       * Backup directory in the target region
       */
      backupDir: string;
      
      /**
       * SSH host for the target region
       */
      sshHost: string;
      
      /**
       * SSH user for the target region
       */
      sshUser: string;
      
      /**
       * SSH key path for the target region
       */
      sshKeyPath: string;
    };
  };
  
  /**
   * Number of backups to replicate
   */
  replicateCount: number;
  
  /**
   * Whether to verify backups after replication
   */
  verifyAfterReplication: boolean;
  
  /**
   * Whether to delete old backups in target regions
   */
  cleanupOldBackups: boolean;
  
  /**
   * Number of backups to keep in target regions
   */
  keepBackupCount: number;
}

/**
 * Replicates backups to target regions
 * @param config Replication configuration
 * @returns Promise that resolves when replication is complete
 */
async function replicateBackups(config: ReplicationConfig): Promise<void> {
  logger.info('Starting backup replication', { config });
  
  try {
    // Get list of backup files to replicate
    const backupFiles = fs.readdirSync(config.sourceDir)
      .filter(file => file.endsWith('.sql.gz'))
      .sort()
      .reverse()
      .slice(0, config.replicateCount);
    
    logger.info(`Found ${backupFiles.length} backup files to replicate`);
    
    // Replicate to each target region
    for (const [region, target] of Object.entries(config.targetRegions)) {
      logger.info(`Replicating backups to region: ${region}`);
      
      // Create backup directory in target region if it doesn't exist
      await execAsync(`ssh -i ${target.sshKeyPath} ${target.sshUser}@${target.sshHost} "mkdir -p ${target.backupDir}"`);
      
      // Replicate each backup file
      for (const backupFile of backupFiles) {
        const sourcePath = path.join(config.sourceDir, backupFile);
        const targetPath = `${target.sshUser}@${target.sshHost}:${target.backupDir}/${backupFile}`;
        
        logger.info(`Replicating backup: ${backupFile} to ${region}`);
        
        // Copy backup file to target region
        await execAsync(`scp -i ${target.sshKeyPath} ${sourcePath} ${targetPath}`);
        
        // Verify backup if enabled
        if (config.verifyAfterReplication) {
          await verifyReplicatedBackup(target, backupFile);
        }
        
        logger.info(`Backup replication completed: ${backupFile} to ${region}`);
      }
      
      // Clean up old backups if enabled
      if (config.cleanupOldBackups) {
        await cleanupOldBackups(target, config.keepBackupCount);
      }
    }
    
    logger.info('Backup replication completed successfully');
  } catch (error) {
    logger.error('Backup replication failed', { error });
    throw error;
  }
}

/**
 * Verifies a replicated backup
 * @param target Target region configuration
 * @param backupFile Backup file name
 * @returns Promise that resolves when verification is complete
 */
async function verifyReplicatedBackup(
  target: ReplicationConfig['targetRegions'][string],
  backupFile: string
): Promise<void> {
  logger.info(`Verifying replicated backup: ${backupFile}`);
  
  try {
    // Check if file exists in target region
    const { stdout: fileCheck } = await execAsync(
      `ssh -i ${target.sshKeyPath} ${target.sshUser}@${target.sshHost} "test -f ${target.backupDir}/${backupFile} && echo 'exists'"`
    );
    
    if (!fileCheck.includes('exists')) {
      throw new Error(`Replicated backup file not found: ${backupFile}`);
    }
    
    // Check file size in target region
    const { stdout: sizeCheck } = await execAsync(
      `ssh -i ${target.sshKeyPath} ${target.sshUser}@${target.sshHost} "stat -f %z ${target.backupDir}/${backupFile}"`
    );
    
    const targetSize = parseInt(sizeCheck);
    const sourceSize = fs.statSync(path.join(process.env.BACKUP_DIR || '', backupFile)).size;
    
    if (targetSize !== sourceSize) {
      throw new Error(`Replicated backup file size mismatch: ${backupFile}`);
    }
    
    // Check if file is a valid gzip file in target region
    const { stdout: gzipCheck } = await execAsync(
      `ssh -i ${target.sshKeyPath} ${target.sshUser}@${target.sshHost} "gzip -t ${target.backupDir}/${backupFile}"`
    );
    
    if (gzipCheck) {
      throw new Error(`Replicated backup file is not a valid gzip file: ${backupFile}`);
    }
    
    logger.info(`Verification passed for replicated backup: ${backupFile}`);
  } catch (error) {
    logger.error(`Verification failed for replicated backup: ${backupFile}`, { error });
    throw error;
  }
}

/**
 * Cleans up old backups in a target region
 * @param target Target region configuration
 * @param keepCount Number of backups to keep
 * @returns Promise that resolves when cleanup is complete
 */
async function cleanupOldBackups(
  target: ReplicationConfig['targetRegions'][string],
  keepCount: number
): Promise<void> {
  logger.info(`Cleaning up old backups in target region`);
  
  try {
    // Get list of backup files in target region
    const { stdout: backupList } = await execAsync(
      `ssh -i ${target.sshKeyPath} ${target.sshUser}@${target.sshHost} "ls -t ${target.backupDir}/*.sql.gz"`
    );
    
    const backupFiles = backupList.split('\n').filter(Boolean);
    
    // Delete old backups
    if (backupFiles.length > keepCount) {
      const filesToDelete = backupFiles.slice(keepCount);
      
      for (const file of filesToDelete) {
        logger.info(`Deleting old backup: ${file}`);
        await execAsync(
          `ssh -i ${target.sshKeyPath} ${target.sshUser}@${target.sshHost} "rm ${file}"`
        );
      }
    }
    
    logger.info(`Cleanup completed in target region`);
  } catch (error) {
    logger.error(`Cleanup failed in target region`, { error });
    throw error;
  }
}

// Main function
async function main(): Promise<void> {
  const config: ReplicationConfig = {
    sourceDir: process.env.BACKUP_DIR || '/var/lib/postgresql/backups',
    targetRegions: {
      'us-east-1': {
        backupDir: '/var/lib/postgresql/backups',
        sshHost: process.env.US_EAST_1_HOST || '',
        sshUser: process.env.US_EAST_1_USER || '',
        sshKeyPath: process.env.US_EAST_1_KEY_PATH || ''
      },
      'eu-west-1': {
        backupDir: '/var/lib/postgresql/backups',
        sshHost: process.env.EU_WEST_1_HOST || '',
        sshUser: process.env.EU_WEST_1_USER || '',
        sshKeyPath: process.env.EU_WEST_1_KEY_PATH || ''
      }
    },
    replicateCount: parseInt(process.env.REPLICATE_COUNT || '5'),
    verifyAfterReplication: process.env.VERIFY_AFTER_REPLICATION !== 'false',
    cleanupOldBackups: process.env.CLEANUP_OLD_BACKUPS !== 'false',
    keepBackupCount: parseInt(process.env.KEEP_BACKUP_COUNT || '10')
  };
  
  try {
    await replicateBackups(config);
    process.exit(0);
  } catch (error) {
    logger.error('Backup replication failed', { error });
    process.exit(1);
  }
}

// Run the script
main(); 