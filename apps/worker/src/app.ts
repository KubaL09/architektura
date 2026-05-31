import amqp from 'amqplib';
import { db, Prisma } from '@trackflow/db';
import UAParser from 'ua-parser-js';
import geoip from 'geoip-lite';
import { createHash, randomUUID } from 'crypto';
import dotenv from 'dotenv';
import { createClient } from 'redis';
import { generateReportPdf } from './pdfGenerator.js';
import { sendEmail } from './emailService.js';
import { initCrons } from './cronScheduler.js';

dotenv.config();
dotenv.config({ path: '../../.env' });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry helper with backoff (1s -> 5s -> 30s)
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  delays = [1000, 5000, 30000]
): Promise<T> {
  let attempt = 1;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      // Do not retry unique constraint violations (P2002) as they are fatal/duplicates
      if (err.code === 'P2002') {
        throw err;
      }
      if (attempt >= retries) {
        throw err;
      }
      const waitTime = delays[attempt - 1] || 30000;
      console.warn(`[DB Retry] Attempt ${attempt} failed. Retrying in ${waitTime}ms... Error: ${err}`);
      await delay(waitTime);
      attempt++;
    }
  }
}

export const startWorker = async () => {
  const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672/';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379/0';
  const eventsExchange = 'trackflow.events';
  const deadExchange = 'trackflow.dead';
  const clicksQueue = 'trackflow.clicks';
  const reportsQueue = 'trackflow.reports';
  const notificationsQueue = 'trackflow.notifications';
  const deadQueue = 'trackflow.dead-letter';

  try {
    const connection = await amqp.connect(rabbitmqUrl);
    const channel = await connection.createChannel();

    // Connect to Redis for cron deduplication
    const redisClient = createClient({ url: redisUrl });
    await redisClient.connect();
    console.log('Connected to Redis cache store inside Worker.');

    // 1. Assert Exchanges
    await channel.assertExchange(eventsExchange, 'topic', { durable: true });
    await channel.assertExchange(deadExchange, 'direct', { durable: true });

    // 2. Assert Queues
    // Assert DLQ Queue
    await channel.assertQueue(deadQueue, { durable: true });
    await channel.bindQueue(deadQueue, deadExchange, '#');

    // Assert Clicks Queue with Dead Letter Exchange configuration
    await channel.assertQueue(clicksQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': deadExchange
      }
    });

    // Assert Reports Queue with Dead Letter Exchange configuration
    await channel.assertQueue(reportsQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': deadExchange
      }
    });

    // Assert Notifications Queue with Dead Letter Exchange configuration
    await channel.assertQueue(notificationsQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': deadExchange
      }
    });

    // 3. Bind Queues
    await channel.bindQueue(clicksQueue, eventsExchange, 'click.recorded');
    await channel.bindQueue(reportsQueue, eventsExchange, 'report.requested');
    await channel.bindQueue(notificationsQueue, eventsExchange, 'notification.send');

    console.log(`Connected to RabbitMQ. Listening on queues "${clicksQueue}" and "${reportsQueue}"...`);

    // 4. Start Consuming click.recorded Events
    await channel.consume(clicksQueue, async (msg) => {
      if (!msg) return;

      let envelope: any;
      try {
        envelope = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('Failed to parse event message JSON:', err);
        // Fatal JSON format error: Reject to DLQ immediately without redelivering
        channel.reject(msg, false);
        return;
      }

      const { event_id, payload } = envelope;

      if (!event_id || !payload) {
        console.error('Message is missing event_id or payload envelope headers:', envelope);
        channel.reject(msg, false);
        return;
      }

      try {
        // A. Idempotency Check
        const existingClick = await db.click.findUnique({
          where: { event_id }
        });

        if (existingClick) {
          console.info(`[Idempotency] Event "${event_id}" already recorded. Skipping and ACKing.`);
          channel.ack(msg);
          return;
        }

        // B. Parser User-Agent
        const parser = new UAParser(payload.user_agent);
        const uaParsed = parser.getResult();

        let deviceType = 'desktop'; // Fallback
        if (uaParsed.device && uaParsed.device.type) {
          const type = uaParsed.device.type.toLowerCase();
          if (type === 'mobile') {
            deviceType = 'mobile';
          } else if (type === 'tablet') {
            deviceType = 'tablet';
          }
        }

        const browser = uaParsed.browser.name || null;
        const os = uaParsed.os.name || null;

        // C. Offline IP Geolocalisation
        let country: string | null = null;
        let city: string | null = null;

        if (payload.ip_address) {
          try {
            // Promise.race to enforce a strict 100ms timeout
            const geoResult = await Promise.race([
              Promise.resolve(geoip.lookup(payload.ip_address)),
              new Promise<null>((_, reject) => 
                setTimeout(() => reject(new Error('GeoIP lookup timeout (>100ms)')), 100)
              )
            ]);

            if (geoResult) {
              country = geoResult.country || null;
              city = geoResult.city || null;
            }
          } catch (geoErr) {
            console.warn(`[GeoIP Offline Lookup Failed] Fallback to null. Error: ${geoErr}`);
          }
        }

        // D. GDPR IP Anonymisation
        const ipHash = payload.ip_address 
          ? createHash('sha256').update(payload.ip_address).digest('hex')
          : null;

        // E. PostgreSQL Write inside a Retry Wrapper
        try {
          await retryWithBackoff(async () => {
            await db.click.create({
              data: {
                link_id: payload.link_id,
                clicked_at: new Date(payload.clicked_at),
                country,
                city,
                device_type: deviceType,
                browser,
                os,
                referrer: payload.referrer || null,
                ip_hash: ipHash,
                event_id
              }
            });
          });
        } catch (dbErr: any) {
          // Handle concurrent write race conditions gracefully (P2002 Unique Constraint violation)
          if (dbErr instanceof Prisma.PrismaClientKnownRequestError && dbErr.code === 'P2002') {
            console.info(`[Idempotency Race] Click event "${event_id}" concurrently written. ACKing.`);
            channel.ack(msg);
            return;
          }
          throw dbErr;
        }

        // F. Successful manual acknowledgement
        channel.ack(msg);
        console.log(`[Clicks Consumer] Successfully processed click event: ${event_id}`);
      } catch (err: any) {
        console.error(`[Fatal Consumer Error] Failed to process click event: ${event_id}. Error: ${err}`);
        
        // Reject and send to DLQ (no re-queueing to clicksQueue to avoid infinite blocking loops)
        channel.reject(msg, false);
      }
    }, {
      noAck: false // Force manual acknowledgements
    });

    // 5. Start Consuming report.requested Events
    await channel.consume(reportsQueue, async (msg) => {
      if (!msg) return;

      let envelope: any;
      try {
        envelope = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('Failed to parse report event message JSON:', err);
        channel.reject(msg, false);
        return;
      }

      const { event_id, payload } = envelope;

      if (!event_id || !payload || !payload.report_id) {
        console.error('Report message is missing event_id, payload, or report_id envelope headers:', envelope);
        channel.reject(msg, false);
        return;
      }

      const { report_id } = payload;

      try {
        // A. Update status to 'processing'
        await db.report.update({
          where: { id: report_id },
          data: { status: 'processing' }
        });

        console.info(`[Reports Consumer] Generating PDF report "${report_id}"...`);

        // B. Generate PDF (queries Postgres and renders with Puppeteer)
        const result = await generateReportPdf({
          report_id,
          requested_by: payload.requested_by,
          date_from: payload.date_from,
          date_to: payload.date_to,
          client_id: payload.client_id,
          link_id: payload.link_id
        });

        // C. Update status to 'done'
        await db.report.update({
          where: { id: report_id },
          data: {
            status: 'done',
            completed_at: new Date(),
            file_path: result.file_path
          }
        });

        console.info(`[Reports Consumer] Successfully generated PDF for report "${report_id}". Path: ${result.file_path}`);

        // D. Publish notification.send if recipient_email is defined
        if (payload.recipient_email) {
          const notificationPayload = {
            type: 'report_ready',
            recipient_email: payload.recipient_email,
            subject: 'Twój raport TrackFlow jest gotowy!',
            template_data: {
              user_name: payload.recipient_email.split('@')[0],
              download_url: `http://localhost:3000/api/reports/${report_id}/download`,
              period_start: payload.date_from.split('T')[0],
              period_end: payload.date_to.split('T')[0],
              file_path: result.file_path
            }
          };

          const notificationEnvelope = {
            event_id: randomUUID(),
            event_type: 'notification.send',
            version: '1.0',
            timestamp: new Date().toISOString(),
            payload: notificationPayload
          };

          channel.publish(
            eventsExchange,
            'notification.send',
            Buffer.from(JSON.stringify(notificationEnvelope)),
            { persistent: true }
          );

          console.info(`[Reports Consumer] Published notification.send for report "${report_id}" to ${payload.recipient_email}`);
        }

        // E. Manual ACK
        channel.ack(msg);
      } catch (err: any) {
        console.error(`[Fatal Report Consumer Error] Failed to generate report ${report_id}. Error: ${err}`);

        try {
          // Fallback: update status to failed in database
          await db.report.update({
            where: { id: report_id },
            data: {
              status: 'failed',
              completed_at: new Date(),
              error_message: err.message || String(err)
            }
          });
        } catch (dbErr) {
          console.error(`[DB Error] Failed to update report "${report_id}" to failed status. Error: ${dbErr}`);
        }

        // Manual ACK even on failure to avoid infinite re-delivery of broken reports
        channel.ack(msg);
      }
    }, {
      noAck: false // Force manual acknowledgements
    });

    // 6. Start Consuming notification.send Events
    await channel.consume(notificationsQueue, async (msg) => {
      if (!msg) return;

      let envelope: any;
      try {
        envelope = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('Failed to parse notification event message JSON:', err);
        channel.reject(msg, false);
        return;
      }

      const { event_id, payload } = envelope;

      if (!event_id || !payload || !payload.recipient_email) {
        console.error('Notification message is missing event_id, payload, or recipient_email envelope headers:', envelope);
        channel.reject(msg, false);
        return;
      }

      try {
        console.info(`[Notifications Consumer] Sending email of type "${payload.type}" to "${payload.recipient_email}"...`);

        // Send email via SMTP/Nodemailer
        await sendEmail({
          type: payload.type,
          recipient_email: payload.recipient_email,
          subject: payload.subject,
          template_data: payload.template_data
        });

        console.info(`[Notifications Consumer] Successfully sent email to "${payload.recipient_email}" for event: ${event_id}`);

        // Manual ACK on success
        channel.ack(msg);
      } catch (err: any) {
        console.error(`[Fatal Notification Consumer Error] Failed to process notification email for event ${event_id} to ${payload.recipient_email}. Error: ${err}`);

        // Reject and send to DLQ (no re-queueing to prevent blocking other emails)
        channel.reject(msg, false);
      }
    }, {
      noAck: false // Force manual acknowledgements
    });

    // 7. Initialize scheduled cron jobs
    initCrons(channel, redisClient);

    return { connection, channel, redisClient };
  } catch (err) {
    console.error('Worker failed to connect to RabbitMQ broker:', err);
    throw err;
  }
};
