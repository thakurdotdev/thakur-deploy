import { Elysia } from 'elysia';
import { Builder } from './services/builder';

// Prevent crash on unhandled errors to stop restart loops
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log('🚀 Starting Build Worker...');

// HTTP-based build worker (no Redis/BullMQ dependency)
const app = new Elysia()
  .get('/', () => 'Build Worker is running')
  .get('/health', () => ({ status: 'healthy', timestamp: new Date().toISOString() }))
  .post('/build', async ({ body }) => {
    const job = body as any;
    console.log(`[Build] Received request for ${job.build_id}`);
    try {
      // Run build asynchronously (don't block the response)
      Builder.execute(job).catch((err) => {
        console.error(`[Build] ${job.build_id} failed:`, err);
      });
      return { success: true, message: 'Build started', build_id: job.build_id };
    } catch (error: any) {
      console.error(`[Build] Failed to start:`, error);
      return { success: false, error: error.message };
    }
  })
  .listen(4001);

console.log(`👷 Build Worker is running at ${app.server?.hostname}:${app.server?.port}`);

const gracefulShutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down...`);
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
