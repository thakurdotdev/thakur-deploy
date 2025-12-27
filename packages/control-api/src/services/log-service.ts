import { db } from '../db';
import { buildLogs, LogLevel } from '../db/schema';
import { eq, asc } from 'drizzle-orm';

export interface LogEntry {
  id: string;
  build_id: string;
  level: LogLevel;
  message: string;
  timestamp: Date;
}

export const LogService = {
  /**
   * Persist a structured log entry to the database
   */
  async persist(buildId: string, message: string, level: LogLevel = 'info') {
    await db.insert(buildLogs).values({
      build_id: buildId,
      level,
      message,
    });
  },

  /**
   * Get all logs for a build, ordered by timestamp
   */
  async getLogs(buildId: string): Promise<LogEntry[]> {
    const logs = await db
      .select()
      .from(buildLogs)
      .where(eq(buildLogs.build_id, buildId))
      .orderBy(asc(buildLogs.timestamp));

    return logs.map((log) => ({
      id: log.id,
      build_id: log.build_id,
      level: log.level as LogLevel,
      message: log.message,
      timestamp: log.timestamp,
    }));
  },

  /**
   * Clear all logs for a build
   */
  async clearLogs(buildId: string) {
    await db.delete(buildLogs).where(eq(buildLogs.build_id, buildId));
  },

  /**
   * Get logs as plain text (for backward compatibility)
   */
  async getLogsAsText(buildId: string): Promise<string> {
    const logs = await this.getLogs(buildId);
    return logs.map((log) => log.message).join('');
  },
};
