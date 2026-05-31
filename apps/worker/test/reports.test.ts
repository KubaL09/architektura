import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import amqp from 'amqplib';
import { db } from '@trackflow/db';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

// Mock emailService to prevent connect ECONNREFUSED SMTP errors on localhost
vi.mock('../src/emailService.js', async () => {
  const actual = await vi.importActual<any>('../src/emailService.js');
  return {
    ...actual,
    sendEmail: vi.fn().mockResolvedValue({ messageId: 'mocked-message-id' })
  };
});

// Mock Puppeteer to avoid Node 26 + yargs ESM incompatibility that causes puppeteer.launch() to hang.
// The mock simulates a browser → page → PDF pipeline by writing a real dummy PDF to disk.
vi.mock('puppeteer', () => {
  return {
    default: {
      launch: vi.fn().mockImplementation(() => {
        const mockPage = {
          setContent: vi.fn().mockResolvedValue(undefined),
          pdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock pdf content')),
        };
        const mockBrowser = {
          newPage: vi.fn().mockResolvedValue(mockPage),
          close: vi.fn().mockResolvedValue(undefined),
        };
        return Promise.resolve(mockBrowser);
      })
    }
  };
});

// Import startWorker AFTER mocks are set up
const { startWorker } = await import('../src/app.js');

describe('Worker Reports Consumer Integration Tests', () => {
  let marketerId: string;
  let clientId: string;
  let linkId: string;
  const shortCode = 'rprttst1';
  let worker: any;
  let connection: amqp.Connection;
  let channel: amqp.Channel;
  let createdReportIds: string[] = [];

  beforeAll(async () => {
    // 1. Fetch default seeded marketer and client
    const marketer = await db.user.findUnique({ where: { email: 'marketer@test.com' } });
    const client = await db.user.findUnique({ where: { email: 'client@test.com' } });

    expect(marketer).toBeDefined();
    expect(client).toBeDefined();

    marketerId = marketer!.id;
    clientId = client!.id;

    // Clean up existing link if any
    await db.link.deleteMany({ where: { short_code: shortCode } });

    // 2. Create test link
    const link = await db.link.create({
      data: {
        short_code: shortCode,
        original_url: 'https://example.com/report-target',
        created_by: marketerId,
        client_id: clientId
      }
    });
    linkId = link.id;

    // 3. Seed clicks to aggregate
    const now = Date.now();
    await db.click.createMany({
      data: [
        {
          link_id: linkId,
          clicked_at: new Date(now - 3600000), // 1 hour ago
          country: 'PL',
          city: 'Warsaw',
          device_type: 'mobile',
          browser: 'Mobile Safari',
          os: 'iOS',
          referrer: 'https://instagram.com/p/12345',
          ip_hash: 'hash_a',
          event_id: randomUUID()
        },
        {
          link_id: linkId,
          clicked_at: new Date(now - 7200000), // 2 hours ago
          country: 'DE',
          city: 'Berlin',
          device_type: 'desktop',
          browser: 'Chrome',
          os: 'Windows',
          referrer: 'http://www.instagram.com',
          ip_hash: 'hash_a', // Duplicate IP!
          event_id: randomUUID()
        },
        {
          link_id: linkId,
          clicked_at: new Date(now - 86400000), // 1 day ago
          country: null,
          city: null,
          device_type: 'tablet',
          browser: null,
          os: null,
          referrer: null,
          ip_hash: 'hash_b',
          event_id: randomUUID()
        }
      ]
    });

    // 4. Start the worker consumer
    worker = await startWorker();

    // 5. Connect test channel for publishing
    const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672/';
    connection = await amqp.connect(rabbitmqUrl);
    channel = await connection.createChannel();
  });

  afterAll(async () => {
    // Cleanup generated PDF reports from disk
    for (const reportId of createdReportIds) {
      const storageDir = process.env.PDF_STORAGE_PATH || './storage/reports';
      const filePath = path.join(storageDir, `report_${reportId}.pdf`);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (_) {}
      }
    }

    // Clean clicks, reports and links
    await db.click.deleteMany({ where: { link_id: linkId } });
    await db.report.deleteMany({ where: { id: { in: createdReportIds } } });
    await db.link.delete({ where: { id: linkId } });

    // Close test connections
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

  it('should consume report.requested event, aggregate data, compile Puppeteer PDF, and update DB status', async () => {
    const reportId = randomUUID();
    createdReportIds.push(reportId);

    // 1. Create pending report in PostgreSQL
    await db.report.create({
      data: {
        id: reportId,
        status: 'pending',
        requested_by: marketerId,
        date_from: new Date(Date.now() - 7 * 24 * 3600 * 1000), // Last 7 days
        date_to: new Date()
      }
    });

    const payload = {
      report_id: reportId,
      requested_by: marketerId,
      date_from: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
      date_to: new Date().toISOString(),
      client_id: clientId,
      link_id: null,
      recipient_email: 'client@test.com'
    };

    const envelope = {
      event_id: randomUUID(),
      event_type: 'report.requested',
      version: '1.0',
      timestamp: new Date().toISOString(),
      payload
    };

    // 2. Bind notification test queue to capture notification.send event
    const notifQueue = 'test-notification-reports-queue';
    await channel.assertQueue(notifQueue, { durable: false });
    await channel.bindQueue(notifQueue, 'trackflow.events', 'notification.send');
    await channel.purgeQueue(notifQueue);

    // 3. Publish report.requested event
    channel.publish('trackflow.events', 'report.requested', Buffer.from(JSON.stringify(envelope)), {
      persistent: true
    });

    // 4. Poll for report completion (Puppeteer cold start can be slow, especially on first run)
    let report: any = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      report = await db.report.findUnique({
        where: { id: reportId }
      });
      if (report && (report.status === 'done' || report.status === 'failed')) {
        break;
      }
    }

    // 5. Assert report completed successfully
    expect(report).not.toBeNull();
    expect(report!.status).toBe('done');
    expect(report!.completed_at).not.toBeNull();
    expect(report!.file_path).not.toBeNull();
    expect(report!.error_message).toBeNull();

    // 6. Assert file exists on disk
    expect(fs.existsSync(report!.file_path!)).toBe(true);

    // 7. Verify notification.send event was dispatched to RabbitMQ (filtering out concurrent test messages)
    let message: any = null;
    for (let i = 0; i < 30; i++) {
      const msg = await channel.get(notifQueue, { noAck: true });
      if (!msg) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const content = JSON.parse(msg.content.toString());
      if (content.payload && content.payload.template_data && content.payload.template_data.file_path === report!.file_path) {
        message = msg;
        break;
      }
    }

    expect(message).not.toBeNull();

    const notifContent = JSON.parse(message.content.toString());
    expect(notifContent.event_type).toBe('notification.send');
    expect(notifContent.payload.type).toBe('report_ready');
    expect(notifContent.payload.recipient_email).toBe('client@test.com');
    expect(notifContent.payload.template_data.file_path).toBe(report!.file_path);

    // Clean up test queue
    await channel.unbindQueue(notifQueue, 'trackflow.events', 'notification.send');
    await channel.deleteQueue(notifQueue);
  }, 30000); // 30 seconds timeout for Puppeteer PDF render
});
