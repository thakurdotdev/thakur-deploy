import { LogLevel } from '@/lib/types';

// Log level styling configuration
export const logLevelConfig: Record<LogLevel, { bg: string; text: string }> = {
  info: { bg: '', text: 'text-zinc-300' },
  warning: { bg: 'bg-amber-950/30', text: 'text-amber-300' },
  error: { bg: 'bg-red-950/50', text: 'text-red-400' },
  success: { bg: '', text: 'text-emerald-400' },
  deploy: { bg: '', text: '' },
};

export function getLogLineStyle(level: LogLevel, isHighlighted: boolean): string {
  if (isHighlighted) {
    return 'bg-yellow-500/30 text-white';
  }
  const config = logLevelConfig[level];
  return `${config.bg} ${config.text}`;
}
