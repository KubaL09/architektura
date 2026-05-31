import { FastifyInstance } from 'fastify';
import { db } from '@trackflow/db';

export default async function statsRoutes(fastify: FastifyInstance) {
  // Pre-handler hook to authenticate all routes in this plugin
  fastify.addHook('preHandler', fastify.authenticate);

  // 1. GET /api/links/:id/stats (Real-time analytics aggregations)
  fastify.get('/api/links/:id/stats', async (request, reply) => {
    const currentUser = request.user;
    const { id } = request.params as { id: string };
    const { period = 'day', date_from, date_to } = request.query as any;

    // Validate period parameter
    if (period !== 'hour' && period !== 'day' && period !== 'week') {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid period parameter. Accepted values are "hour", "day", "week".'
      });
    }

    // Parse date ranges
    let fromDate: Date;
    if (date_from) {
      fromDate = new Date(date_from);
      if (isNaN(fromDate.getTime())) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid date_from format. Must be a valid ISO 8601 string.'
        });
      }
    } else {
      // Default: 30 days ago
      fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }

    let toDate: Date;
    if (date_to) {
      toDate = new Date(date_to);
      if (isNaN(toDate.getTime())) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid date_to format. Must be a valid ISO 8601 string.'
        });
      }
    } else {
      toDate = new Date();
    }

    try {
      // 1. Fetch Link & enforce boundary check
      const link = await db.link.findFirst({
        where: {
          id,
          deleted_at: null
        }
      });

      if (!link) {
        return reply.status(404).send({
          code: 'LINK_NOT_FOUND',
          message: 'Link not found or no permission.'
        });
      }

      // Client boundary check: can only view their own link statistics
      if (currentUser.role === 'client' && link.client_id !== currentUser.id) {
        return reply.status(404).send({
          code: 'LINK_NOT_FOUND',
          message: 'Link not found or no permission.'
        });
      }

      // 2. Perform all aggregations in parallel using Promise.all
      const [counts, clicksOverTime, byCountry, byDevice, byReferrer] = await Promise.all([
        // A. Total & Unique clicks (Raw SQL for distinct ip_hash counting)
        db.$queryRaw<any[]>`
          SELECT 
            COUNT(id)::int AS total_clicks,
            COUNT(DISTINCT ip_hash)::int AS unique_clicks
          FROM clicks
          WHERE 
            link_id = ${id}::uuid
            AND clicked_at >= ${fromDate}::timestamptz
            AND clicked_at <= ${toDate}::timestamptz
        `,
        // B. Clicks over time (Raw SQL utilizing date_trunc on PostgreSQL)
        period === 'hour'
          ? db.$queryRaw<any[]>`
              SELECT 
                date_trunc('hour', clicked_at) AS timestamp, 
                COUNT(id)::int AS count 
              FROM clicks 
              WHERE 
                link_id = ${id}::uuid 
                AND clicked_at >= ${fromDate}::timestamptz 
                AND clicked_at <= ${toDate}::timestamptz 
              GROUP BY timestamp 
              ORDER BY timestamp ASC
            `
          : period === 'week'
          ? db.$queryRaw<any[]>`
              SELECT 
                date_trunc('week', clicked_at) AS timestamp, 
                COUNT(id)::int AS count 
              FROM clicks 
              WHERE 
                link_id = ${id}::uuid 
                AND clicked_at >= ${fromDate}::timestamptz 
                AND clicked_at <= ${toDate}::timestamptz 
              GROUP BY timestamp 
              ORDER BY timestamp ASC
            `
          : db.$queryRaw<any[]>`
              SELECT 
                date_trunc('day', clicked_at) AS timestamp, 
                COUNT(id)::int AS count 
              FROM clicks 
              WHERE 
                link_id = ${id}::uuid 
                AND clicked_at >= ${fromDate}::timestamptz 
                AND clicked_at <= ${toDate}::timestamptz 
              GROUP BY timestamp 
              ORDER BY timestamp ASC
            `,
        // C. Group by Country
        db.click.groupBy({
          by: ['country'],
          where: {
            link_id: id,
            clicked_at: { gte: fromDate, lte: toDate }
          },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } }
        }),
        // D. Group by Device Type
        db.click.groupBy({
          by: ['device_type'],
          where: {
            link_id: id,
            clicked_at: { gte: fromDate, lte: toDate }
          },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } }
        }),
        // E. Group by Referrer
        db.click.groupBy({
          by: ['referrer'],
          where: {
            link_id: id,
            clicked_at: { gte: fromDate, lte: toDate }
          },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } }
        })
      ]);

      const totalClicks = counts[0]?.total_clicks || 0;
      const uniqueClicks = counts[0]?.unique_clicks || 0;

      // Map Country stats (null country -> 'Unknown')
      const countryStats = byCountry.map((item) => ({
        country: item.country || 'Unknown',
        count: item._count.id
      }));

      // Map Device stats (null device_type -> 'desktop')
      const deviceStats = byDevice.map((item) => ({
        device_type: item.device_type || 'desktop',
        count: item._count.id
      }));

      // Map Referrer stats (Clean hostnames, group domain clicks, limit to Top 5)
      const referrerMap = new Map<string, number>();
      for (const item of byReferrer) {
        let host = 'Direct / Unknown';
        if (item.referrer) {
          try {
            const url = new URL(item.referrer);
            host = url.hostname.replace('www.', ''); // clean domain grouping
          } catch (err) {
            host = item.referrer; // fallback if string isn't a URL
          }
        }
        referrerMap.set(host, (referrerMap.get(host) || 0) + item._count.id);
      }

      const referrerStats = Array.from(referrerMap.entries())
        .map(([referrer, count]) => ({ referrer, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      return reply.status(200).send({
        total_clicks: totalClicks,
        unique_clicks: uniqueClicks,
        clicks_over_time: clicksOverTime.map(row => ({
          timestamp: row.timestamp,
          count: row.count
        })),
        by_country: countryStats,
        by_device: deviceStats,
        by_referrer: referrerStats
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.'
      });
    }
  });
}
