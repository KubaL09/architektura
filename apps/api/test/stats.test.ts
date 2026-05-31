import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '@trackflow/db';
import { randomUUID } from 'crypto';

describe('Stats API', () => {
  let marketerToken: string;
  let clientToken: string;
  let marketerId: string;
  let clientId: string;
  let clientLinkId: string;
  let otherLinkId: string;

  beforeAll(async () => {
    await app.ready();

    // 1. Fetch default seeded users
    const marketer = await db.user.findUnique({ where: { email: 'marketer@test.com' } });
    const client = await db.user.findUnique({ where: { email: 'client@test.com' } });
    
    expect(marketer).toBeDefined();
    expect(client).toBeDefined();

    marketerId = marketer!.id;
    clientId = client!.id;

    // 2. Perform logins
    const marketerLogin = await request(app.server)
      .post('/auth/login')
      .send({ email: 'marketer@test.com', password: 'test123' });
    marketerToken = marketerLogin.body.token;

    const clientLogin = await request(app.server)
      .post('/auth/login')
      .send({ email: 'client@test.com', password: 'test123' });
    clientToken = clientLogin.body.token;

    // 3. Create test links
    const clientLink = await db.link.create({
      data: {
        short_code: 'statc1',
        original_url: 'https://example.com/client-stats-target',
        created_by: marketerId,
        client_id: clientId
      }
    });
    clientLinkId = clientLink.id;

    const otherLink = await db.link.create({
      data: {
        short_code: 'stato1',
        original_url: 'https://example.com/other-stats-target',
        created_by: marketerId,
        client_id: null
      }
    });
    otherLinkId = otherLink.id;

    // 4. Populate DB with various clicks for clientLink to aggregate
    const now = Date.now();
    
    // Click 1: country PL, device mobile, referrer instagram.com subpath, ip_hash A, 1 hour ago
    await db.click.create({
      data: {
        link_id: clientLinkId,
        clicked_at: new Date(now - 3600000), // 1 hour ago
        country: 'PL',
        city: 'Warsaw',
        device_type: 'mobile',
        browser: 'Mobile Safari',
        os: 'iOS',
        referrer: 'https://instagram.com/p/12345',
        ip_hash: 'hash_user_A_sha256_placeholder',
        event_id: randomUUID()
      }
    });

    // Click 2: country PL, device desktop, referrer www.instagram.com, ip_hash A (SAME USER!), 2 hours ago
    await db.click.create({
      data: {
        link_id: clientLinkId,
        clicked_at: new Date(now - 7200000), // 2 hours ago
        country: 'PL',
        city: 'Krakow',
        device_type: 'desktop',
        browser: 'Chrome',
        os: 'Windows',
        referrer: 'http://www.instagram.com',
        ip_hash: 'hash_user_A_sha256_placeholder', // Duplicate IP!
        event_id: randomUUID()
      }
    });

    // Click 3: country DE, device tablet, referrer facebook.com subpath, ip_hash B, 2 days ago
    await db.click.create({
      data: {
        link_id: clientLinkId,
        clicked_at: new Date(now - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        country: 'DE',
        city: 'Berlin',
        device_type: 'tablet',
        browser: 'Firefox',
        os: 'Android',
        referrer: 'https://facebook.com/posts/abc',
        ip_hash: 'hash_user_B_sha256_placeholder',
        event_id: randomUUID()
      }
    });

    // Click 4: country null, device null, referrer null, ip_hash C, 5 days ago
    await db.click.create({
      data: {
        link_id: clientLinkId,
        clicked_at: new Date(now - 5 * 24 * 60 * 60 * 1000), // 5 days ago
        country: null,
        city: null,
        device_type: 'desktop', // fallback desktop
        browser: null,
        os: null,
        referrer: null,
        ip_hash: 'hash_user_C_sha256_placeholder',
        event_id: randomUUID()
      }
    });
  });

  afterAll(async () => {
    // Cleanup clicks and links
    await db.click.deleteMany({
      where: {
        link_id: {
          in: [clientLinkId, otherLinkId]
        }
      }
    });
    await db.link.deleteMany({
      where: {
        id: {
          in: [clientLinkId, otherLinkId]
        }
      }
    });
  });

  describe('GET /api/links/:id/stats', () => {
    it('should throw validation error on invalid period', async () => {
      const response = await request(app.server)
        .get(`/api/links/${clientLinkId}/stats?period=invalidPeriod`)
        .set('Authorization', `Bearer ${marketerToken}`)
        .send();

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should allow marketer to view stats with complete aggregations', async () => {
      const response = await request(app.server)
        .get(`/api/links/${clientLinkId}/stats?period=day`)
        .set('Authorization', `Bearer ${marketerToken}`)
        .send();

      expect(response.status).toBe(200);
      
      // Total & Unique checks
      expect(response.body.total_clicks).toBe(4);
      expect(response.body.unique_clicks).toBe(3); // A counted once!

      // Time series checks
      expect(response.body).toHaveProperty('clicks_over_time');
      expect(response.body.clicks_over_time.length).toBeGreaterThanOrEqual(1);

      // Country stats mapping checks (null -> Unknown)
      const plStat = response.body.by_country.find((c: any) => c.country === 'PL');
      const deStat = response.body.by_country.find((c: any) => c.country === 'DE');
      const unknownStat = response.body.by_country.find((c: any) => c.country === 'Unknown');
      
      expect(plStat.count).toBe(2);
      expect(deStat.count).toBe(1);
      expect(unknownStat.count).toBe(1);

      // Device stats checks
      const mobileStat = response.body.by_device.find((d: any) => d.device_type === 'mobile');
      const desktopStat = response.body.by_device.find((d: any) => d.device_type === 'desktop');
      const tabletStat = response.body.by_device.find((d: any) => d.device_type === 'tablet');

      expect(mobileStat.count).toBe(1);
      expect(tabletStat.count).toBe(1);
      expect(desktopStat.count).toBe(2); // Click 2 (desktop) + Click 4 (desktop)

      // Referrer domains group merging checks (www.instagram.com & instagram.com subpath merge!)
      const instaStat = response.body.by_referrer.find((r: any) => r.referrer === 'instagram.com');
      const fbStat = response.body.by_referrer.find((r: any) => r.referrer === 'facebook.com');
      const directStat = response.body.by_referrer.find((r: any) => r.referrer === 'Direct / Unknown');

      expect(instaStat.count).toBe(2); // 2 clicks merged!
      expect(fbStat.count).toBe(1);
      expect(directStat.count).toBe(1);
    });

    it('should allow client to view stats of their assigned link', async () => {
      const response = await request(app.server)
        .get(`/api/links/${clientLinkId}/stats`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body.total_clicks).toBe(4);
    });

    it('should block client from viewing stats of another unassigned link (returns 404)', async () => {
      const response = await request(app.server)
        .get(`/api/links/${otherLinkId}/stats`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send();

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('LINK_NOT_FOUND');
    });

    it('should correctly support hourly date_trunc bucket grouping', async () => {
      const response = await request(app.server)
        .get(`/api/links/${clientLinkId}/stats?period=hour`)
        .set('Authorization', `Bearer ${marketerToken}`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body.clicks_over_time.length).toBeGreaterThanOrEqual(1);
      
      // Hourly timestamps should contain the hour truncation format
      const timestamp = response.body.clicks_over_time[0].timestamp;
      expect(timestamp).toContain(':00:00.000');
    });
  });
});
