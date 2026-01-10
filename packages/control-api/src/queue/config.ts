/**
 * Queue configuration for build jobs
 */
export const QUEUE_CONFIG = {
  name: 'build-queue',

  // Redis connection options (parsed from REDIS_URL)
  connection: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // Default job options
  defaultJobOptions: {
    attempts: 3, // Retry failed jobs up to 3 times
    backoff: {
      type: 'exponential' as const,
      delay: 5000, // Start with 5 second delay
    },
    removeOnComplete: {
      count: 100, // Keep last 100 completed jobs
    },
    removeOnFail: {
      count: 50, // Keep last 50 failed jobs
    },
  },

  // Worker settings
  worker: {
    concurrency: 1, // Process one build at a time to protect server
  },
};
