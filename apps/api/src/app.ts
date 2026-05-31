import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import authPlugin from './plugins/auth.js';
import redisPlugin from './plugins/redis.js';
import rabbitmqPlugin from './plugins/rabbitmq.js';
import authRoutes from './routes/auth.js';
import redirectRoutes from './routes/redirect.js';
import linkRoutes from './routes/links.js';
import statsRoutes from './routes/stats.js';
import reportsRoutes from './routes/reports.js';

dotenv.config();
dotenv.config({ path: '../../.env' });

export const app = Fastify({
  logger: process.env.NODE_ENV === 'test' ? false : true
});

// Register CORS
app.register(cors, {
  origin: true
});

// Register Redis Plugin
app.register(redisPlugin);

// Register RabbitMQ Plugin
app.register(rabbitmqPlugin);

// Register custom authentication plugin (sets up @fastify/jwt and authenticate decorator)
app.register(authPlugin);

// Register authentication routes
app.register(authRoutes, { prefix: '/auth' });

// Register Link CRUD routes
app.register(linkRoutes);

// Register Stats routes
app.register(statsRoutes);

// Register Reports routes
app.register(reportsRoutes);

// Register root redirect router (register last because of the catch-all wildcard /:short_code route!)
app.register(redirectRoutes);

app.get('/health', async (request, reply) => {
  return { status: 'OK', service: 'api' };
});
