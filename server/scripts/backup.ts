import { logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

interface BackupConfig {
  backupDir: string;
  retentionDays: number;
  compressionLevel: number;
  parallelBackups: number;
}

/**
 * Main backup execution script
 */
async function main() {
  const args = process.argv.slice(2);
  const backupType = args[0]; // 'full' or 'incremental'
  
  if (!backupType || !['full', 'incremental'].includes(backupType)) {
    logger.error('Invalid backup type. Must be either "full" or "incremental"');
    process.exit(1);
  }
  
  const config: BackupConfig = {
    backupDir: '/var/backups/vici',
    retentionDays: 30,
    compressionLevel: 9,
    parallelBackups: 4
  };
  
  try {
    if (backupType === 'full') {
      await performFullBackup(config);
    } else {
      await performIncrementalBackup(config);
    }
    
    logger.info(`${backupType} backup completed successfully`);
    process.exit(0);
  } catch (error) {
    logger.error(`${backupType} backup failed`, { error });
    process.exit(1);
  }
}

/**
 * Perform a full backup of all shards
 */
async function performFullBackup(config: BackupConfig): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(config.backupDir, `full-${timestamp}`);
  
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath);
  }
  
  // Get all shard configurations
  const shards = Array.from({ length: 4 }, (_, i) => ({
    id: i,
    host: 'localhost',
    port: 5432,
    database: `vici_dyn_${i}`,
    user: 'postgres',
    password: 'postgres'
  }));
  
  // Perform parallel backups
  const backupPromises = shards.map(async (shard) => {
    const shardBackupPath = path.join(backupPath, `shard-${shard.id}.sql.gz`);
    
    try {
      const command = `PGPASSWORD=${shard.password} pg_dump -h ${shard.host} -p ${shard.port} -U ${shard.user} -d ${shard.database} | gzip -${config.compressionLevel} > ${shardBackupPath}`;
      await execAsync(command);
      
      logger.info(`Backed up shard ${shard.id}`, { path: shardBackupPath });
    } catch (error) {
      logger.error(`Failed to backup shard ${shard.id}`, { error });
      throw error;
    }
  });
  
  // Execute backups in parallel with a limit
  for (let i = 0; i < backupPromises.length; i += config.parallelBackups) {
    const batch = backupPromises.slice(i, i + config.parallelBackups);
    await Promise.all(batch);
  }
  
  // Create backup manifest
  const manifest = {
    timestamp,
    type: 'full',
    shards: shards.map(s => s.id),
    compressionLevel: config.compressionLevel
  };
  
  fs.writeFileSync(
    path.join(backupPath, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}

/**
 * Perform an incremental backup of all shards
 */
async function performIncrementalBackup(config: BackupConfig): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(config.backupDir, `incremental-${timestamp}`);
  
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath);
  }
  
  // Get all shard configurations
  const shards = Array.from({ length: 4 }, (_, i) => ({
    id: i,
    host: 'localhost',
    port: 5432,
    database: `vici_dyn_${i}`,
    user: 'postgres',
    password: 'postgres'
  }));
  
  // Perform parallel backups
  const backupPromises = shards.map(async (shard) => {
    const shardBackupPath = path.join(backupPath, `shard-${shard.id}.sql.gz`);
    
    try {
      // Get the last backup timestamp for this shard
      const lastBackup = await getLastBackupTimestamp(shard.id, config.backupDir);
      
      // Build the incremental backup command
      const command = `PGPASSWORD=${shard.password} pg_dump -h ${shard.host} -p ${shard.port} -U ${shard.user} -d ${shard.database} --since="${lastBackup}" | gzip -${config.compressionLevel} > ${shardBackupPath}`;
      await execAsync(command);
      
      logger.info(`Backed up shard ${shard.id} incrementally`, { path: shardBackupPath });
    } catch (error) {
      logger.error(`Failed to backup shard ${shard.id} incrementally`, { error });
      throw error;
    }
  });
  
  // Execute backups in parallel with a limit
  for (let i = 0; i < backupPromises.length; i += config.parallelBackups) {
    const batch = backupPromises.slice(i, i + config.parallelBackups);
    await Promise.all(batch);
  }
  
  // Create backup manifest
  const manifest = {
    timestamp,
    type: 'incremental',
    shards: shards.map(s => s.id),
    compressionLevel: config.compressionLevel
  };
  
  fs.writeFileSync(
    path.join(backupPath, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}

/**
 * Get the timestamp of the last backup for a shard
 */
async function getLastBackupTimestamp(shardId: number, backupDir: string): Promise<string> {
  // Find the most recent full backup
  const fullBackups = fs.readdirSync(backupDir)
    .filter(dir => dir.startsWith('full-'))
    .sort()
    .reverse();
  
  if (fullBackups.length === 0) {
    throw new Error('No full backup found');
  }
  
  const lastFullBackup = fullBackups[0];
  const manifestPath = path.join(backupDir, lastFullBackup, 'manifest.json');
  
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest found for backup ${lastFullBackup}`);
  }
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return manifest.timestamp;
}

// Run the backup
main(); 