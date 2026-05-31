import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '@trackflow/db';

describe('TrackFlow End-to-End System Integration', () => {
  let token: string;
  let userId: string;
  let linkId: string;
  let linkCode: string;
  let reportId: string;
  
  const originalUrl = 'https://google.com/e2e-redirect-test';
  const campaignName = 'E2E Validation Campaign';
  const tempQueue = 'e2e-test-redirect-queue';

  beforeAll(async () => {
    await app.ready();

    // Setup temporary RabbitMQ queue to capture click events asynchronously
    await app.rabbitmq.channel.assertQueue(tempQueue, { durable: false });
    await app.rabbitmq.channel.bindQueue(tempQueue, 'trackflow.events', 'click.recorded');
    await app.rabbitmq.channel.purgeQueue(tempQueue);
  });

  afterAll(async () => {
    // Teardown E2E links and reports
    if (linkId) {
      await db.link.deleteMany({ where: { id: linkId } });
    }
    if (reportId) {
      await db.report.deleteMany({ where: { id: reportId } });
    }
    if (linkCode) {
      await app.redis.del(`link:${linkCode}`);
    }

    // Teardown test RabbitMQ queue
    await app.rabbitmq.channel.unbindQueue(tempQueue, 'trackflow.events', 'click.recorded');
    await app.rabbitmq.channel.deleteQueue(tempQueue);
  });

  // 1. Authenticate Marketer Flow
  it('should authenticate marketer user and return JWT token', async () => {
    const response = await request(app.server)
      .post('/auth/login')
      .send({
        email: 'marketer@test.com',
        password: 'test123'
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('token');
    expect(response.body.user.role).toBe('marketer');
    expect(response.body.user.email).toBe('marketer@test.com');
    
    token = response.body.token;
    userId = response.body.user.id;
  });

  // 2. Link Creation Flow
  it('should allow marketer to register a new campaign shortcode', async () => {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 14); // 2 weeks in future

    const response = await request(app.server)
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({
        original_url: originalUrl,
        campaign_name: campaignName,
        expires_at: expiry.toISOString()
      });

    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('id');
    expect(response.body.campaign_name).toBe(campaignName);
    expect(response.body.original_url).toBe(originalUrl);
    expect(response.body.created_by).toBe(userId);
    expect(response.body).toHaveProperty('short_code');
    expect(response.body.short_code.length).toBe(6);

    linkId = response.body.id;
    linkCode = response.body.short_code;
  });

  // 3. Campaign Listing & Details Verification
  it('should list created campaigns and fetch individual link details', async () => {
    // A. List links
    const listResponse = await request(app.server)
      .get('/api/links?limit=50')
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toHaveProperty('data');
    expect(listResponse.body.total).toBeGreaterThanOrEqual(1);

    const found = listResponse.body.data.find((l: any) => l.id === linkId);
    expect(found).toBeDefined();
    expect(found.campaign_name).toBe(campaignName);

    // B. Fetch single link details
    const detailResponse = await request(app.server)
      .get(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.id).toBe(linkId);
    expect(detailResponse.body.short_code).toBe(linkCode);
  });

  // 4. Redirection & Async Messaging Validation
  it('should redirect public requests and publish click.recorded event to RabbitMQ', async () => {
    // Clear Redis first to verify database lookup and cache injection
    await app.redis.del(`link:${linkCode}`);

    // Trigger redirect
    const response = await request(app.server)
      .get(`/${linkCode}`)
      .set('User-Agent', 'E2E-Agent-Chrome')
      .set('Referer', 'https://e2e-referrer.com')
      .send();

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(originalUrl);

    // Check Redis was immediately populated
    const cached = await app.redis.get(`link:${linkCode}`);
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!).original_url).toBe(originalUrl);

    // Pull published click event from RabbitMQ
    await new Promise((resolve) => setTimeout(resolve, 300));
    
    let message: any = null;
    for (let i = 0; i < 20; i++) {
      const msg = await app.rabbitmq.channel.get(tempQueue, { noAck: true });
      if (!msg) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const content = JSON.parse(msg.content.toString());
      if (content.payload && content.payload.short_code === linkCode) {
        message = msg;
        break;
      }
    }

    expect(message).not.toBeNull();
    const content = JSON.parse(message.content.toString());
    expect(content.event_type).toBe('click.recorded');
    expect(content.payload.user_agent).toBe('E2E-Agent-Chrome');
    expect(content.payload.referrer).toBe('https://e2e-referrer.com');
  });

  // 5. Client Dropdowns Fetching
  it('should fetch list of agency clients for creation dropdowns', async () => {
    const response = await request(app.server)
      .get('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('data');
    expect(response.body.data.length).toBeGreaterThanOrEqual(1);

    const clientSeeded = response.body.data.find((c: any) => c.email === 'client@test.com');
    expect(clientSeeded).toBeDefined();
  });

  // 6. Campaign PDF Report Asynchronous Order Flow
  it('should accept custom report compile requests and list active tasks', async () => {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 7);

    // A. Request PDF creation
    const orderResponse = await request(app.server)
      .post('/api/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        date_from: fromDate.toISOString(),
        date_to: new Date().toISOString(),
        link_id: linkId
      });

    expect(orderResponse.status).toBe(202);
    expect(orderResponse.body).toHaveProperty('report_id');
    expect(orderResponse.body.status).toBe('pending');
    
    reportId = orderResponse.body.report_id;

    // B. Query report logs history
    const historyResponse = await request(app.server)
      .get('/api/reports')
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.body).toHaveProperty('data');
    
    const foundReport = historyResponse.body.data.find((r: any) => r.id === reportId);
    expect(foundReport).toBeDefined();
    expect(['pending', 'processing', 'done']).toContain(foundReport.status);
  });

  // 7. Soft Delete Campaign Flow
  it('should soft delete campaign and deactivate redirect routes', async () => {
    // Delete link
    const deleteResponse = await request(app.server)
      .delete(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(deleteResponse.status).toBe(204);

    // Redirection must now fail immediately with a 404
    const redirectResponse = await request(app.server)
      .get(`/${linkCode}`)
      .send();

    expect(redirectResponse.status).toBe(404);
    expect(redirectResponse.body.code).toBe('LINK_NOT_FOUND');
  });
});
