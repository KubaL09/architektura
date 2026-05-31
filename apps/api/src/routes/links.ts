import { FastifyInstance } from 'fastify';
import { db } from '@trackflow/db';
import { customAlphabet } from 'nanoid';

const generateShortCode = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 6);

export default async function linkRoutes(fastify: FastifyInstance) {
  // Pre-handler hook to authenticate all routes in this plugin
  fastify.addHook('preHandler', fastify.authenticate);

  // 1. GET /api/links (Secured, paginated, filtered)
  fastify.get('/api/links', async (request, reply) => {
    const currentUser = request.user;
    const { page = '1', limit = '20', campaign_name, client_id, search } = request.query as any;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    // Build Prisma query filters
    const whereClause: any = {
      deleted_at: null
    };

    // Client role boundary check: can only see their own assigned links
    if (currentUser.role === 'client') {
      whereClause.client_id = currentUser.id;
    } else {
      // Marketer can filter by client_id
      if (client_id) {
        whereClause.client_id = client_id;
      }
    }

    // Filter by campaign name
    if (campaign_name) {
      whereClause.campaign_name = {
        contains: campaign_name,
        mode: 'insensitive'
      };
    }

    // Filter by search phrase (original_url or short_code)
    if (search) {
      whereClause.OR = [
        {
          original_url: {
            contains: search,
            mode: 'insensitive'
          }
        },
        {
          short_code: {
            contains: search,
            mode: 'insensitive'
          }
        }
      ];
    }

    try {
      const [total, links] = await Promise.all([
        db.link.count({ where: whereClause }),
        db.link.findMany({
          where: whereClause,
          skip,
          take: limitNum,
          orderBy: { created_at: 'desc' }
        })
      ]);

      return reply.status(200).send({
        data: links,
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

  // 2. POST /api/links (Secured, Marketer only)
  fastify.post('/api/links', async (request, reply) => {
    const currentUser = request.user;

    // RBAC: Only marketer can create links
    if (currentUser.role !== 'marketer') {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'Only marketers are authorized to create links.'
      });
    }

    const { original_url, campaign_name, client_id, expires_at } = request.body as any || {};

    if (!original_url) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Original URL is required.'
      });
    }

    // Validate original_url format
    try {
      const parsedUrl = new URL(original_url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error();
      }
    } catch (err) {
      return reply.status(400).send({
        code: 'INVALID_URL',
        message: 'Provided string is not a valid HTTP/HTTPS URL.'
      });
    }

    // Validate client_id exists if provided
    if (client_id) {
      try {
        const clientUser = await db.user.findFirst({
          where: { id: client_id, role: 'client' }
        });
        if (!clientUser) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            message: 'Provided client_id does not belong to a valid client user.'
          });
        }
      } catch (err) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid client_id UUID format.'
        });
      }
    }

    // Validate expires_at is in the future and <= 365 days
    let expiresDate: Date | null = null;
    if (expires_at) {
      expiresDate = new Date(expires_at);
      const now = Date.now();
      const expiresTime = expiresDate.getTime();

      if (isNaN(expiresTime)) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid expiration date format.'
        });
      }

      if (expiresTime <= now) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Expiration date must be in the future.'
        });
      }

      const maxExpiry = now + 365 * 24 * 60 * 60 * 1000;
      if (expiresTime > maxExpiry) {
        return reply.status(400).send({
          code: 'EXPIRY_LIMIT_EXCEEDED',
          message: 'Expiration date cannot exceed 365 days from now.'
        });
      }
    }

    try {
      // Generate unique short_code
      let shortCode = '';
      let isUnique = false;
      let attempts = 0;
      while (!isUnique && attempts < 10) {
        shortCode = generateShortCode();
        const existing = await db.link.findUnique({
          where: { short_code: shortCode }
        });
        if (!existing) {
          isUnique = true;
        }
        attempts++;
      }

      if (!isUnique) {
        return reply.status(500).send({
          code: 'SHORT_CODE_GENERATION_FAILED',
          message: 'Failed to generate a unique short code. Please try again.'
        });
      }

      // Create in PostgreSQL
      const link = await db.link.create({
        data: {
          short_code: shortCode,
          original_url,
          campaign_name: campaign_name || null,
          client_id: client_id || null,
          expires_at: expiresDate,
          created_by: currentUser.id
        }
      });

      // Warm Cache: Save directly to Redis immediately for sub-millisecond redirect
      const cacheKey = `link:${shortCode}`;
      let ttl = 604800; // 7 days default
      if (expiresDate) {
        ttl = Math.floor((expiresDate.getTime() - Date.now()) / 1000);
      }

      const cachedData = {
        id: link.id,
        original_url: link.original_url,
        expires_at: link.expires_at
      };

      if (ttl > 0) {
        await fastify.redis.set(cacheKey, JSON.stringify(cachedData), {
          EX: ttl
        });
      }

      return reply.status(201).send(link);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.'
      });
    }
  });

  // 3. GET /api/links/:id (Secured, boundary checks)
  fastify.get('/api/links/:id', async (request, reply) => {
    const currentUser = request.user;
    const { id } = request.params as { id: string };

    try {
      const link = await db.link.findFirst({
        where: {
          id,
          deleted_at: null
        }
      });

      if (!link) {
        return reply.status(404).send({
          code: 'LINK_NOT_FOUND',
          message: 'Link does not exist or you do not have permission to view it.'
        });
      }

      // Client boundary check: can only see their own assigned link
      if (currentUser.role === 'client' && link.client_id !== currentUser.id) {
        return reply.status(404).send({
          code: 'LINK_NOT_FOUND',
          message: 'Link does not exist or you do not have permission to view it.'
        });
      }

      return reply.status(200).send(link);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(404).send({
        code: 'LINK_NOT_FOUND',
        message: 'Link does not exist or you do not have permission to view it.'
      });
    }
  });

  // 4. DELETE /api/links/:id (Secured, Marketer only, soft-delete, cache eviction)
  fastify.delete('/api/links/:id', async (request, reply) => {
    const currentUser = request.user;
    const { id } = request.params as { id: string };

    // RBAC: Only marketer can delete links
    if (currentUser.role !== 'marketer') {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'Only marketers are authorized to delete links.'
      });
    }

    try {
      const link = await db.link.findFirst({
        where: {
          id,
          deleted_at: null
        }
      });

      if (!link) {
        return reply.status(404).send({
          code: 'LINK_NOT_FOUND',
          message: 'Link does not exist or has already been deleted.'
        });
      }

      // 1. PostgreSQL Soft-Delete
      await db.link.update({
        where: { id: link.id },
        data: { deleted_at: new Date() }
      });

      // 2. Cache Eviction (critical for consistency)
      const cacheKey = `link:${link.short_code}`;
      await fastify.redis.del(cacheKey);

      return reply.status(204).send(); // No content
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.'
      });
    }
  });

  // 5. GET /api/clients (Secured, Marketer only utility)
  fastify.get('/api/clients', async (request, reply) => {
    const currentUser = request.user;

    // RBAC: Only marketer can query clients list dropdown
    if (currentUser.role !== 'marketer') {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'Only marketers are authorized to view clients list.'
      });
    }

    try {
      const clients = await db.user.findMany({
        where: {
          role: 'client'
        },
        select: {
          id: true,
          email: true,
          created_at: true
        },
        orderBy: {
          email: 'asc'
        }
      });

      return reply.status(200).send({
        data: clients
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
