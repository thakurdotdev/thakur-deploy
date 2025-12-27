import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { deployments, projects } from '../db/schema';
import { EnvService } from './env-service';

export const DeploymentService = {
  async activateBuild(projectId: string, buildId: string) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) throw new Error('Project not found');
    // Ensure we don't proceed if port is missing
    if (!project.port) throw new Error('Project has no assigned port');

    // Fetch and decrypt environment variables for this project
    const envVarsObject = await EnvService.getAsRecord(projectId);

    console.log(
      `[DeploymentService] STARTING activation for ${project.name} (Build: ${buildId}) on Port: ${project.port}`,
    );
    console.log(`[DeploymentService] Passing ${Object.keys(envVarsObject).length} env vars`);

    // Call Deploy Engine
    const deployEngineUrl = process.env.DEPLOY_ENGINE_URL || 'http://localhost:4002';
    console.log(`[DeploymentService] Requesting activation for build ${buildId}...`);

    const res = await fetch(`${deployEngineUrl}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        buildId: buildId,
        port: project.port,
        appType: project.app_type,
        subdomain:
          project.domain?.split('.')[0] ||
          project.name
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/^-+|-+$/g, ''), // Slugify
        envVars: envVarsObject, // Pass env vars to deploy engine
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Deploy Engine activation failed: ${err}`);
    }

    // Update DB
    await db.transaction(async (tx) => {
      // Mark all current active deployments for this project as inactive
      await tx
        .update(deployments)
        .set({ status: 'inactive' })
        .where(and(eq(deployments.project_id, projectId), eq(deployments.status, 'active')));

      // Create new active deployment record
      await tx.insert(deployments).values({
        project_id: projectId,
        build_id: buildId,
        status: 'active',
      });
    });

    return true;
  },

  async stop(projectId: string) {
    const activeDeployment = await db.query.deployments.findFirst({
      where: and(eq(deployments.project_id, projectId), eq(deployments.status, 'active')),
    });

    if (!activeDeployment) {
      throw new Error('No active deployment found');
    }

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project || !project.port) {
      throw new Error('Project or port not found');
    }

    // Call Deploy Engine
    const deployEngineUrl = process.env.DEPLOY_ENGINE_URL || 'http://localhost:4002';
    console.log(
      `[DeploymentService] Stopping deployment for project ${projectId} on port ${project.port}...`,
    );

    const res = await fetch(`${deployEngineUrl}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: project.port,
        projectId,
        buildId: activeDeployment.build_id,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Deploy Engine stop failed: ${err}`);
    }

    // Update DB status
    await db
      .update(deployments)
      .set({ status: 'inactive' })
      .where(eq(deployments.id, activeDeployment.id));

    return true;
  },
};
