import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { db } from '@trackflow/db';

export default async function authRoutes(fastify: FastifyInstance) {
  // 1. POST /auth/login
  fastify.post('/login', async (request, reply) => {
    const { email, password } = request.body as any || {};

    if (!email || !password) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'E-mail and password are required.'
      });
    }

    try {
      const user = await db.user.findUnique({
        where: { email }
      });

      if (!user) {
        return reply.status(401).send({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid e-mail or password.'
        });
      }

      const passwordMatch = bcrypt.compareSync(password, user.password_hash);
      if (!passwordMatch) {
        return reply.status(401).send({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid e-mail or password.'
        });
      }

      const token = fastify.jwt.sign({
        id: user.id,
        email: user.email,
        role: user.role
      });

      return reply.status(200).send({
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        }
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.'
      });
    }
  });

  // 2. POST /auth/change-password (Secured)
  fastify.post('/change-password', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { old_password, new_password } = request.body as any || {};
    const currentUser = request.user; // Set by jwtVerify

    if (!old_password || !new_password) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Old and new passwords are required.'
      });
    }

    // Basic strength check (at least 6 characters)
    if (new_password.length < 6) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Password criteria not met.'
      });
    }

    try {
      const user = await db.user.findUnique({
        where: { id: currentUser.id }
      });

      if (!user) {
        return reply.status(404).send({
          code: 'USER_NOT_FOUND',
          message: 'User does not exist.'
        });
      }

      const passwordMatch = bcrypt.compareSync(old_password, user.password_hash);
      if (!passwordMatch) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Invalid old password.'
        });
      }

      const hashedNewPassword = bcrypt.hashSync(new_password, 10);
      await db.user.update({
        where: { id: user.id },
        data: {
          password_hash: hashedNewPassword
        }
      });

      return reply.status(204).send(); // No content
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.'
      });
    }
  });
}
