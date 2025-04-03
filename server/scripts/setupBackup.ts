import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { ShardingService } from '../services/sharding';
import { DynamicShardingService, DynamicShardingConfig } from '../services/dynamicSharding';
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
  schedule: {
    full: string; // cron expression
    incremental: string; // cron expression
  };
}

/**
 * Sets up backup and recovery procedures for the sharded database
 */
async function setupBackup() {
  logger.info('Setting up backup and recovery procedures');
  
  // Initialize sharding services
  const shardingService = ShardingService.getInstance();
  
  const dynamicShardingConfig: DynamicShardingConfig = {
    shards: [
      { id: 0, host: 'localhost', port: 5432, database: 'vici_dyn_0', user: 'postgres', password: 'postgres' },
      { id: 1, host: 'localhost', port: 5432, database: 'vici_dyn_1', user: 'postgres', password: 'postgres' },
      { id: 2, host: 'localhost', port: 5432, database: 'vici_dyn_2', user: 'postgres', password: 'postgres' },
      { id: 3, host: 'localhost', port: 5432, database: 'vici_dyn_3', user: 'postgres', password: 'postgres' }
    ],
    shardCount: 4,
    defaultShard: 0,
    initialShardCount: 4,
    maxShardCount: 16,
    minShardCount: 2,
    loadThreshold: 0.8,
    monitoringInterval: 300000,
    rebalanceThreshold: 0.2
  };
  
  const dynamicShardingService = new DynamicShardingService(dynamicShardingConfig);
  
  // Initialize backup configuration
  const backupConfig: BackupConfig = {
    backupDir: '/var/backups/vici',
    retentionDays: 30,
    compressionLevel: 9,
    parallelBackups: 4,
    schedule: {
      full: '0 0 * * 0', // Weekly full backup at midnight on Sunday
      incremental: '0 */6 * * *' // Incremental backup every 6 hours
    }
  };
  
  try {
    // Create backup directory
    if (!fs.existsSync(backupConfig.backupDir)) {
      fs.mkdirSync(backupConfig.backupDir, { recursive: true });
    }
    
    // Initialize shards
    logger.info('Initializing shards');
    await dynamicShardingService.initializeShards();
    
    // Perform initial full backup
    logger.info('Performing initial full backup');
    await performFullBackup(backupConfig);
    
    // Set up backup schedules
    logger.info('Setting up backup schedules');
    await setupBackupSchedules(backupConfig);
    
    // Set up cleanup schedule
    logger.info('Setting up backup cleanup schedule');
    await setupCleanupSchedule(backupConfig);
    
    logger.info('Backup setup completed successfully');
  } catch (error) {
    logger.error('Failed to set up backup procedures', { error });
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

/**
 * Set up backup schedules using cron
 */
async function setupBackupSchedules(config: BackupConfig): Promise<void> {
  // Set up full backup schedule
  const fullBackupCron = `${config.schedule.full} cd ${config.backupDir} && node ${path.join(__dirname, 'backup.js')} full`;
  await execAsync(`(crontab -l 2>/dev/null; echo "${fullBackupCron}") | crontab -`);
  
  // Set up incremental backup schedule
  const incrementalBackupCron = `${config.schedule.incremental} cd ${config.backupDir} && node ${path.join(__dirname, 'backup.js')} incremental`;
  await execAsync(`(crontab -l 2>/dev/null; echo "${incrementalBackupCron}") | crontab -`);
}

/**
 * Set up cleanup schedule for old backups
 */
async function setupCleanupSchedule(config: BackupConfig): Promise<void> {
  const cleanupCron = `0 0 * * * find ${config.backupDir} -type d -mtime +${config.retentionDays} -exec rm -rf {} \\;`;
  await execAsync(`(crontab -l 2>/dev/null; echo "${cleanupCron}") | crontab -`);
}

// Run the setup
setupBackup()
  .then(() => {
    logger.info('Backup setup completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Backup setup failed', { error });
    process.exit(1);
  }); 