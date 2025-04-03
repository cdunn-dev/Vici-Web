import request from 'supertest';
import { app } from '../../../app';
import { db } from '../../../db';
import { users } from '../../../db/schema';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';

describe('Auth API', () => {
  const testUser = {
    email: 'test@example.com',
    password: 'password123',
    name: 'Test User',
  };

  beforeEach(async () => {
    // Clean up the database before each test
    await db.delete(users);
  });

  describe('POST /api/v1/auth/register', () => {
    it('should register a new user', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send(testUser)
        .expect(201);

      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('id');
      expect(response.body.user.email).toBe(testUser.email);
      expect(response.body.user.name).toBe(testUser.name);
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('refreshToken');

      // Verify user was created in the database
      const dbUser = await db.query.users.findFirst({
        where: eq(users.email, testUser.email),
      });

      expect(dbUser).toBeTruthy();
      expect(dbUser?.email).toBe(testUser.email);
      expect(dbUser?.name).toBe(testUser.name);
    });

    it('should return 400 if email is already registered', async () => {
      // Create a user first
      const hashedPassword = await bcrypt.hash(testUser.password, 10);
      await db.insert(users).values({
        email: testUser.email,
        password: hashedPassword,
        name: testUser.name,
        emailVerified: false,
      });

      // Try to register the same email
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send(testUser)
        .expect(400);

      expect(response.body.error.code).toBe('USER_EXISTS');
    });

    it('should validate input data', async () => {
      const invalidUser = {
        email: 'invalid-email',
        password: '123', // Too short
        name: 'T', // Too short
      };

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send(invalidUser)
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details).toHaveLength(3);
    });
  });

  describe('POST /api/v1/auth/login', () => {
    beforeEach(async () => {
      // Create a user for login tests
      const hashedPassword = await bcrypt.hash(testUser.password, 10);
      await db.insert(users).values({
        email: testUser.email,
        password: hashedPassword,
        name: testUser.name,
        emailVerified: false,
      });
    });

    it('should login with valid credentials', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password,
        })
        .expect(200);

      expect(response.body).toHaveProperty('user');
      expect(response.body.user.email).toBe(testUser.email);
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('refreshToken');
    });

    it('should return 401 with invalid credentials', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: 'wrongpassword',
        })
        .expect(401);

      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('POST /api/v1/auth/refresh-token', () => {
    let refreshToken: string;

    beforeEach(async () => {
      // Create a user and get a refresh token
      const hashedPassword = await bcrypt.hash(testUser.password, 10);
      await db.insert(users).values({
        email: testUser.email,
        password: hashedPassword,
        name: testUser.name,
        emailVerified: false,
      });

      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password,
        });

      refreshToken = loginResponse.body.refreshToken;
    });

    it('should refresh the access token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/refresh-token')
        .send({ refreshToken })
        .expect(200);

      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body.token).not.toBe(refreshToken);
    });

    it('should return 401 with invalid refresh token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/refresh-token')
        .send({ refreshToken: 'invalid-token' })
        .expect(401);

      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });
  });
}); 