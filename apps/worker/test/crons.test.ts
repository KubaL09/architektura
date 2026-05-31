import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import amqp from 'amqplib';
import { db } from '@trackflow/db';
import { getPreviousWeekRange, triggerWeeklyReports, triggerInactivityAlerts } from '../src/cronScheduler.js';
import { randomUUID } from 'crypto';

describe('Worker Crons Scheduler Tests', () => {
  describe('getPreviousWeekRange Utility', () => {
    it('should compute the correct previous week range when triggered on Monday', () => {
      // Triggering date: Monday, May 25, 2026
      const now = new Date('2026-05-25T08:00:00.000Z');
      const { date_from, date_to } = getPreviousWeekRange(now);

      // Expected start: Monday, May 18, 2026 at 00:00:00
      expect(date_from.getFullYear()).toBe(2026);
      expect(date_from.getMonth()).toBe(4); // 0-indexed (May is 4)
      expect(date_from.getDate()).toBe(18);
      expect(date_from.getHours()).toBe(0);
      expect(date_from.getMinutes()).toBe(0);
      expect(date_from.getSeconds()).toBe(0);

      // Expected end: Sunday, May 24, 2026 at 23:59:59.999
      expect(date_to.getFullYear()).toBe(2026);
      expect(date_to.getMonth()).toBe(4);
      expect(date_to.getDate()).toBe(24);
      expect(date_to.getHours()).toBe(23);
      expect(date_to.getMinutes()).toBe(59);
      expect(date_to.getSeconds()).toBe(59);
    });

    it('should compute the correct previous week range even if triggered on Sunday', () => {
      // Triggering date: Sunday, May 31, 2026
      const now = new Date('2026-05-31T20:00:00.000Z');
      const { date_from, date_to } = getPreviousWeekRange(now);

      // Expected start: Monday, May 18, 2026 at 00:00:00 (the Monday of previous week)
      expect(date_from.getDate()).toBe(18);
      // Expected end: Sunday, May 24, 2026 at 23:59:59.999
      expect(date_to.getDate()).toBe(24);
    });
  });

  describe('triggerWeeklyReports Integration', () => {
    let connection: amqp.Connection;
    let channel: amqp.Channel;
    let marketerId: string;
    
    // Test clients
    let activeClientId: string;
    let inactiveClientId: string;
    
    // Test links
    let activeLinkId: string;
    let softDeletedLinkId: string;
    
    let createdReportIds: string[] = [];

    beforeAll(async () => {
      // 1. Fetch marketer to assign as system requester
      const marketer = await db.user.findUnique({ where: { email: 'marketer@test.com' } });
      expect(marketer).toBeDefined();
      marketerId = marketer!.id;

      // 2. Create two mock client users
      const activeClientEmail = `active-client-${Date.now()}@test.com`;
      const inactiveClientEmail = `inactive-client-${Date.now()}@test.com`;

      const activeClient = await db.user.create({
        data: {
          email: activeClientEmail,
          password_hash: 'hashed',
          role: 'client'
        }
      });
      activeClientId = activeClient.id;

      const inactiveClient = await db.user.create({
        data: {
          email: inactiveClientEmail,
          password_hash: 'hashed',
          role: 'client'
        }
      });
      inactiveClientId = inactiveClient.id;

      // 3. Assign active campaign link to active client
      const activeLink = await db.link.create({
        data: {
          short_code: `actvlnk${Date.now().toString().slice(-3)}`,
          original_url: 'https://example.com/active',
          created_by: marketerId,
          client_id: activeClientId
        }
      });
      activeLinkId = activeLink.id;

      // 4. Assign soft-deleted link to inactive client
      const softDeletedLink = await db.link.create({
        data: {
          short_code: `sftdlnk${Date.now().toString().slice(-3)}`,
          original_url: 'https://example.com/deleted',
          created_by: marketerId,
          client_id: inactiveClientId,
          deleted_at: new Date() // Soft-deleted!
        }
      });
      softDeletedLinkId = softDeletedLink.id;

      // 5. Connect RabbitMQ channel for testing
      const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672/';
      connection = await amqp.connect(rabbitmqUrl);
      channel = connection.createChannel ? await connection.createChannel() : (connection as any);
    });

    afterAll(async () => {
      // Clean up reports, clicks, links, and users
      await db.report.deleteMany({
        where: { requested_by: marketerId }
      });
      await db.link.deleteMany({
        where: { id: { in: [activeLinkId, softDeletedLinkId] } }
      });
      await db.user.deleteMany({
        where: { id: { in: [activeClientId, inactiveClientId] } }
      });

      if (channel && channel.close) await channel.close();
      if (connection && connection.close) await connection.close();
    });

    it('should generate report request events only for clients with active links', async () => {
      const publishSpy = vi.spyOn(channel, 'publish');

      // 1. Run the Weekly Report trigger job
      await triggerWeeklyReports(channel);

      // 2. Assert exactly one event was published to trackflow.events with routing key report.requested
      const reportRequestedCalls = publishSpy.mock.calls.filter(
        (call) => call[0] === 'trackflow.events' && call[1] === 'report.requested'
      );

      expect(reportRequestedCalls.length).toBe(1);

      // 3. Inspect published envelope payload
      const buffer = reportRequestedCalls[0][2] as Buffer;
      const envelope = JSON.parse(buffer.toString());
      
      expect(envelope.event_type).toBe('report.requested');
      expect(envelope.payload.client_id).toBe(activeClientId);
      expect(envelope.payload.recipient_email).toContain('active-client');
      
      const reportId = envelope.payload.report_id;
      createdReportIds.push(reportId);

      // 4. Verify PostgreSQL report record was successfully inserted in 'pending' status
      const report = await db.report.findUnique({
        where: { id: reportId }
      });

      expect(report).not.toBeNull();
      expect(report!.status).toBe('pending');
      expect(report!.requested_by).toBe(marketerId);
      expect(report!.file_path).toBeNull();
      expect(report!.completed_at).toBeNull();

      // Restore spy
      publishSpy.mockRestore();
    });

    it('should trigger inactivity alerts, publish events, and enforce Redis deduplication', async () => {
      // 1. Create a link created 30 hours ago with zero clicks (qualifies!)
      const oldLinkCode = `oldlnk${Date.now().toString().slice(-3)}`;
      const oldLink = await db.link.create({
        data: {
          short_code: oldLinkCode,
          original_url: 'https://example.com/old',
          created_by: marketerId,
          created_at: new Date(Date.now() - 30 * 60 * 60 * 1000) // 30 hours ago!
        }
      });

      // 2. Connect Redis client to check and cleanup keys
      const { createClient } = await import('redis');
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379/0';
      const redisClient = createClient({ url: redisUrl });
      await redisClient.connect();

      // Clear any leftover key
      const redisKey = `alert_sent:${oldLink.id}`;
      await redisClient.del(redisKey);

      const publishSpy = vi.spyOn(channel, 'publish');

      try {
        // Run checks (First execution: qualifies and alerts!)
        await triggerInactivityAlerts(channel, redisClient);

        // Verify notification was published
        const alertCalls1 = publishSpy.mock.calls.filter(
          (call) => {
            if (call[0] !== 'trackflow.events' || call[1] !== 'notification.send') return false;
            const content = JSON.parse((call[2] as Buffer).toString());
            return content.payload.type === 'alert_no_clicks' && content.payload.template_data.link_code === oldLinkCode;
          }
        );
        expect(alertCalls1.length).toBe(1);

        // Verify Redis key exists and has TTL
        const redisVal = await redisClient.get(redisKey);
        expect(redisVal).toBe('true');
        
        const ttl = await redisClient.ttl(redisKey);
        expect(ttl).toBeGreaterThan(86300); // close to 86400 (24h)

        // Reset spy history
        publishSpy.mockClear();

        // Run checks (Second execution: already sent, so deduplicates!)
        await triggerInactivityAlerts(channel, redisClient);

        // Verify NO new alert was published
        const alertCalls2 = publishSpy.mock.calls.filter(
          (call) => {
            if (call[0] !== 'trackflow.events' || call[1] !== 'notification.send') return false;
            const content = JSON.parse((call[2] as Buffer).toString());
            return content.payload.type === 'alert_no_clicks' && content.payload.template_data.link_code === oldLinkCode;
          }
        );
        expect(alertCalls2.length).toBe(0);

      } finally {
        // Cleanup Redis and PostgreSQL
        await redisClient.del(redisKey);
        await redisClient.disconnect();
        await db.link.delete({ where: { id: oldLink.id } });
        publishSpy.mockRestore();
      }
    });
  });
});
