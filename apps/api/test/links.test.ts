import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '@trackflow/db';

describe('Link CRUD & RBAC API', () => {
  let marketerToken: string;
  let clientToken: string;
  let marketerId: string;
  let clientId: string;
  let testLinkId: string;
  let testLinkCode: string;

  beforeAll(async () => {
    await app.ready();

    // 1. Fetch default seeded users
    const marketer = await db.user.findUnique({ where: { email: 'marketer@test.com' } });
    const client = await db.user.findUnique({ where: { email: 'client@test.com' } });
    
    expect(marketer).toBeDefined();
    expect(client).toBeDefined();

    marketerId = marketer!.id;
    clientId = client!.id;

    // 2. Perform logins to secure Bearer tokens
    const marketerLogin = await request(app.server)
      .post('/auth/login')
      .send({ email: 'marketer@test.com', password: 'test123' });
    marketerToken = marketerLogin.body.token;

    const clientLogin = await request(app.server)
      .post('/auth/login')
      .send({ email: 'client@test.com', password: 'test123' });
    clientToken = clientLogin.body.token;
  });

  afterAll(async () => {
    // Cleanup generated links
    if (testLinkId) {
      await db.link.deleteMany({
        where: { id: testLinkId }
      });
    }
  });

  describe('POST /api/links (Create Link)', () => {
    it('should block non-marketers (Clients) from creating links', async () => {
      const response = await request(app.server)
        .post('/api/links')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({
          original_url: 'https://example.com/blocked-client-target'
        });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('should throw validation error on invalid URL', async () => {
      const response = await request(app.server)
        .post('/api/links')
        .set('Authorization', `Bearer ${marketerToken}`)
        .send({
          original_url: 'not-a-valid-url-format'
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: 'INVALID_URL',
        message: 'Provided string is not a valid HTTP/HTTPS URL.'
      });
    });

    it('should throw validation error when expires_at exceeds 365 days', async () => {
      const farFutureDate = new Date(Date.now() + 367 * 24 * 60 * 60 * 1000); // 367 days away
      const response = await request(app.server)
        .post('/api/links')
        .set('Authorization', `Bearer ${marketerToken}`)
        .send({
          original_url: 'https://example.com/far-future',
          expires_at: farFutureDate.toISOString()
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: 'EXPIRY_LIMIT_EXCEEDED',
        message: 'Expiration date cannot exceed 365 days from now.'
      });
    });

    it('should successfully create link, generate nanoid, and warm Redis cache', async () => {
      const response = await request(app.server)
        .post('/api/links')
        .set('Authorization', `Bearer ${marketerToken}`)
        .send({
          original_url: 'https://example.com/success-crud-target',
          campaign_name: 'Summer Campaign',
          client_id: clientId
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('short_code');
      expect(response.body.short_code.length).toBe(6);
      expect(response.body.original_url).toBe('https://example.com/success-crud-target');
      expect(response.body.campaign_name).toBe('Summer Campaign');
      expect(response.body.client_id).toBe(clientId);
      expect(response.body.created_by).toBe(marketerId);

      testLinkId = response.body.id;
      testLinkCode = response.body.short_code;

      // Assert Redis cache was immediately warmed up (Cache Hit)
      const cached = await app.redis.get(`link:${testLinkCode}`);
      expect(cached).not.toBeNull();
      const cachedJSON = JSON.parse(cached!);
      expect(cachedJSON.original_url).toBe('https://example.com/success-crud-target');
    });
  });

  describe('GET /api/links (List Links)', () => {
    it('should allow marketer to view all links', async () => {
      const response = await request(app.server)
        .get('/api/links')
        .set('Authorization', `Bearer ${marketerToken}`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total');
      expect(response.body.total).toBeGreaterThanOrEqual(1);
    });

    it('should restrict client to view ONLY their assigned links', async () => {
      const response = await request(app.server)
        .get('/api/links')
        .set('Authorization', `Bearer ${clientToken}`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      
      // Ensure all listed links belong to this client
      for (const link of response.body.data) {
        expect(link.client_id).toBe(clientId);
      }
    });
  });

  describe('GET /api/links/:id (Get Link Details)', () => {
    it('should allow marketer to view link details', async () => {
      const response = await request(app.server)
        .get(`/api/links/${testLinkId}`)
        .set('Authorization', `Bearer ${marketerToken}`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(testLinkId);
    });

    it('should allow client to view details of their assigned link', async () => {
      const response = await request(app.server)
        .get(`/api/links/${testLinkId}`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(testLinkId);
    });

    it('should block client from viewing another clients link details (returns 404)', async () => {
      // Create a link not assigned to client (assigned to null or another client)
      const anotherLink = await db.link.create({
        data: {
          short_code: 'othr12',
          original_url: 'https://example.com/other-link',
          created_by: marketerId,
          client_id: null
        }
      });

      try {
        const response = await request(app.server)
          .get(`/api/links/${anotherLink.id}`)
          .set('Authorization', `Bearer ${clientToken}`)
          .send();

        expect(response.status).toBe(404);
        expect(response.body.code).toBe('LINK_NOT_FOUND');
      } finally {
        await db.link.delete({ where: { id: anotherLink.id } });
      }
    });
  });

  describe('DELETE /api/links/:id (Delete Link)', () => {
    it('should block clients from deleting links', async () => {
      const response = await request(app.server)
        .delete(`/api/links/${testLinkId}`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send();

      expect(response.status).toBe(403);
    });

    it('should allow marketer to soft-delete link and evict cache', async () => {
      // Delete (Cache Eviction)
      const response = await request(app.server)
        .delete(`/api/links/${testLinkId}`)
        .set('Authorization', `Bearer ${marketerToken}`)
        .send();

      expect(response.status).toBe(204);

      // Verify soft-deleted in Database (deleted_at is set)
      const linkInDb = await db.link.findUnique({
        where: { id: testLinkId }
      });
      expect(linkInDb).not.toBeNull();
      expect(linkInDb!.deleted_at).not.toBeNull();

      // Verify evicted from Redis
      const cached = await app.redis.get(`link:${testLinkCode}`);
      expect(cached).toBeNull();

      // Verify redirect route now returns 404
      const redirectResponse = await request(app.server)
        .get(`/${testLinkCode}`)
        .send();
      expect(redirectResponse.status).toBe(404);
    });
  });

  describe('GET /api/clients (Agencys clients dropdown list)', () => {
    it('should allow marketers to fetch client dropdown list', async () => {
      const response = await request(app.server)
        .get('/api/clients')
        .set('Authorization', `Bearer ${marketerToken}`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(response.body.data[0]).toHaveProperty('email');
      expect(response.body.data[0].email).toBe('client@test.com');
    });

    it('should block clients from fetching client dropdown list', async () => {
      const response = await request(app.server)
        .get('/api/clients')
        .set('Authorization', `Bearer ${clientToken}`)
        .send();

      expect(response.status).toBe(403);
    });
  });
});
