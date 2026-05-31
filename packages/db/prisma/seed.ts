import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database with test users...');

  const passwordHash = bcrypt.hashSync('test123', 10);

  // Marketer
  const marketer = await prisma.user.upsert({
    where: { email: 'marketer@test.com' },
    update: {
      password_hash: passwordHash,
      role: 'marketer',
    },
    create: {
      email: 'marketer@test.com',
      password_hash: passwordHash,
      role: 'marketer',
    },
  });
  console.log(`Seeded user: ${marketer.email} (${marketer.role})`);

  // Client
  const client = await prisma.user.upsert({
    where: { email: 'client@test.com' },
    update: {
      password_hash: passwordHash,
      role: 'client',
    },
    create: {
      email: 'client@test.com',
      password_hash: passwordHash,
      role: 'client',
    },
  });
  console.log(`Seeded user: ${client.email} (${client.role})`);

  console.log('Database seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error('Error during database seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
