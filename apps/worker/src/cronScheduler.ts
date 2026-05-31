import cron from 'node-cron';
import { db } from '@trackflow/db';
import amqp from 'amqplib';
import { randomUUID } from 'crypto';

/**
 * Calculates the previous full week range (Monday 00:00:00.000 to Sunday 23:59:59.999)
 */
export function getPreviousWeekRange(now = new Date()): { date_from: Date; date_to: Date } {
  const day = now.getDay(); // 0 is Sunday, 1 is Monday, etc.
  const diffToLastMonday = (day === 0 ? 6 : day - 1) + 7;

  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - diffToLastMonday);
  lastMonday.setHours(0, 0, 0, 0);

  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  lastSunday.setHours(23, 59, 59, 999);

  return {
    date_from: lastMonday,
    date_to: lastSunday
  };
}

/**
 * Executes the weekly report cron generation job
 */
export async function triggerWeeklyReports(channel: amqp.Channel) {
  console.info('[Cron weekly-report] Starting weekly reports trigger job...');

  try {
    // 1. Fetch system marketer to act as requester on database constraint
    const systemMarketer = await db.user.findFirst({
      where: { role: 'marketer' }
    });

    if (!systemMarketer) {
      console.warn('[Cron weekly-report] No marketer account found in PostgreSQL. Skipping job.');
      return;
    }

    // 2. Fetch all clients who have at least one active (non-deleted, non-expired) campaign link
    const clients = await db.user.findMany({
      where: {
        role: 'client',
        assigned_links: {
          some: {
            deleted_at: null,
            OR: [
              { expires_at: null },
              { expires_at: { gt: new Date() } }
            ]
          }
        }
      }
    });

    console.info(`[Cron weekly-report] Found ${clients.length} active clients qualified for weekly reports.`);

    if (clients.length === 0) return;

    // 3. Compute date boundaries for the previous full week
    const { date_from, date_to } = getPreviousWeekRange();

    // 4. Generate report orders
    const eventsExchange = 'trackflow.events';
    for (const client of clients) {
      const reportId = randomUUID();

      // A. Create pending report row in PostgreSQL
      await db.report.create({
        data: {
          id: reportId,
          status: 'pending',
          requested_by: systemMarketer.id,
          date_from,
          date_to
        }
      });

      // B. Build AMQP event envelope
      const payload = {
        report_id: reportId,
        requested_by: systemMarketer.id,
        date_from: date_from.toISOString(),
        date_to: date_to.toISOString(),
        client_id: client.id,
        link_id: null,
        recipient_email: client.email
      };

      const envelope = {
        event_id: randomUUID(),
        event_type: 'report.requested',
        version: '1.0',
        timestamp: new Date().toISOString(),
        payload
      };

      // C. Publish event
      channel.publish(
        eventsExchange,
        'report.requested',
        Buffer.from(JSON.stringify(envelope)),
        { persistent: true }
      );

      console.info(`[Cron weekly-report] Published report.requested for client "${client.email}" (Report ID: ${reportId})`);
    }

    console.info('[Cron weekly-report] Successfully triggered weekly reports.');
  } catch (err) {
    console.error(`[Cron weekly-report Error] Failed to complete trigger job: ${err}`);
  }
}

/**
 * Executes the inactivity alert cron checks
 */
export async function triggerInactivityAlerts(channel: amqp.Channel, redisClient: any) {
  console.info('[Cron alert-no-clicks] Starting inactivity checks for active links...');

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 1. Fetch links created > 24 hours ago that received zero clicks in the last 24 hours
    const inactiveLinks = await db.link.findMany({
      where: {
        deleted_at: null,
        created_at: { lt: cutoff },
        OR: [
          { expires_at: null },
          { expires_at: { gt: new Date() } }
        ],
        // No clicks recorded in the last 24 hours
        clicks: {
          none: {
            clicked_at: { gte: cutoff }
          }
        }
      },
      include: {
        creator: true
      }
    });

    console.info(`[Cron alert-no-clicks] Found ${inactiveLinks.length} inactive links qualifying for alerts.`);

    if (inactiveLinks.length === 0) return;

    const eventsExchange = 'trackflow.events';

    for (const link of inactiveLinks) {
      const redisKey = `alert_sent:${link.id}`;

      // A. Query Redis for deduplication key
      const alreadySent = await redisClient.get(redisKey);

      if (alreadySent) {
        console.info(`[Cron alert-no-clicks] Inactivity alert already sent for link "${link.short_code}" in last 24h. Skipping.`);
        continue;
      }

      // B. Save deduplication key in Redis with 24h TTL (86400 seconds)
      await redisClient.set(redisKey, 'true', { EX: 86400 });

      // C. Build notification payload matching contract specifications
      const payload = {
        type: 'alert_no_clicks',
        recipient_email: link.creator.email,
        subject: `Campaign Alert: Inactive Link - ${link.short_code}`,
        template_data: {
          link_code: link.short_code,
          campaign_name: link.campaign_name || 'Unnamed Campaign'
        }
      };

      const envelope = {
        event_id: randomUUID(),
        event_type: 'notification.send',
        version: '1.0',
        timestamp: new Date().toISOString(),
        payload
      };

      // D. Publish event to queue
      channel.publish(
        eventsExchange,
        'notification.send',
        Buffer.from(JSON.stringify(envelope)),
        { persistent: true }
      );

      console.info(`[Cron alert-no-clicks] Published alert for link "${link.short_code}" to marketer "${link.creator.email}"`);
    }

    console.info('[Cron alert-no-clicks] Finished inactivity checks.');
  } catch (err) {
    console.error(`[Cron alert-no-clicks Error] Inactivity checks trigger failed: ${err}`);
  }
}

/**
 * Initializes cron jobs on worker startup
 */
export function initCrons(channel: amqp.Channel, redisClient: any) {
  // Step 11: Register cron weekly-report schedule: Every Monday at 8:00 AM (0 8 * * 1)
  cron.schedule('0 8 * * 1', async () => {
    await triggerWeeklyReports(channel);
  });

  // Step 12: Register cron alert-no-clicks schedule: Every 15 minutes (*/15 * * * *)
  cron.schedule('*/15 * * * *', async () => {
    await triggerInactivityAlerts(channel, redisClient);
  });

  console.info('[Cron Scheduler] Successfully initialized weekly-report ("0 8 * * 1") and alert-no-clicks ("*/15 * * * *") cron jobs.');
}
