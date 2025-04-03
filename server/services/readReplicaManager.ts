import { ReadReplicaService } from './readReplicaService';
import { getPrimaryConfig, getReplicaConfigs, getReadReplicaConfig } from '../config/readReplicas';
import { logger } from '../utils/logger';

class ReadReplicaManager {
  private static instance: ReadReplicaManager;
  private readReplicaService: ReadReplicaService | null = null;
  private isInitialized = false;

  private constructor() {}

  public static getInstance(): ReadReplicaManager {
    if (!ReadReplicaManager.instance) {
      ReadReplicaManager.instance = new ReadReplicaManager();
    }
    return ReadReplicaManager.instance;
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      const primaryConfig = getPrimaryConfig();
      const replicaConfigs = getReplicaConfigs();
      const readReplicaConfig = getReadReplicaConfig();

      // Create the read replica service
      this.readReplicaService = new ReadReplicaService(primaryConfig, readReplicaConfig);

      // Initialize the service
      await this.readReplicaService.initialize();

      // Add replicas if any are configured
      if (replicaConfigs.length > 0) {
        for (const replicaConfig of replicaConfigs) {
          // Convert ReplicaConfig to ReplicaInstance by adding required properties
          this.readReplicaService.addReplica({
            ...replicaConfig,
            isActive: true,
            lastChecked: new Date(),
            responseTime: 0,
            errorCount: 0,
            queryCount: 0,
            lagSeconds: 0
          });
        }
        logger.info(`Added ${replicaConfigs.length} read replicas`);
      } else {
        logger.warn('No read replicas configured. All queries will be routed to the primary database.');
      }

      this.isInitialized = true;
      logger.info('Read replica manager initialized');
    } catch (error) {
      logger.error('Failed to initialize read replica manager', error);
      throw error;
    }
  }

  public getReadReplicaService(): ReadReplicaService | null {
    if (!this.isInitialized) {
      logger.warn('Read replica manager not initialized');
      return null;
    }
    return this.readReplicaService;
  }

  public async query(text: string, params?: any[], useReplica: boolean = true): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.readReplicaService) {
      throw new Error('Read replica service not initialized');
    }

    return this.readReplicaService.query(text, params, useReplica);
  }

  public async transaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.readReplicaService) {
      throw new Error('Read replica service not initialized');
    }

    return this.readReplicaService.transaction(callback);
  }

  public async end(): Promise<void> {
    if (this.readReplicaService) {
      await this.readReplicaService.end();
      this.readReplicaService = null;
      this.isInitialized = false;
      logger.info('Read replica manager ended');
    }
  }
}

export default ReadReplicaManager; 