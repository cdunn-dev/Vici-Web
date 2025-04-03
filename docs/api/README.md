# Vici API Documentation

This directory contains the OpenAPI/Swagger documentation for the Vici API. The API provides endpoints for managing workouts, training programs, and user data.

## Documentation Structure

- `openapi.yaml`: The main OpenAPI specification file that defines all API endpoints, schemas, and security requirements
- `README.md`: This file, providing an overview and setup instructions

## Getting Started

1. **Authentication**
   - All API endpoints require authentication using JWT tokens
   - Include the token in the Authorization header:
     ```
     Authorization: Bearer <your_token>
     ```
   - Obtain a token by calling the `/auth/login` endpoint

2. **Rate Limiting**
   - API requests are rate limited based on your subscription tier:
     - Free: 100 requests per hour
     - Pro: 1000 requests per hour
     - Enterprise: Custom limits
   - Rate limit information is included in response headers:
     ```
     X-RateLimit-Limit: 100
     X-RateLimit-Remaining: 95
     X-RateLimit-Reset: 1640995200
     ```

3. **Error Handling**
   - All errors follow a standard format:
     ```json
     {
       "error": {
         "code": "ERROR_CODE",
         "message": "Human readable message",
         "details": {}
       }
     }
     ```
   - Common error codes:
     - `UNAUTHORIZED`: Authentication required or failed
     - `FORBIDDEN`: Insufficient permissions
     - `NOT_FOUND`: Resource not found
     - `VALIDATION_ERROR`: Invalid request data
     - `RATE_LIMIT_EXCEEDED`: Too many requests

## API Endpoints

### Authentication
- `POST /auth/login`: Authenticate user and get JWT token
- `POST /auth/refresh`: Refresh authentication token

### Users
- `GET /users/me`: Get current user profile

### Workouts
- `GET /workouts`: List workouts (paginated)
- `POST /workouts`: Create new workout
- `GET /workouts/{id}`: Get specific workout
- `PUT /workouts/{id}`: Update workout
- `DELETE /workouts/{id}`: Delete workout

## Development

### Local Development
1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Access the Swagger UI:
   ```
   http://localhost:3000/api-docs
   ```

### Testing
1. Run tests:
   ```bash
   npm test
   ```

2. Run tests with coverage:
   ```bash
   npm run test:coverage
   ```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests
5. Submit a pull request

## Support

For API support:
- Email: api-support@vici.com
- Documentation: https://docs.vici.com
- Status page: https://status.vici.com 