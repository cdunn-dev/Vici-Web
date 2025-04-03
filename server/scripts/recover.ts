import { logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

interface RecoveryConfig {
  backupDir: string;
  targetShards: number[];
  timestamp?: string; // Optional timestamp to recover to
}

/**
 * Main recovery execution script
 */
async function main() {
  const args = process.argv.slice(2);
  const timestamp = args[0]; // Optional timestamp to recover to
  
  const config: RecoveryConfig = {
    backupDir: '/var/backups/vici',
    targetShards: [0, 1, 2, 3], // Default to all shards
    timestamp
  };
  
  try {
    await performRecovery(config);
    logger.info('Recovery completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Recovery failed', { error });
    process.exit(1);
  }
}

/**
 * Perform recovery of shards from backup
 */
async function performRecovery(config: RecoveryConfig): Promise<void> {
  // Find the appropriate backup to restore from
  const backupToRestore = await findBackupToRestore(config);
  if (!backupToRestore) {
    throw new Error('No suitable backup found for recovery');
  }
  
  logger.info(`Recovering from backup: ${backupToRestore}`);
  
  // Read the backup manifest
  const manifestPath = path.join(config.backupDir, backupToRestore, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  // Verify all required shards are present in the backup
  const missingShards = config.targetShards.filter(id => !manifest.shards.includes(id));
  if (missingShards.length > 0) {
    throw new Error(`Backup is missing required shards: ${missingShards.join(', ')}`);
  }
  
  // Perform parallel recovery
  const recoveryPromises = config.targetShards.map(async (shardId) => {
    const shardBackupPath = path.join(config.backupDir, backupToRestore, `shard-${shardId}.sql.gz`);
    
    if (!fs.existsSync(shardBackupPath)) {
      throw new Error(`Backup file not found for shard ${shardId}`);
    }
    
    try {
      // Stop any existing connections to the database
      await stopConnections(shardId);
      
      // Restore the backup
      await restoreShard(shardId, shardBackupPath);
      
      logger.info(`Recovered shard ${shardId}`);
    } catch (error) {
      logger.error(`Failed to recover shard ${shardId}`, { error });
      throw error;
    }
  });
  
  // Execute recoveries in parallel
  await Promise.all(recoveryPromises);
}

/**
 * Find the appropriate backup to restore from
 */
async function findBackupToRestore(config: RecoveryConfig): Promise<string | null> {
  // If a specific timestamp is provided, look for that backup
  if (config.timestamp) {
    const fullBackup = `full-${config.timestamp}`;
    const incrementalBackup = `incremental-${config.timestamp}`;
    
    if (fs.existsSync(path.join(config.backupDir, fullBackup))) {
      return fullBackup;
    }
    
    if (fs.existsSync(path.join(config.backupDir, incrementalBackup))) {
      return incrementalBackup;
    }
    
    throw new Error(`No backup found for timestamp: ${config.timestamp}`);
  }
  
  // Otherwise, find the most recent backup
  const backups = fs.readdirSync(config.backupDir)
    .filter(dir => dir.startsWith('full-') || dir.startsWith('incremental-'))
    .sort()
    .reverse();
  
  if (backups.length === 0) {
    return null;
  }
  
  return backups[0];
}

/**
 * Stop all connections to a shard's database
 */
async function stopConnections(shardId: number): Promise<void> {
  const shardConfig = {
    host: 'localhost',
    port: 5432,
    database: `vici_dyn_${shardId}`,
    user: 'postgres',
    password: 'postgres'
  };
  
  try {
    // Terminate all connections except our own
    const command = `PGPASSWORD=${shardConfig.password} psql -h ${shardConfig.host} -p ${shardConfig.port} -U ${shardConfig.user} -d ${shardConfig.database} -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${shardConfig.database}' AND pid <> pg_backend_pid();"`;
    await execAsync(command);
    
    logger.info(`Stopped connections to shard ${shardId}`);
  } catch (error) {
    logger.error(`Failed to stop connections to shard ${shardId}`, { error });
    throw error;
  }
}

/**
 * Restore a shard from backup
 */
async function restoreShard(shardId: number, backupPath: string): Promise<void> {
  const shardConfig = {
    host: 'localhost',
    port: 5432,
    database: `vici_dyn_${shardId}`,
    user: 'postgres',
    password: 'postgres'
  };
  
  try {
    // Drop and recreate the database
    const dropCommand = `PGPASSWORD=${shardConfig.password} dropdb -h ${shardConfig.host} -p ${shardConfig.port} -U ${shardConfig.user} ${shardConfig.database}`;
    const createCommand = `PGPASSWORD=${shardConfig.password} createdb -h ${shardConfig.host} -p ${shardConfig.port} -U ${shardConfig.user} ${shardConfig.database}`;
    
    try {
      await execAsync(dropCommand);
    } catch (error) {
      // Ignore error if database doesn't exist
    }
    
    await execAsync(createCommand);
    
    // Restore from backup
    const restoreCommand = `gunzip -c ${backupPath} | PGPASSWORD=${shardConfig.password} psql -h ${shardConfig.host} -p ${shardConfig.port} -U ${shardConfig.user} -d ${shardConfig.database}`;
    await execAsync(restoreCommand);
    
    logger.info(`Restored shard ${shardId} from backup`);
  } catch (error) {
    logger.error(`Failed to restore shard ${shardId}`, { error });
    throw error;
  }
}

// Run the recovery
main(); 