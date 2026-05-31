import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import amqp from 'amqplib';
import { randomUUID } from 'crypto';

declare module 'fastify' {
  interface FastifyInstance {
    rabbitmq: {
      publish: (routingKey: string, payload: any) => Promise<boolean>;
      channel: any;
      connection: any;
    };
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672/';
  const exchangeName = 'trackflow.events';

  try {
    const connection = await amqp.connect(rabbitmqUrl);
    const channel = await connection.createChannel();

    // Assert exchange as durable topic exchange
    await channel.assertExchange(exchangeName, 'topic', {
      durable: true
    });

    fastify.log.info('Connected to RabbitMQ and exchange asserted.');

    const publish = async (routingKey: string, payload: any) => {
      const envelope = {
        event_id: randomUUID(),
        event_type: routingKey,
        version: '1.0',
        timestamp: new Date().toISOString(),
        payload
      };

      const buffer = Buffer.from(JSON.stringify(envelope));
      
      // Publish with persistent flag to guarantee at-least-once durability
      return channel.publish(exchangeName, routingKey, buffer, {
        persistent: true
      });
    };

    fastify.decorate('rabbitmq', {
      publish,
      channel,
      connection
    });

    fastify.addHook('onClose', async (instance) => {
      try {
        await channel.close();
        await connection.close();
      } catch (err) {
        fastify.log.error(`Error closing RabbitMQ connection: ${err}`);
      }
    });
  } catch (err) {
    fastify.log.error(`RabbitMQ Connection Error: ${err}`);
    throw err;
  }
});
