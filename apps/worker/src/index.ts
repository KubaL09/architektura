import { startWorker } from './app.js';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

console.log('Worker Service is starting up...');

// A simple dummy task just to verify cron imports and works
cron.schedule('*/5 * * * * *', () => {
  console.log('Worker tick - cron is active.');
}, {
  scheduled: false // Do not run automatically to avoid noise
});

const start = async () => {
  try {
    // Start RabbitMQ click.recorded consumers
    await startWorker();
    console.log('Worker Service started successfully and running.');
  } catch (err) {
    console.error('Failed to start worker service:', err);
    process.exit(1);
  }
};

start();
