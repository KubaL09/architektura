import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';

describe('Authentication API', () => {
  beforeAll(async () => {
    await app.ready();
  });

  describe('POST /auth/login', () => {
    it('should fail when email or password is missing', async () => {
      const response = await request(app.server)
        .post('/auth/login')
        .send({ email: 'marketer@test.com' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'E-mail and password are required.'
      });
    });

    it('should fail with invalid credentials', async () => {
      const response = await request(app.server)
        .post('/auth/login')
        .send({ email: 'marketer@test.com', password: 'wrongpassword' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid e-mail or password.'
      });
    });

    it('should succeed with valid marketer credentials', async () => {
      const response = await request(app.server)
        .post('/auth/login')
        .send({ email: 'marketer@test.com', password: 'test123' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('token');
      expect(response.body.user).toEqual({
        id: expect.any(String),
        email: 'marketer@test.com',
        role: 'marketer'
      });
    });
  });

  describe('POST /auth/change-password', () => {
    it('should fail when accessing without token', async () => {
      const response = await request(app.server)
        .post('/auth/change-password')
        .send({ old_password: 'test123', new_password: 'newpassword123' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing authorization token.'
      });
    });

    it('should fail when password criteria is not met', async () => {
      // 1. Login to get token
      const loginResponse = await request(app.server)
        .post('/auth/login')
        .send({ email: 'client@test.com', password: 'test123' });
      const token = loginResponse.body.token;

      // 2. Change password with short password
      const response = await request(app.server)
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ old_password: 'test123', new_password: '123' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Password criteria not met.'
      });
    });

    it('should successfully change password and login with new password', async () => {
      // 1. Login to get token
      const loginResponse = await request(app.server)
        .post('/auth/login')
        .send({ email: 'client@test.com', password: 'test123' });
      const token = loginResponse.body.token;

      // 2. Change password
      const response = await request(app.server)
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ old_password: 'test123', new_password: 'newawesomepassword123' });

      expect(response.status).toBe(204);

      // 3. Try login with old password (should fail)
      const oldLoginResponse = await request(app.server)
        .post('/auth/login')
        .send({ email: 'client@test.com', password: 'test123' });
      expect(oldLoginResponse.status).toBe(401);

      // 4. Login with new password (should succeed)
      const newLoginResponse = await request(app.server)
        .post('/auth/login')
        .send({ email: 'client@test.com', password: 'newawesomepassword123' });
      expect(newLoginResponse.status).toBe(200);

      // 5. Restore original password for next runs / general state
      const restoreToken = newLoginResponse.body.token;
      await request(app.server)
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${restoreToken}`)
        .send({ old_password: 'newawesomepassword123', new_password: 'test123' });
    });
  });
});
