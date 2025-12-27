import { Elysia, t } from 'elysia';
import { BuildService } from '../services/build-service';
import { ProjectService } from '../services/project-service';
import { JobQueue } from '../queue';
import { LogService } from '../services/log-service';
import { WebSocketService } from '../ws';
import { db } from '../db';
import { deployments, LogLevel } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { DeploymentService } from '../services/deployment-service';

export const buildsRoutes = new Elysia()
  .group('/projects/:id/builds', (app) =>
    app
      .post('/', async ({ params: { id }, set }) => {
        const project = await ProjectService.getById(id);
        if (!project) {
          set.status = 404;
          return { error: 'Project not found' };
        }

        const build = await BuildService.create({
          project_id: id,
          status: 'pending',
        });

        return build;
      })
      .get('/', async ({ params: { id } }) => {
        return await BuildService.getByProjectId(id);
      }),
  )
  .group('/builds', (app) =>
    app
      .get('/:id', async ({ params: { id }, set }) => {
        const build = await BuildService.getById(id);
        if (!build) {
          set.status = 404;
          return { error: 'Build not found' };
        }
        return build;
      })
      .get('/:id/logs', async ({ params: { id } }) => {
        return await LogService.getLogs(id);
      })
      .delete('/:id/logs', async ({ params: { id } }) => {
        await LogService.clearLogs(id);
        return { success: true, message: 'Logs cleared' };
      }),
  );

export const internalBuildRoutes = new Elysia().group('/builds', (app) =>
  app
    .post('/:id/logs', async ({ params: { id }, body }) => {
      const { logs, level } = body as { logs: string; level?: LogLevel };
      await LogService.persist(id, logs, level || 'info');
      WebSocketService.broadcast(id, logs, level || 'info');
      return { success: true };
    })
    .put('/:id', async ({ params: { id }, body }) => {
      const { status } = body as { status: string };
      const updated = await BuildService.updateStatus(id, status as any);

      if (updated) {
        WebSocketService.broadcastBuildUpdate(updated.project_id, updated);

        // Auto-Deploy logic is now handled in BuildService.updateStatus()
        // Removed duplicate activation here to prevent double deployments
      }
      return updated;
    })
    // Admin endpoint to clear all jobs from queue
    .delete('/queue', async () => {
      await JobQueue.clearAllJobs();
      return { success: true, message: 'All jobs cleared from queue' };
    }),
);
