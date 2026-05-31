import { FastifyInstance } from 'fastify';
import { db } from '@trackflow/db';

export default async function redirectRoutes(fastify: FastifyInstance) {
  fastify.get('/:short_code', async (request, reply) => {
    const { short_code } = request.params as { short_code: string };

    if (!short_code) {
      return reply.status(404).send({
        code: 'LINK_NOT_FOUND',
        message: 'Link does not exist or has expired.'
      });
    }

    const cacheKey = `link:${short_code}`;
    const clientIp = request.ip || '127.0.0.1';
    const userAgent = (request.headers['user-agent'] as string) || '';
    const referrer = (request.headers['referer'] as string) || '';

    try {
      // 1. Try Cache Hit (Redis)
      const cachedLink = await fastify.redis.get(cacheKey);

      if (cachedLink) {
        const link = JSON.parse(cachedLink);
        
        // Double check expiration inside cached data (safe fallback)
        if (link.expires_at && new Date(link.expires_at) < new Date()) {
          return reply.status(404).send({
            code: 'LINK_NOT_FOUND',
            message: 'Link does not exist or has expired.'
          });
        }

        // Asynchronously publish click.recorded event (non-blocking)
        fastify.rabbitmq.publish('click.recorded', {
          link_id: link.id,
          short_code,
          clicked_at: new Date().toISOString(),
          ip_address: clientIp,
          user_agent: userAgent,
          referrer
        }).catch((err) => {
          fastify.log.error(`Failed to publish click.recorded event (cache hit): ${err}`);
        });

        return reply.status(302).redirect(link.original_url);
      }

      // 2. Cache Miss (Query PostgreSQL)
      const link = await db.link.findUnique({
        where: {
          short_code,
          deleted_at: null
        }
      });

      if (!link) {
        return reply.status(404).send({
          code: 'LINK_NOT_FOUND',
          message: 'Link does not exist or has expired.'
        });
      }

      // Check if expired
      if (link.expires_at && new Date(link.expires_at) < new Date()) {
        return reply.status(404).send({
          code: 'LINK_NOT_FOUND',
          message: 'Link does not exist or has expired.'
        });
      }

      // 3. Write back to Cache
      let ttl = 604800; // Default: 7 days
      if (link.expires_at) {
        const remainingSeconds = Math.floor((new Date(link.expires_at).getTime() - Date.now()) / 1000);
        if (remainingSeconds <= 0) {
          return reply.status(404).send({
            code: 'LINK_NOT_FOUND',
            message: 'Link does not exist or has expired.'
          });
        }
        ttl = remainingSeconds;
      }

      const cachedData = {
        id: link.id,
        original_url: link.original_url,
        expires_at: link.expires_at
      };

      await fastify.redis.set(cacheKey, JSON.stringify(cachedData), {
        EX: ttl
      });

      // Asynchronously publish click.recorded event (non-blocking)
      fastify.rabbitmq.publish('click.recorded', {
        link_id: link.id,
        short_code,
        clicked_at: new Date().toISOString(),
        ip_address: clientIp,
        user_agent: userAgent,
        referrer
      }).catch((err) => {
        fastify.log.error(`Failed to publish click.recorded event (cache miss): ${err}`);
      });

      return reply.status(302).redirect(link.original_url);
    } catch (err) {
      fastify.log.error(err);
      
      // Fallback: If Redis is down, query Postgres directly (Graceful Degradation)
      try {
        const link = await db.link.findUnique({
          where: {
            short_code,
            deleted_at: null
          }
        });

        if (!link || (link.expires_at && new Date(link.expires_at) < new Date())) {
          return reply.status(404).send({
            code: 'LINK_NOT_FOUND',
            message: 'Link does not exist or has expired.'
          });
        }

        // Try publishing click even if Redis cache is down
        fastify.rabbitmq.publish('click.recorded', {
          link_id: link.id,
          short_code,
          clicked_at: new Date().toISOString(),
          ip_address: clientIp,
          user_agent: userAgent,
          referrer
        }).catch((publishErr) => {
          fastify.log.error(`Failed to publish click.recorded event (fallback): ${publishErr}`);
        });

        return reply.status(302).redirect(link.original_url);
      } catch (dbErr) {
        fastify.log.error(dbErr);
        return reply.status(500).send({
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred.'
        });
      }
    }
  });
}
