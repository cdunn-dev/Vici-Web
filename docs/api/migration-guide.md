# API Migration Guide

This guide helps you migrate your application between different versions of the Vici API.

## Available Migration Guides

- [Migrating from v1 to v2](#migrating-from-v1-to-v2)

## Migrating from v1 to v2

### Overview

API v2 introduces several improvements and new features while maintaining backward compatibility where possible. This guide will help you transition your application from v1 to v2.

### Breaking Changes

#### Authentication

- The `/auth/login` endpoint now requires a `client_id` parameter
  ```diff
  // v1
  POST /auth/login
  {
    "email": "user@example.com",
    "password": "password123"
  }
  
  // v2
  POST /auth/login
  {
    "email": "user@example.com",
    "password": "password123",
    "client_id": "your_client_id"
  }
  ```

#### User Endpoints

- The `settings` object has been removed from the user profile
- A new `preferences` object has been added to the user profile
  ```diff
  // v1 User Profile
  {
    "id": "123",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "settings": {
      "notifications": true,
      "theme": "dark"
    }
  }
  
  // v2 User Profile
  {
    "id": "123",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "preferences": {
      "notifications": {
        "email": true,
        "push": false,
        "sms": false
      },
      "theme": "dark",
      "language": "en",
      "timezone": "UTC"
    }
  }
  ```

#### Workout Endpoints

- The exercise format has been updated to include more metadata
  ```diff
  // v1 Exercise
  {
    "id": "456",
    "name": "Bench Press",
    "sets": 3,
    "reps": 10,
    "weight": 135
  }
  
  // v2 Exercise
  {
    "id": "456",
    "name": "Bench Press",
    "sets": 3,
    "reps": 10,
    "weight": 135,
    "metadata": {
      "muscleGroups": ["chest", "triceps", "shoulders"],
      "equipment": ["barbell", "bench"],
      "difficulty": "intermediate"
    }
  }
  ```

### New Features

#### Webhooks

API v2 introduces a webhook system for real-time notifications. You can subscribe to various events such as:

- Workout completion
- Achievement unlocked
- Program progress updates

To set up webhooks, use the new `/webhooks` endpoints:

```http
POST /webhooks
{
  "url": "https://your-server.com/webhook",
  "events": ["workout.completed", "achievement.unlocked"],
  "secret": "your_webhook_secret"
}
```

For more information, see the [Webhooks Documentation](/docs/webhooks).

### Deprecation Timeline

- API v1 will be deprecated on December 31, 2025
- After deprecation, v1 will continue to work but will include deprecation warnings in response headers
- API v1 will be sunset (completely removed) on December 31, 2026

### Migration Steps

1. **Update Authentication**
   - Add the `client_id` parameter to all login requests
   - Update your authentication flow to handle the new response format

2. **Update User Profile Handling**
   - Replace references to `settings` with `preferences`
   - Update your UI to handle the new preferences structure

3. **Update Workout Handling**
   - Update your code to handle the new exercise format
   - Take advantage of the additional metadata for enhanced features

4. **Implement Webhooks (Optional)**
   - Set up webhook endpoints on your server
   - Subscribe to relevant events
   - Implement webhook signature verification

### Testing Your Migration

1. Use the [API Testing Tool](https://api.vici.com/test) to verify your changes
2. Run your application against the v2 API in a staging environment
3. Monitor for any deprecation warnings or errors

### Need Help?

If you encounter any issues during migration, please contact our support team:

- Email: api-support@vici.com
- Documentation: https://docs.vici.com
- Status page: https://status.vici.com 