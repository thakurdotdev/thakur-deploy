export type LogLevel = 'info' | 'warning' | 'error' | 'success' | 'deploy';

/**
 * Streams deployment logs to the control-api for persistence and WebSocket broadcast.
 * Uses the same endpoint as build-worker, so logs appear in the same build log stream.
 */
export const LogService = {
  async stream(buildId: string, message: string, level: LogLevel = 'deploy') {
    const controlApiUrl = process.env.CONTROL_API_URL || 'http://localhost:4000';

    try {
      await fetch(`${controlApiUrl}/builds/${buildId}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: `[Deploy] ${message}\n`, level }),
      });
    } catch (error) {
      console.error('[LogService] Failed to stream deploy log:', error);
    }
  },
};
