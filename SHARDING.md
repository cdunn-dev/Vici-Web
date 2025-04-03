# Database Sharding Strategies

This document provides a comprehensive overview of the sharding strategies implemented in the Vici-V1 project.

## Overview

Database sharding is a technique for horizontally partitioning data across multiple databases or tables to improve performance, scalability, and manageability. The Vici-V1 project implements multiple sharding strategies to address different use cases and requirements.

## Sharding Services

The project includes the following sharding services:

1. **RangeShardingService**: For time-series data
2. **GeographicShardingService**: For location-based data
3. **CompositeShardingService**: For combining multiple sharding strategies
4. **DynamicShardingService**: For load-based sharding

## Range-Based Sharding

The `RangeShardingService` is designed for time-series data, where data is naturally ordered by time.

### Key Features

- **Time-Based Partitioning**: Data is partitioned by time ranges (day, week, month, quarter, year)
- **Automatic Shard Creation**: Shards are created automatically based on configured intervals
- **Metadata Tracking**: Each shard includes metadata about its time range and status
- **Query Routing**: Queries are routed to the appropriate shard based on timestamp

### Implementation Details

```typescript
// Example: Creating a range-based shard
const rangeShardingService = new RangeShardingService({
  shardsTable: 'range_shards',
  shardMetadataTable: 'range_shard_metadata',
  useTransactions: true,
  timeout: 30000,
  validateBeforeUse: true,
  createBackup: true,
  backupDir: 'backups/range_shards',
  logShards: true
});

await rangeShardingService.initialize();

const shard = await rangeShardingService.createShard({
  startTime: new Date('2023-01-01'),
  endTime: new Date('2023-12-31'),
  interval: 'month',
  connection: {
    host: 'shard1.example.com',
    port: 5432,
    database: 'vici_shard1',
    user: 'shard_user',
    password: 'shard_password'
  },
  isActive: true
});
```

## Geographic Sharding

The `GeographicShardingService` is designed for location-based data, where data is associated with geographic regions.

### Key Features

- **Region-Based Partitioning**: Data is partitioned by geographic regions
- **Distance Calculation**: Uses the Haversine formula to calculate distances between locations
- **Location-Based Query Routing**: Queries are routed based on latitude and longitude
- **Region Metadata**: Each shard includes metadata about its geographic region

### Implementation Details

```typescript
// Example: Creating a geographic shard
const geographicShardingService = new GeographicShardingService({
  shardsTable: 'geographic_shards',
  shardMetadataTable: 'geographic_shard_metadata',
  useTransactions: true,
  timeout: 30000,
  validateBeforeUse: true,
  createBackup: true,
  backupDir: 'backups/geographic_shards',
  logShards: true
});

await geographicShardingService.initialize();

const shard = await geographicShardingService.createShard({
  region: 'North America',
  country: 'United States',
  latitude: 37.0902,
  longitude: -95.7129,
  radius: 1000, // kilometers
  connection: {
    host: 'us-shard.example.com',
    port: 5432,
    database: 'vici_us_shard',
    user: 'shard_user',
    password: 'shard_password'
  },
  isActive: true
});
```

## Composite Sharding

The `CompositeShardingService` allows combining multiple sharding strategies for more complex partitioning needs.

### Key Features

- **Multi-Dimensional Sharding**: Combines multiple sharding dimensions (time, location, custom)
- **Flexible Shard Keys**: Supports custom shard keys for specialized partitioning
- **Strategy Integration**: Integrates with range and geographic sharding services
- **Custom Logic**: Supports custom sharding logic through the shard key

### Implementation Details

```typescript
// Example: Creating a composite shard
const compositeShardingService = new CompositeShardingService({
  rangeShardingService: new RangeShardingService({}),
  geographicShardingService: new GeographicShardingService({}),
  shardsTable: 'composite_shards',
  shardMetadataTable: 'composite_shard_metadata',
  useTransactions: true,
  timeout: 30000,
  validateBeforeUse: true,
  createBackup: true,
  backupDir: 'backups/composite_shards',
  logShards: true
});

await compositeShardingService.initialize();

const shard = await compositeShardingService.createShard({
  shardKey: {
    timeRange: {
      start: new Date('2023-01-01'),
      end: new Date('2023-12-31')
    },
    location: {
      latitude: 37.0902,
      longitude: -95.7129
    },
    custom: {
      userType: 'premium',
      dataCategory: 'sensitive'
    }
  },
  connection: {
    host: 'composite-shard.example.com',
    port: 5432,
    database: 'vici_composite_shard',
    user: 'shard_user',
    password: 'shard_password'
  },
  isActive: true
});
```

## Dynamic Sharding

The `DynamicShardingService` creates and manages shards based on load metrics, automatically scaling the database as needed.

### Key Features

- **Load-Based Sharding**: Creates new shards when existing shards reach performance thresholds
- **Metrics Collection**: Monitors CPU, memory, disk usage, query count, and response time
- **Automatic Scaling**: Automatically creates new shards when performance thresholds are exceeded
- **Strategy Integration**: Works with range, geographic, and composite sharding strategies

### Implementation Details

```typescript
// Example: Creating a dynamic sharding service
const dynamicShardingService = new DynamicShardingService({
  rangeShardingService: new RangeShardingService({}),
  geographicShardingService: new GeographicShardingService({}),
  compositeShardingService: new CompositeShardingService({}),
  shardsTable: 'dynamic_shards',
  shardMetadataTable: 'dynamic_shard_metadata',
  metricsInterval: 60000, // 1 minute
  cpuThreshold: 80, // 80%
  memoryThreshold: 80, // 80%
  diskThreshold: 80, // 80%
  queriesPerMinuteThreshold: 1000,
  responseTimeThreshold: 1000, // 1 second
  useTransactions: true,
  timeout: 30000,
  validateBeforeUse: true,
  createBackup: true,
  backupDir: 'backups/dynamic_shards',
  logShards: true
});

await dynamicShardingService.initialize();
```

## Common Features Across All Sharding Services

All sharding services share the following features:

1. **Initialization**: Each service initializes by creating necessary database tables and loading existing shards
2. **Shard Management**: Services provide methods for creating, querying, and managing shards
3. **Metadata Tracking**: Each shard includes metadata that can be used for monitoring and management
4. **Health Monitoring**: Services track shard health, including response time, error count, and query count
5. **Transaction Support**: Operations can be performed within transactions for data consistency
6. **Backup Support**: Services can create backups before performing operations
7. **Logging**: Comprehensive logging for all operations

## Best Practices

1. **Choose the Right Strategy**: Select the sharding strategy that best fits your data and access patterns
2. **Monitor Shard Health**: Regularly monitor shard health and performance
3. **Backup Before Operations**: Always create backups before performing shard operations
4. **Use Transactions**: Use transactions for operations that modify multiple shards
5. **Validate Before Use**: Validate shard data before using it in production
6. **Log Shard Details**: Enable detailed logging for troubleshooting and monitoring

## Integration with Other Services

The sharding services integrate with the following services:

1. **ReadReplicaManager**: For database connections and query execution
2. **TimeSeriesOptimizationService**: For optimizing time-series data within shards
3. **MonitoringSystem**: For monitoring shard health and performance

## Future Enhancements

1. **Automatic Shard Rebalancing**: Automatically rebalance data across shards based on load
2. **Cross-Shard Queries**: Support for queries that span multiple shards
3. **Shard Migration**: Tools for migrating data between shards
4. **Shard Replication**: Support for replicating shards for high availability
5. **Shard Backup and Restore**: Comprehensive backup and restore capabilities for shards 