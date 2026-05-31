import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '@trackflow/db';

describe('Redirect API', () => {
  let marketerId: string;
  let activeLinkCode = 'testrd1';
  let expiredLinkCode = 'testrd2';
  let deletedLinkCode = 'testrd3';

  beforeAll(async () => {
    await app.ready();

    // 1. Fetch the marketer seeded in Step 3
    const marketer = await db.user.findUnique({
      where: { email: 'marketer@test.com' }
    });
    expect(marketer).toBeDefined();
    marketerId = marketer!.id;

    // 2. Clean up any existing test links
    await db.link.deleteMany({
      where: {
        short_code: {
          in: [activeLinkCode, expiredLinkCode, deletedLinkCode]
        }
      }
    });

    // 3. Create test links
    // Active Link
    await db.link.create({
      data: {
        short_code: activeLinkCode,
        original_url: 'https://example.com/active-target',
        created_by: marketerId,
      }
    });

    // Expired Link
    await db.link.create({
      data: {
        short_code: expiredLinkCode,
        original_url: 'https://example.com/expired-target',
        created_by: marketerId,
        expires_at: new Date(Date.now() - 3600000) // 1 hour ago
      }
    });

    // Soft-deleted Link
    await db.link.create({
      data: {
        short_code: deletedLinkCode,
        original_url: 'https://example.com/deleted-target',
        created_by: marketerId,
        deleted_at: new Date()
      }
    });

    // Clear Redis keys to ensure fresh test state
    await app.redis.del(`link:${activeLinkCode}`);
    await app.redis.del(`link:${expiredLinkCode}`);
    await app.redis.del(`link:${deletedLinkCode}`);
  });

  afterAll(async () => {
    // Cleanup database and cache
    await db.link.deleteMany({
      where: {
        short_code: {
          in: [activeLinkCode, expiredLinkCode, deletedLinkCode]
        }
      }
    });
    await app.redis.del(`link:${activeLinkCode}`);
    await app.redis.del(`link:${expiredLinkCode}`);
    await app.redis.del(`link:${deletedLinkCode}`);
  });

  it('should redirect to target URL on cache miss, and save to cache', async () => {
    // 1. Verify key does not exist in Redis
    const cacheBefore = await app.redis.get(`link:${activeLinkCode}`);
    expect(cacheBefore).toBeNull();

    // 2. Request redirect (Cache Miss)
    const response = await request(app.server)
      .get(`/${activeLinkCode}`)
      .send();

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('https://example.com/active-target');

    // 3. Verify it was written to Redis
    const cacheAfter = await app.redis.get(`link:${activeLinkCode}`);
    expect(cacheAfter).not.toBeNull();
    const cachedData = JSON.parse(cacheAfter!);
    expect(cachedData.original_url).toBe('https://example.com/active-target');
  });

  it('should redirect directly using Redis cache on cache hit', async () => {
    // 1. Pre-populate cache with a different target URL to prove it uses Redis
    const cacheKey = `link:${activeLinkCode}`;
    const fakeData = {
      id: 'e9cb2026-c2cf-4bc6-8d19-ee7c74070a7b',
      original_url: 'https://fake-redis-target.com',
      expires_at: null
    };
    await app.redis.set(cacheKey, JSON.stringify(fakeData), { EX: 60 });

    // 2. Request redirect (Cache Hit)
    const response = await request(app.server)
      .get(`/${activeLinkCode}`)
      .send();

    expect(response.status).toBe(302);
    // Location must match fake Redis target, proving PostgreSQL was bypassed!
    expect(response.headers.location).toBe('https://fake-redis-target.com');
  });

  it('should return 404 for expired link', async () => {
    const response = await request(app.server)
      .get(`/${expiredLinkCode}`)
      .send();

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'LINK_NOT_FOUND',
      message: 'Link does not exist or has expired.'
    });
  });

  it('should return 404 for soft-deleted link', async () => {
    const response = await request(app.server)
      .get(`/${deletedLinkCode}`)
      .send();

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'LINK_NOT_FOUND',
      message: 'Link does not exist or has expired.'
    });
  });

  it('should return 404 for non-existent link', async () => {
    const response = await request(app.server)
      .get('/nonexistent123')
      .send();

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'LINK_NOT_FOUND',
      message: 'Link does not exist or has expired.'
    });
  });
});
