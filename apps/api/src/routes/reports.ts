import { FastifyInstance } from 'fastify';
import { db } from '@trackflow/db';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export default async function reportsRoutes(fastify: FastifyInstance) {
  // Pre-handler hook to authenticate all routes in this plugin
  fastify.addHook('preHandler', fastify.authenticate);

  // Helper: check if currentUser is a marketer
  const enforceMarketer = (role: string, reply: any) => {
    if (role !== 'marketer') {
      reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'Only marketers are authorized to manage reports.'
      });
      return false;
    }
    return true;
  };

  // 1. POST /api/reports (Secured, Marketer only, orders async PDF generation)
  fastify.post('/api/reports', async (request, reply) => {
    const currentUser = request.user;
    if (!enforceMarketer(currentUser.role, reply)) return;

    const { date_from, date_to, client_id, link_id } = request.body as any || {};

    if (!date_from || !date_to) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Start date (date_from) and end date (date_to) are required.'
      });
    }

    const fromDate = new Date(date_from);
    const toDate = new Date(date_to);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid date formats provided.'
      });
    }

    if (fromDate > toDate) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Start date cannot be later than end date.'
      });
    }

    try {
      // Find recipient email if client scope is selected
      let recipientEmail: string | null = null;
      if (client_id) {
        const client = await db.user.findFirst({
          where: { id: client_id, role: 'client' }
        });
        if (client) {
          recipientEmail = client.email;
        }
      } else if (link_id) {
        // If specific link is selected, check if it is assigned to a client to notify them
        const link = await db.link.findUnique({
          where: { id: link_id }
        });
        if (link && link.client_id) {
          const client = await db.user.findUnique({
            where: { id: link.client_id }
          });
          if (client) {
            recipientEmail = client.email;
          }
        }
      }

      // Create pending record in PostgreSQL reports table
      const report = await db.report.create({
        data: {
          id: randomUUID(),
          status: 'pending',
          date_from: fromDate,
          date_to: toDate,
          requested_by: currentUser.id
        }
      });

      // Construct AMQP event envelope
      const eventEnvelope = {
        event_id: randomUUID(),
        event_type: 'report.requested',
        version: '1.0',
        timestamp: new Date().toISOString(),
        payload: {
          report_id: report.id,
          requested_by: report.requested_by,
          date_from: report.date_from.toISOString(),
          date_to: report.date_to.toISOString(),
          client_id: client_id || null,
          link_id: link_id || null,
          recipient_email: recipientEmail
        }
      };

      // Publish E2E message durably to RabbitMQ Exchange
      const exchangeName = 'trackflow.events';
      const routingKey = 'report.requested';
      
      fastify.rabbitmq.channel.publish(
        exchangeName,
        routingKey,
        Buffer.from(JSON.stringify(eventEnvelope)),
        { persistent: true }
      );

      return reply.status(202).send({
        report_id: report.id,
        status: report.status
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.'
      });
    }
  });

  // 2. GET /api/reports (Secured, Marketer only, paginated list of requests)
  fastify.get('/api/reports', async (request, reply) => {
    const currentUser = request.user;
    if (!enforceMarketer(currentUser.role, reply)) return;

    const { page = '1', limit = '20' } = request.query as any;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    try {
      const [total, reports] = await Promise.all([
        db.report.count({
          where: { requested_by: currentUser.id }
        }),
        db.report.findMany({
          where: { requested_by: currentUser.id },
          skip,
          take: limitNum,
          orderBy: { created_at: 'desc' }
        })
      ]);

      return reply.status(200).send({
        data: reports,
        total,
        page: pageNum,
        limit: limitNum
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.'
      });
    }
  });

  // 3. GET /api/reports/:id (Secured, Marketer only details)
  fastify.get('/api/reports/:id', async (request, reply) => {
    const currentUser = request.user;
    if (!enforceMarketer(currentUser.role, reply)) return;

    const { id } = request.params as { id: string };

    try {
      const report = await db.report.findFirst({
        where: {
          id,
          requested_by: currentUser.id
        }
      });

      if (!report) {
        return reply.status(404).send({
          code: 'REPORT_NOT_FOUND',
          message: 'Report task does not exist.'
        });
      }

      // Build dynamic absolute download url
      const host = request.headers.host || 'localhost:3000';
      const scheme = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const downloadUrl = report.status === 'done' 
        ? `${scheme}://${host}/api/reports/${report.id}/download` 
        : null;

      return reply.status(200).send({
        id: report.id,
        status: report.status,
        download_url: downloadUrl,
        error_message: report.error_message,
        created_at: report.created_at,
        completed_at: report.completed_at
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(404).send({
        code: 'REPORT_NOT_FOUND',
        message: 'Report task does not exist.'
      });
    }
  });

  // 4. GET /api/reports/:id/download (Secured, Marketer only binary file downloader)
  fastify.get('/api/reports/:id/download', async (request, reply) => {
    const currentUser = request.user;
    if (!enforceMarketer(currentUser.role, reply)) return;

    const { id } = request.params as { id: string };

    try {
      const report = await db.report.findFirst({
        where: {
          id,
          requested_by: currentUser.id
        }
      });

      if (!report) {
        return reply.status(404).send({
          code: 'REPORT_NOT_FOUND',
          message: 'Report task does not exist.'
        });
      }

      if (report.status !== 'done' || !report.file_path) {
        return reply.status(400).send({
          code: 'REPORT_NOT_READY',
          message: 'Report is still processing or has failed.'
        });
      }

      // Resolve file path cleanly on disk. If saved by the worker inside apps/worker/storage,
      // it might have an absolute path or relative path, check both.
      let actualPath = report.file_path;

      // Handle Docker absolute /app volume mapping resolving locally
      if (actualPath.startsWith('/app/')) {
        const relative = actualPath.replace(/^\/app\//, '');
        actualPath = path.resolve(__dirname, '../../../../', relative);
      }

      // Fallback: check inside apps/worker/storage if not resolved
      if (!fs.existsSync(actualPath)) {
        const basename = path.basename(report.file_path);
        actualPath = path.resolve(__dirname, '../../../worker/storage/reports', basename);
      }

      // Verify file exists on disk
      if (!fs.existsSync(actualPath)) {
        return reply.status(404).send({
          code: 'FILE_NOT_FOUND',
          message: 'The PDF file does not exist on disk.'
        });
      }

      // Set binary response headers
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="report_${report.id}.pdf"`);

      // Stream file directly to client
      const stream = fs.createReadStream(actualPath);
      return reply.send(stream);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(404).send({
        code: 'REPORT_NOT_FOUND',
        message: 'Report task does not exist.'
      });
    }
  });
}
