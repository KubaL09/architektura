import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import UAParser from 'ua-parser-js';
import geoip from 'geoip-lite';
import amqp from 'amqplib';
import { db } from '@trackflow/db';
import { startWorker } from '../src/app.js';
import { randomUUID } from 'crypto';

describe('Worker Analytics Unit Tests', () => {
  describe('User-Agent Parsing', () => {
    it('should parse iPhone User-Agent correctly', () => {
      const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1';
      const parser = new UAParser(iphoneUA);
      const res = parser.getResult();
      
      let deviceType = 'desktop';
      if (res.device && res.device.type) {
        const type = res.device.type.toLowerCase();
        if (type === 'mobile') deviceType = 'mobile';
      }
      
      expect(deviceType).toBe('mobile');
      expect(res.os.name).toBe('iOS');
      expect(res.browser.name).toBe('Mobile Safari');
    });

    it('should fallback to desktop for unknown User-Agent', () => {
      const unknownUA = 'MyCustomAgent/1.0';
      const parser = new UAParser(unknownUA);
      const res = parser.getResult();
      
      let deviceType = 'desktop';
      if (res.device && res.device.type) {
        const type = res.device.type.toLowerCase();
        if (type === 'mobile') deviceType = 'mobile';
      }
      
      expect(deviceType).toBe('desktop');
      expect(res.os.name).toBeUndefined();
      expect(res.browser.name).toBeUndefined();
    });
  });

  describe('GeoIP offline lookup', () => {
    it('should return PL for valid Polish IP address', () => {
      const polishIp = '89.64.12.34';
      const res = geoip.lookup(polishIp);
      expect(res).not.toBeNull();
      expect(res!.country).toBe('PL');
    });

    it('should return null for invalid IP address without throwing', () => {
      const res = geoip.lookup('invalid-ip-string');
      expect(res).toBeNull();
    });
  });
});

describe('Worker Clicks Consumer Integration Tests', () => {
  let marketerId: string;
  let linkId: string;
  const shortCode = 'wkrtst1';
  let worker: any;
  let connection: amqp.Connection;
  let channel: amqp.Channel;

  beforeAll(async () => {
    // 1. Setup DB state
    const marketer = await db.user.findUnique({ where: { email: 'marketer@test.com' } });
    marketerId = marketer!.id;

    await db.link.deleteMany({ where: { short_code: shortCode } });
    const link = await db.link.create({
      data: {
        short_code: shortCode,
        original_url: 'https://example.com/worker-target',
        created_by: marketerId
      }
    });
    linkId = link.id;

    // 2. Start the worker consumer
    worker = await startWorker();

    // 3. Create test channel to publish directly
    const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672/';
    connection = await amqp.connect(rabbitmqUrl);
    channel = await connection.createChannel();
  });

  afterAll(async () => {
    await db.click.deleteMany({ where: { link_id: linkId } });
    await db.link.delete({ where: { id: linkId } });
    
    // Close test channel and connection
    await channel.close();
    await connection.close();

    // Close worker
    if (worker) {
      await worker.channel.close();
      await worker.connection.close();
      if (worker.redisClient) {
        await worker.redisClient.disconnect();
      }
    }
  });

  it('should consume click.recorded event, enrich, and save to DB', async () => {
    const eventId = randomUUID();
    const payload = {
      link_id: linkId,
      short_code: shortCode,
      clicked_at: new Date().toISOString(),
      ip_address: '89.64.12.34', // Poland
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
      referrer: 'https://instagram.com/'
    };

    const envelope = {
      event_id: eventId,
      event_type: 'click.recorded',
      version: '1.0',
      timestamp: new Date().toISOString(),
      payload
    };

    // 1. Publish event directly to exchange
    channel.publish('trackflow.events', 'click.recorded', Buffer.from(JSON.stringify(envelope)), {
      persistent: true
    });

    // 2. Wait for consumer to process and write to DB
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 3. Query PostgreSQL clicks table
    const clicks = await db.click.findMany({
      where: { event_id: eventId }
    });

    expect(clicks.length).toBe(1);
    const click = clicks[0];
    expect(click.country).toBe('PL');
    expect(click.device_type).toBe('mobile');
    expect(click.browser).toBe('Mobile Safari');
    expect(click.os).toBe('iOS');
    expect(click.referrer).toBe('https://instagram.com/');
    expect(click.ip_hash).not.toBeNull();
    // IP should be anonymized with SHA-256
    expect(click.ip_hash?.length).toBe(64);
  });

  it('should enforce idempotency and process double-event only once', async () => {
    const eventId = randomUUID();
    const payload = {
      link_id: linkId,
      short_code: shortCode,
      clicked_at: new Date().toISOString(),
      ip_address: '1.1.1.1',
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      referrer: null
    };

    const envelope = {
      event_id: eventId,
      event_type: 'click.recorded',
      version: '1.0',
      timestamp: new Date().toISOString(),
      payload
    };

    // Publish the EXACT same event twice
    channel.publish('trackflow.events', 'click.recorded', Buffer.from(JSON.stringify(envelope)), {
      persistent: true
    });
    channel.publish('trackflow.events', 'click.recorded', Buffer.from(JSON.stringify(envelope)), {
      persistent: true
    });

    // Wait for consumer
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Assert that only exactly one click record was created in the database
    const clicks = await db.click.findMany({
      where: { event_id: eventId }
    });

    expect(clicks.length).toBe(1);
  });
});
