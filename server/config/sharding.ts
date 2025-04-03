import { ShardingConfig } from '../services/sharding';

export const getShardingConfig = (): ShardingConfig => {
  const shardCount = parseInt(process.env.SHARD_COUNT || '2', 10);
  const defaultShard = parseInt(process.env.DEFAULT_SHARD || '0', 10);

  const shards = Array.from({ length: shardCount }, (_, i) => ({
    id: i,
    host: process.env[`SHARD_${i}_HOST`] || 'localhost',
    port: parseInt(process.env[`SHARD_${i}_PORT`] || '5432', 10),
    database: process.env[`SHARD_${i}_DATABASE`] || 'vici',
    user: process.env[`SHARD_${i}_USER`] || 'postgres',
    password: process.env[`SHARD_${i}_PASSWORD`] || '',
  }));

  return {
    shards,
    shardCount,
    defaultShard,
  };
}; 