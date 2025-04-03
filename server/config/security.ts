/**
 * Security Configuration
 * 
 * This file contains configuration settings for API security features
 */

// OAuth 2.0 configuration
export const oauthConfig = {
  // Token expiration times (in seconds)
  accessTokenExpiry: 3600, // 1 hour
  refreshTokenExpiry: 2592000, // 30 days
  authCodeExpiry: 600, // 10 minutes
  
  // Token signing secret (should be stored in environment variables in production)
  tokenSecret: process.env.OAUTH_TOKEN_SECRET || 'your-oauth-token-secret',
  
  // Available scopes
  scopes: [
    'user:read',
    'user:write',
    'workout:read',
    'workout:write',
    'training:read',
    'training:write',
    'admin',
    'llm:access'
  ],
  
  // Default scopes for new tokens
  defaultScopes: ['user:read', 'workout:read', 'training:read']
};

// API Key configuration
export const apiKeyConfig = {
  // API key expiration time (in seconds)
  expiry: 31536000, // 1 year
  
  // Rate limiting configuration
  rateLimits: {
    free: 100, // 100 requests per hour
    basic: 1000, // 1000 requests per hour
    premium: 10000, // 10000 requests per hour
    enterprise: 100000 // 100000 requests per hour
  },
  
  // Default rate limit for new API keys
  defaultRateLimit: 100
};

// Request signing configuration
export const requestSigningConfig = {
  // Maximum time difference between request timestamp and server time (in seconds)
  maxTimeDiff: 300, // 5 minutes
  
  // Request signing secret (should be stored in environment variables in production)
  signingSecret: process.env.REQUEST_SIGNING_SECRET || 'your-request-signing-secret'
};

// IP whitelist configuration
export const ipWhitelistConfig = {
  // Default whitelisted IPs (should be configured in production)
  defaultWhitelistedIps: [
    '127.0.0.1', // localhost
    '::1' // localhost IPv6
  ],
  
  // Default whitelisted CIDR ranges (should be configured in production)
  defaultWhitelistedCidrs: [
    '192.168.0.0/16', // Example private network
    '10.0.0.0/8' // Example private network
  ]
};

// CORS configuration
export const corsConfig = {
  // Allowed origins
  allowedOrigins: [
    'https://vici-app.com',
    'https://admin.vici-app.com',
    'http://localhost:3000'
  ],
  
  // Allowed methods
  allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  
  // Allowed headers
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-API-Key',
    'X-Signature',
    'X-Timestamp',
    'X-Nonce'
  ],
  
  // Exposed headers
  exposedHeaders: [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset'
  ],
  
  // Allow credentials
  allowCredentials: true,
  
  // Max age for preflight requests (in seconds)
  maxAge: 86400 // 24 hours
};

// Security headers configuration
export const securityHeadersConfig = {
  // Content Security Policy
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'", 'https://api.vici-app.com'],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'"],
    frameSrc: ["'none'"]
  },
  
  // Other security headers
  headers: {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
  }
};

// Export all security configurations
export default {
  oauth: oauthConfig,
  apiKey: apiKeyConfig,
  requestSigning: requestSigningConfig,
  ipWhitelist: ipWhitelistConfig,
  cors: corsConfig,
  securityHeaders: securityHeadersConfig
}; 