import { Worker, Job } from 'bullmq';
import { getRedisConnection, QUEUE_CONFIG } from './config';
import { Builder } from '../services/builder';
import { AppType } from '../config/framework-config';

/**
 * Build job data structure (must match control-api's BuildJobData)
 */
export interface BuildJobData {
  build_id: string;
  project_id: string;
  github_url: string;
  build_command: string;
  root_directory: string;
  app_type: AppType;
  env_vars: Record<string, string>;
  installation_id?: string;
}

// Singleton worker instance
let buildWorker: Worker<BuildJobData> | null = null;

/**
 * Build Worker Service
 * Processes build jobs from BullMQ queue
 */
export const BuildWorker = {
  /**
   * Initialize and start the worker
   */
  async initialize(): Promise<void> {
    if (buildWorker) {
      console.log('[BuildWorker] Already initialized');
      return;
    }

    const connection = getRedisConnection();

    buildWorker = new Worker<BuildJobData>(
      QUEUE_CONFIG.name,
      async (job: Job<BuildJobData>) => {
        console.log(`[BuildWorker] Processing job ${job.id} for build ${job.data.build_id}`);

        try {
          // Execute the build using existing Builder
          await Builder.execute(job.data);

          console.log(`[BuildWorker] Job ${job.id} completed successfully`);
          return { success: true };
        } catch (error: any) {
          console.error(`[BuildWorker] Job ${job.id} failed:`, error.message);
          throw error; // Re-throw to mark job as failed
        }
      },
      {
        connection,
        concurrency: QUEUE_CONFIG.worker.concurrency,
        // Stalled job handling
        stalledInterval: 30000, // Check for stalled jobs every 30s
        maxStalledCount: 1, // Move to failed after 1 stall
      },
    );

    // Event listeners for logging
    buildWorker.on('completed', (job) => {
      console.log(`[BuildWorker] ✅ Job ${job.id} completed`);
    });

    buildWorker.on('failed', (job, error) => {
      console.error(`[BuildWorker] ❌ Job ${job?.id} failed:`, error.message);
    });

    buildWorker.on('active', (job) => {
      console.log(`[BuildWorker] 🚀 Job ${job.id} is now active`);
    });

    buildWorker.on('stalled', (jobId) => {
      console.warn(`[BuildWorker] ⚠️ Job ${jobId} stalled`);
    });

    buildWorker.on('error', (error) => {
      console.error('[BuildWorker] Worker error:', error);
    });

    console.log('[BuildWorker] Initialized and listening for jobs');
  },

  /**
   * Graceful shutdown - wait for current job to complete
   */
  async shutdown(): Promise<void> {
    if (!buildWorker) {
      console.log('[BuildWorker] Not running');
      return;
    }

    console.log('[BuildWorker] Shutting down gracefully...');

    // Close worker (waits for current job to complete)
    await buildWorker.close();
    buildWorker = null;

    console.log('[BuildWorker] Shutdown complete');
  },

  /**
   * Force close - don't wait for current job
   */
  async forceClose(): Promise<void> {
    if (!buildWorker) return;

    console.log('[BuildWorker] Force closing...');
    await buildWorker.close(true);
    buildWorker = null;
  },

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return buildWorker !== null && !buildWorker.closing;
  },

  /**
   * Get worker instance (for testing/debugging)
   */
  getWorker(): Worker<BuildJobData> | null {
    return buildWorker;
  },
};
