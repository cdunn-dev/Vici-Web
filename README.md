# Vici API

A secure and scalable fitness API built with Node.js, Express, and TypeScript.

## Features

- **API Versioning**: Support for multiple API versions with deprecation warnings and sunset notifications
- **Authentication**: OAuth 2.0 with refresh tokens and API key management
- **Security**: Comprehensive security measures including request signing, IP whitelisting, and security headers
- **Rate Limiting**: Configurable rate limiting based on subscription tiers
- **Documentation**: OpenAPI specification and version-specific documentation

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- Redis >= 6.0.0

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/vici-api.git
   cd vici-api
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory with the following variables:
   ```
   PORT=3000
   NODE_ENV=development
   OAUTH_TOKEN_SECRET=your-oauth-token-secret
   REQUEST_SIGNING_SECRET=your-request-signing-secret
   REDIS_URL=redis://localhost:6379
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

## API Security

### OAuth 2.0 Authentication

The API uses OAuth 2.0 for user authentication with the following features:

- Access tokens with configurable expiration
- Refresh tokens for long-term access
- Scope-based authorization
- Token revocation

Example:
```typescript
// Apply OAuth authentication middleware
router.use('/users', oauthAuth, userRoutes);

// Check for required scopes
router.use('/admin', oauthAuth, requireScopes(['admin']), adminRoutes);
```

### API Key Management

API keys are available for third-party integrations with the following features:

- Secure key generation
- Rate limiting based on subscription tiers
- Key expiration
- Scope-based access control

Example:
```typescript
// Apply API key authentication middleware
router.use('/llm', apiKeyAuth, requireScopes(['llm:access']), llmRoutes);
```

### Request Signing

Sensitive operations require request signing to prevent tampering:

- HMAC-based signatures
- Timestamp validation to prevent replay attacks
- Nonce generation to ensure uniqueness

Example:
```typescript
// Apply request signing middleware for sensitive operations
router.post('/sensitive-operation', requestSigning(process.env.REQUEST_SIGNING_SECRET), sensitiveOperationHandler);
```

### IP Whitelisting

Admin endpoints are protected by IP whitelisting:

- Support for individual IP addresses
- CIDR notation for IP ranges
- Redis-based storage for distributed environments

Example:
```typescript
// Apply IP whitelisting middleware for admin endpoints
router.use('/admin', ipWhitelist, adminRoutes);
```

### Security Headers

The API applies comprehensive security headers to all responses:

- Content Security Policy
- X-Content-Type-Options
- X-Frame-Options
- X-XSS-Protection
- Referrer-Policy
- Permissions-Policy

### CORS Configuration

Cross-Origin Resource Sharing is configured with:

- Allowed origins
- Allowed methods
- Allowed headers
- Exposed headers
- Credentials support
- Preflight caching

## API Documentation

API documentation is available at `/api/docs` and follows the OpenAPI specification.

## License

This project is licensed under the MIT License - see the LICENSE file for details. 