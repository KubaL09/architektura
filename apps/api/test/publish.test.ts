import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '@trackflow/db';

describe('Event Publishing Integration', () => {
  let marketerId: string;
  let testLinkCode = 'testpub1';
  let queueName = 'test-redirect-queue';

  beforeAll(async () => {
    await app.ready();

    // 1. Fetch seeded marketer
    const marketer = await db.user.findUnique({
      where: { email: 'marketer@test.com' }
    });
    expect(marketer).toBeDefined();
    marketerId = marketer!.id;

    // 2. Clean up link
    await db.link.deleteMany({
      where: { short_code: testLinkCode }
    });

    // 3. Create test link
    await db.link.create({
      data: {
        short_code: testLinkCode,
        original_url: 'https://example.com/test-publish-target',
        created_by: marketerId
      }
    });

    // 4. Assert queue in RabbitMQ for listening
    await app.rabbitmq.channel.assertQueue(queueName, { durable: false });
    await app.rabbitmq.channel.bindQueue(queueName, 'trackflow.events', 'click.recorded');
    
    // Purge queue to ensure it is clean
    await app.rabbitmq.channel.purgeQueue(queueName);
    await app.redis.del(`link:${testLinkCode}`);
  });

  afterAll(async () => {
    // Cleanup database, cache and queue
    await db.link.deleteMany({
      where: { short_code: testLinkCode }
    });
    await app.redis.del(`link:${testLinkCode}`);
    await app.rabbitmq.channel.unbindQueue(queueName, 'trackflow.events', 'click.recorded');
    await app.rabbitmq.channel.deleteQueue(queueName);
  });

  it('should publish a click.recorded event to RabbitMQ on redirect', async () => {
    // 1. Trigger the redirect (Cache Miss -> DB Query -> Publish Event -> Redirect)
    const response = await request(app.server)
      .get(`/${testLinkCode}`)
      .set('User-Agent', 'TestAgent')
      .set('Referer', 'https://test-referrer.com')
      .send();

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('https://example.com/test-publish-target');

    // 2. Wait a brief moment to ensure async RabbitMQ publishing completed in the background
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 3. Pull the message from RabbitMQ queue (filtering out concurrent test messages)
    let message: any = null;
    for (let i = 0; i < 20; i++) {
      const msg = await app.rabbitmq.channel.get(queueName, { noAck: true });
      if (!msg) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const content = JSON.parse(msg.content.toString());
      if (content.payload && content.payload.short_code === testLinkCode) {
        message = msg;
        break;
      }
    }

    expect(message).not.toBeNull();

    // 4. Validate the message content and envelope
    const content = JSON.parse(message.content.toString());
    expect(content).toHaveProperty('event_id');
    expect(content.event_type).toBe('click.recorded');
    expect(content.version).toBe('1.0');
    expect(content).toHaveProperty('timestamp');
    
    // Validate payload values
    const payload = content.payload;
    expect(payload.short_code).toBe(testLinkCode);
    expect(payload.user_agent).toBe('TestAgent');
    expect(payload.referrer).toBe('https://test-referrer.com');
    expect(payload).toHaveProperty('ip_address');
    expect(payload).toHaveProperty('clicked_at');
    expect(payload).toHaveProperty('link_id');
  });
});
