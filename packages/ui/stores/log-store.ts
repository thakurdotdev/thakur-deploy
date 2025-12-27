import { create } from 'zustand';
import { LogEntry, LogLevel } from '@/lib/types';

interface LogStore {
  logs: Record<string, LogEntry[]>;
  appendLog: (buildId: string, message: string, level: LogLevel) => void;
  setLogs: (buildId: string, entries: LogEntry[]) => void;
  clearLogs: (buildId: string) => void;
}

export const useLogStore = create<LogStore>((set) => ({
  logs: {},
  appendLog: (buildId, message, level) =>
    set((state) => ({
      logs: {
        ...state.logs,
        [buildId]: [
          ...(state.logs[buildId] || []),
          {
            id: `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            build_id: buildId,
            level,
            message,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    })),
  setLogs: (buildId, entries) =>
    set((state) => ({
      logs: {
        ...state.logs,
        [buildId]: entries,
      },
    })),
  clearLogs: (buildId) =>
    set((state) => {
      const newLogs = { ...state.logs };
      delete newLogs[buildId];
      return { logs: newLogs };
    }),
}));
