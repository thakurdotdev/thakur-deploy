import { Elysia, t } from 'elysia';
import { GitHubService } from '../services/github-service';
import { db } from '../db';
import { githubInstallations, projects } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { BuildService } from '../services/build-service';

export const githubWebhook = new Elysia().post(
  '/github/webhook',
  async ({ request, body, set }) => {
    const signature = request.headers.get('x-hub-signature-256');
    const event = request.headers.get('x-github-event');

    if (!signature) {
      set.status = 401;
      return 'Missing signature';
    }

    // 1. Verify Signature

    const rawBody = await request.text();
    const verified = GitHubService.verifyWebhookSignature(rawBody, signature);

    if (!verified) {
      set.status = 401;
      return 'Invalid signature';
    }

    const payload = JSON.parse(rawBody);

    console.log(`[GitHub Webhook] Received event: ${event}`);

    try {
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
                // update others if needed
              },
            });
          console.log(`[GitHub Webhook] Installation registered: ${installation.id}`);
        } else if (action === 'deleted') {
          await db
            .delete(githubInstallations)
            .where(eq(githubInstallations.github_installation_id, installation.id.toString()));
          // Disconnect projects associated with this installation
          await db
            .update(projects)
            .set({ github_installation_id: null })
            .where(eq(projects.github_installation_id, installation.id.toString()));

          console.log(`[GitHub Webhook] Installation deleted: ${installation.id}`);
        }
      } else if (event === 'push') {
        // Handle Push
        const ref = payload.ref; // 'refs/heads/main'
        const repo = payload.repository;
        const branch = ref.replace('refs/heads/', '');
        const installationId = payload.installation?.id.toString();

        if (!installationId) {
          console.log('[GitHub Webhook] Push event missing installation ID');
          return 'No installation ID';
        }

        // Find projects connected to this repository AND matches branch (if we enforce branch?)
        // Find projects connected to this repository AND matches branch
        const repoId = repo.id.toString();

        const connectedProjects = await db
          .select()
          .from(projects)
          .where(and(eq(projects.github_repo_id, repoId), eq(projects.github_branch, branch)));

        if (connectedProjects.length === 0) {
          console.log(
            `[GitHub Webhook] No projects found for ${repo.full_name} on branch ${branch}`,
          );
          return 'No connected projects';
        }

        console.log(`[GitHub Webhook] triggering builds for ${connectedProjects.length} projects`);

        for (const project of connectedProjects) {
          if (!project.auto_deploy) {
            console.log(
              `[GitHub Webhook] Skipping auto-deploy for project ${project.name} (disabled)`,
            );
            continue;
          }

          await BuildService.create({
            project_id: project.id,
            status: 'pending',
          });
          console.log(`[GitHub Webhook] Build created for project ${project.id}`);
        }
      }
    } catch (e) {
      console.error('[GitHub Webhook] Error processing event', e);
      set.status = 500;
      return 'Internal Error';
    }

    return 'Processed';
  },
);
