import { Elysia } from 'elysia';
import { randomUUID } from 'crypto';
import { GitHubService } from '../services/github-service';
import { db } from '../db';
import { githubInstallations, projects, builds } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { BuildService } from '../services/build-service';

// Generate a unique request ID for log tracing
function generateRequestId(): string {
  return randomUUID().slice(0, 8);
}

export const githubWebhook = new Elysia()
  // Capture raw body BEFORE Elysia parses it (required for webhook signature verification)
  .derive(async ({ request }) => {
    const clonedRequest = request.clone();
    const rawBody = await clonedRequest.text();
    const requestId = generateRequestId();
    return { rawBody, requestId };
  })
  .post('/github/webhook', async ({ request, rawBody, requestId, set }) => {
    const signature = request.headers.get('x-hub-signature-256');
    const event = request.headers.get('x-github-event');
    const deliveryId = request.headers.get('x-github-delivery') || 'unknown';

    const log = (level: 'info' | 'warn' | 'error', message: string, data?: object) => {
      const prefix = `[Webhook:${requestId}]`;
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      if (level === 'error') {
        console.error(`${prefix} ${message}${dataStr}`);
      } else if (level === 'warn') {
        console.warn(`${prefix} ${message}${dataStr}`);
      } else {
        console.log(`${prefix} ${message}${dataStr}`);
      }
    };

    log('info', `Received ${event} event`, { deliveryId });

    // 1. Validate signature header
    if (!signature) {
      log('warn', 'Missing signature header');
      set.status = 401;
      return { error: 'Missing signature' };
    }

    // 2. Verify webhook signature
    try {
      const verified = GitHubService.verifyWebhookSignature(rawBody, signature);
      if (!verified) {
        log('warn', 'Signature verification failed');
        set.status = 401;
        return { error: 'Invalid signature' };
      }
    } catch (e) {
      log('error', 'Signature verification error', { error: String(e) });
      set.status = 500;
      return { error: 'Signature verification failed' };
    }

    // 3. Parse payload
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      log('error', 'Failed to parse webhook payload');
      set.status = 400;
      return { error: 'Invalid JSON payload' };
    }

    try {
      // =====================
      // INSTALLATION EVENTS
      // =====================
      if (event === 'installation') {
        const action = payload.action;
        const installation = payload.installation;

        if (action === 'created') {
          await db
            .insert(githubInstallations)
            .values({
              github_installation_id: installation.id.toString(),
              account_login: installation.account.login,
              account_id: installation.account.id.toString(),
              account_type: installation.account.type,
            })
            .onConflictDoUpdate({
              target: githubInstallations.github_installation_id,
              set: {
                account_login: installation.account.login,
              },
            });
          log('info', `Installation registered: ${installation.id}`);
        } else if (action === 'deleted') {
          await db
            .delete(githubInstallations)
            .where(eq(githubInstallations.github_installation_id, installation.id.toString()));

          await db
            .update(projects)
            .set({ github_installation_id: null })
            .where(eq(projects.github_installation_id, installation.id.toString()));

          log('info', `Installation deleted: ${installation.id}`);
        }

        return { processed: true, event: 'installation', action };
      }

      // =====================
      // PUSH EVENTS
      // =====================
      if (event === 'push') {
        const ref = payload.ref; // 'refs/heads/main'
        const repo = payload.repository;
        const branch = ref.replace('refs/heads/', '');
        const installationId = payload.installation?.id?.toString();
        const commitSha = payload.after; // The commit SHA after the push
        const commitMessage = payload.head_commit?.message?.slice(0, 255) || null; // Store full message (up to 255 chars)

        log('info', `Push to ${repo.full_name}:${branch}`, {
          commit: commitSha?.slice(0, 7),
          message: commitMessage,
        });

        if (!installationId) {
          log('warn', 'Push event missing installation ID');
          return { processed: false, reason: 'No installation ID' };
        }

        // Find connected projects
        const repoId = repo.id.toString();
        const connectedProjects = await db
          .select()
          .from(projects)
          .where(and(eq(projects.github_repo_id, repoId), eq(projects.github_branch, branch)));

        if (connectedProjects.length === 0) {
          log('info', `No projects found for ${repo.full_name}:${branch}`);
          return { processed: true, builds_triggered: 0 };
        }

        log('info', `Found ${connectedProjects.length} connected project(s)`);

        let buildsTriggered = 0;
        let buildsSkipped = 0;

        for (const project of connectedProjects) {
          // Check auto_deploy setting
          if (!project.auto_deploy) {
            log('info', `Skipping project ${project.name} (auto_deploy disabled)`);
            buildsSkipped++;
            continue;
          }

          // Idempotency check: prevent duplicate builds for same commit
          if (commitSha) {
            const existingBuild = await db
              .select()
              .from(builds)
              .where(and(eq(builds.project_id, project.id), eq(builds.commit_sha, commitSha)))
              .limit(1);

            if (existingBuild.length > 0) {
              log(
                'info',
                `Skipping duplicate build for commit ${commitSha.slice(0, 7)} on project ${project.name}`,
              );
              buildsSkipped++;
              continue;
            }
          }

          // Create build with commit SHA and message for tracking
          try {
            await BuildService.create({
              project_id: project.id,
              status: 'pending',
              commit_sha: commitSha,
              commit_message: commitMessage,
            });
            log('info', `Build queued for project ${project.name}`, { project_id: project.id });
            buildsTriggered++;
          } catch (e) {
            log('error', `Failed to create build for project ${project.name}`, {
              error: String(e),
            });
          }
        }

        return {
          processed: true,
          builds_triggered: buildsTriggered,
          builds_skipped: buildsSkipped,
        };
      }

      // =====================
      // OTHER EVENTS
      // =====================
      log('info', `Ignoring unhandled event: ${event}`);
      return { processed: true, event, ignored: true };
    } catch (e) {
      log('error', 'Error processing webhook', { error: String(e) });
      set.status = 500;
      return { error: 'Internal processing error' };
    }
  });
