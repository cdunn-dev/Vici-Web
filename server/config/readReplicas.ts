import { PoolConfig } from 'pg';
import { ReadReplicaConfig } from '../services/readReplicaService';

export interface ReplicaConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  isActive?: boolean;
  lastChecked?: Date;
  responseTime?: number;
  errorCount?: number;
  queryCount?: number;
  lagSeconds?: number;
}

export const getPrimaryConfig = (): PoolConfig => {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'vici',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  };
};

export const getReplicaConfigs = (): ReplicaConfig[] => {
  const replicaCount = parseInt(process.env.REPLICA_COUNT || '0', 10);
  
  if (replicaCount === 0) {
    return [];
  }
  
  return Array.from({ length: replicaCount }, (_, i) => ({
    id: `replica-${i}`,
    name: process.env[`REPLICA_${i}_NAME`] || `Replica ${i}`,
    host: process.env[`REPLICA_${i}_HOST`] || 'localhost',
    port: parseInt(process.env[`REPLICA_${i}_PORT`] || '5432', 10),
    database: process.env[`REPLICA_${i}_DATABASE`] || 'vici',
    user: process.env[`REPLICA_${i}_USER`] || 'postgres',
    password: process.env[`REPLICA_${i}_PASSWORD`] || '',
  }));
};

export const getReadReplicaConfig = (): ReadReplicaConfig => {
  return {
    healthCheckInterval: parseInt(process.env.REPLICA_HEALTH_CHECK_INTERVAL || '30000', 10),
    responseTimeThreshold: parseInt(process.env.REPLICA_RESPONSE_TIME_THRESHOLD || '1000', 10),
    errorCountThreshold: parseInt(process.env.REPLICA_ERROR_COUNT_THRESHOLD || '5', 10),
    lagThresholdSeconds: parseInt(process.env.REPLICA_LAG_THRESHOLD_SECONDS || '10', 10),
    useWeightedRoundRobin: process.env.REPLICA_USE_WEIGHTED_ROUND_ROBIN === 'true',
    useLeastConnections: process.env.REPLICA_USE_LEAST_CONNECTIONS === 'true',
    useResponseTime: process.env.REPLICA_USE_RESPONSE_TIME === 'true',
    enableFailover: process.env.REPLICA_ENABLE_FAILOVER !== 'false',
    failoverTimeout: parseInt(process.env.REPLICA_FAILOVER_TIMEOUT || '5000', 10),
  };
}; 