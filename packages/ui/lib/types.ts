import { AppType } from './framework-config';

export interface Project {
  id: string;
  name: string;
  github_url: string;
  root_directory: string | null;
  build_command: string;
  app_type: AppType;
  domain: string | null;
  github_repo_id: string | null;
  github_repo_full_name: string | null;
  github_branch: string | null;
  github_installation_id: string | null;
  auto_deploy: boolean;
  created_at: string;
  updated_at: string;
}

export interface Build {
  id: string;
  project_id: string;
  status: 'pending' | 'building' | 'success' | 'failed';
  logs: string | null;
  artifact_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Deployment {
  id: string;
  project_id: string;
  build_id: string;
  status: 'active' | 'inactive';
  activated_at: string;
}

export interface EnvVar {
  id: string;
  project_id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

// Structured log types
export type LogLevel = 'info' | 'warning' | 'error' | 'success' | 'deploy';

export interface LogEntry {
  id: string;
  build_id: string;
  level: LogLevel;
  message: string;
  timestamp: string;
}
