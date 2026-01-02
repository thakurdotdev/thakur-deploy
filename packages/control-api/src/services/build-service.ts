import { db } from '../db';
import { builds } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { DeploymentService } from './deployment-service';
import { AppType } from '../config/framework-config';

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000, // 1 second
  timeoutMs: 10000, // 10 seconds
};

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Trigger build with exponential backoff retry
 */
async function triggerBuildWithRetry(
  buildWorkerUrl: string,
  buildJob: object,
  buildId: string,
): Promise<{ success: boolean; error?: string }> {
  let lastError: string = '';

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      console.log(
        `[BuildService] Triggering build ${buildId} (attempt ${attempt}/${RETRY_CONFIG.maxRetries})`,
      );

      const res = await fetchWithTimeout(
        `${buildWorkerUrl}/build`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildJob),
        },
        RETRY_CONFIG.timeoutMs,
      );

      if (res.ok) {
        console.log(`[BuildService] Build ${buildId} triggered successfully`);
        return { success: true };
      }

      // Non-retryable errors (4xx client errors)
      if (res.status >= 400 && res.status < 500) {
        const errorText = await res.text();
        console.error(
          `[BuildService] Build ${buildId} failed with client error: ${res.status} - ${errorText}`,
        );
        return { success: false, error: `Client error: ${res.status}` };
      }

      // Server error - will retry
      lastError = `HTTP ${res.status}: ${res.statusText}`;
      console.warn(`[BuildService] Build ${buildId} attempt ${attempt} failed: ${lastError}`);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        lastError = 'Request timeout';
      } else {
        lastError = err.message || 'Unknown error';
      }
      console.warn(`[BuildService] Build ${buildId} attempt ${attempt} failed: ${lastError}`);
    }

    // Exponential backoff before retry (skip on last attempt)
    if (attempt < RETRY_CONFIG.maxRetries) {
      const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1);
      console.log(`[BuildService] Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  console.error(
    `[BuildService] Build ${buildId} failed after ${RETRY_CONFIG.maxRetries} attempts: ${lastError}`,
  );
  return { success: false, error: lastError };
}

export const BuildService = {
  async create(data: {
    project_id: string;
    status: 'pending' | 'building' | 'success' | 'failed';
    commit_sha?: string;
    commit_message?: string | null;
  }) {
    const result = await db
      .insert(builds)
      .values({
        project_id: data.project_id,
        status: data.status,
        commit_sha: data.commit_sha,
        commit_message: data.commit_message,
      })
      .returning();
    const build = result[0];

    if (data.status === 'pending') {
      const { ProjectService } = await import('./project-service');
      const { EnvService } = await import('./env-service');

      const project = await ProjectService.getById(data.project_id);
      if (project) {
        const envVarsList = await EnvService.getAll(project.id);
        const envVars = envVarsList.reduce(
          (acc, curr) => ({ ...acc, [curr.key]: curr.value }),
          {} as Record<string, string>,
        );

        const buildJob = {
          build_id: build.id,
          project_id: project.id,
          github_url: project.github_url,
          build_command: project.build_command,
          root_directory: project.root_directory || './',
          app_type: project.app_type as AppType,
          env_vars: envVars,
          installation_id: project.github_installation_id || undefined,
        };

        const buildWorkerUrl = process.env.BUILD_WORKER_URL || 'http://localhost:4001';

        // Trigger build with retry logic
        const result = await triggerBuildWithRetry(buildWorkerUrl, buildJob, build.id);

        // If all retries failed, mark build as failed
        if (!result.success) {
          await db
            .update(builds)
            .set({
              status: 'failed',
              logs: `Build trigger failed: ${result.error}`,
              completed_at: new Date(),
            })
            .where(eq(builds.id, build.id));

          console.error(`[BuildService] Build ${build.id} marked as failed due to trigger failure`);
        }
      }
    }

    return build;
  },

  async getByProjectId(projectId: string) {
    return await db
      .select()
      .from(builds)
      .where(eq(builds.project_id, projectId))
      .orderBy(desc(builds.created_at));
  },

  async getById(id: string) {
    const result = await db.select().from(builds).where(eq(builds.id, id));
    return result[0] || null;
  },

  async updateStatus(
    id: string,
    status: 'pending' | 'building' | 'success' | 'failed',
    logs?: string,
    artifactId?: string,
  ) {
    const data: any = { status, updated_at: new Date() };
    if (logs) data.logs = logs;
    if (artifactId) data.artifact_id = artifactId;
    if (status === 'success' || status === 'failed') {
      data.completed_at = new Date();
    }

    const [updated] = await db
      .update(builds)
      .set({
        ...data,
        status: status,
        completed_at: status === 'success' || status === 'failed' ? new Date() : null,
      })
      .where(eq(builds.id, id))
      .returning();

    // Auto-activate on successful builds
    if (status === 'success' && updated) {
      console.log(
        `[BuildService] Auto-activating successful build ${id} for project ${updated.project_id}`,
      );
      try {
        await DeploymentService.activateBuild(updated.project_id, id);
        console.log(`[BuildService] Deployment activated successfully`);
      } catch (e) {
        console.error(`[BuildService] Auto-activation failed:`, e);
      }
    }

    return updated || null;
  },
};
