/**
 * API Versioning Configuration
 * 
 * This file defines the API versioning strategy for the application.
 * It includes supported versions, deprecated versions, and sunset dates.
 */

export const apiVersioningConfig = {
  // Default version to use when no version is specified
  defaultVersion: 'v1',
  
  // All supported API versions
  supportedVersions: ['v1', 'v2'],
  
  // Versions that are deprecated but still supported
  // Format: version -> deprecation date (ISO string)
  deprecatedVersions: {
    'v1': '2025-12-31', // v1 will be deprecated on December 31, 2025
  },
  
  // Versions that are scheduled for sunset (complete removal)
  // Format: version -> sunset date (ISO string)
  sunsetVersions: {
    // No versions are currently scheduled for sunset
  },
  
  // Version-specific route handlers
  // This allows for different implementations of the same endpoint based on version
  versionSpecificRoutes: {
    // Example:
    // 'v2': {
    //   '/users': v2UserRoutes,
    //   '/workouts': v2WorkoutRoutes,
    // }
  }
};

/**
 * Migration guides for version updates
 * These guides help clients migrate from one version to another
 */
export const migrationGuides = {
  'v1-to-v2': {
    title: 'Migrating from v1 to v2',
    description: 'This guide helps you migrate your application from API v1 to v2',
    changes: [
      {
        endpoint: '/users',
        changes: [
          {
            type: 'added',
            field: 'preferences',
            description: 'User preferences object has been added'
          },
          {
            type: 'removed',
            field: 'settings',
            description: 'User settings object has been removed'
          }
        ]
      },
      {
        endpoint: '/workouts',
        changes: [
          {
            type: 'modified',
            field: 'exercises',
            description: 'Exercise format has been updated to include more metadata'
          }
        ]
      }
    ],
    breakingChanges: [
      {
        description: 'The /auth/login endpoint now requires a client_id parameter',
        impact: 'High',
        migration: 'Add the client_id parameter to all login requests'
      }
    ],
    newFeatures: [
      {
        name: 'Webhooks',
        description: 'New webhook system for real-time notifications',
        documentation: '/docs/webhooks'
      }
    ]
  }
}; 