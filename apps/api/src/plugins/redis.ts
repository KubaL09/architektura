import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createClient } from 'redis';

declare module 'fastify' {
  interface FastifyInstance {
    redis: ReturnType<typeof createClient>;
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379/0';
  const client = createClient({ url: redisUrl });

  client.on('error', (err) => {
    fastify.log.error(`Redis Client Error: ${err}`);
  });

  await client.connect();
  fastify.log.info('Connected to Redis cache store.');

  fastify.decorate('redis', client);

  fastify.addHook('onClose', async (instance) => {
    await client.disconnect();
  });
});
