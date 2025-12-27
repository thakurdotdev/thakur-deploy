import * as tar from 'tar';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { unlink } from 'fs/promises';
import { AppType, getExistingArtifactPaths, isBackendFramework } from '../config/framework-config';

export const ArtifactService = {
  /**
   * Creates a compressed tarball of the build output and streams it to the deploy engine.
   * For backend apps: packages everything except node_modules.
   * For frontend apps: packages specific build output directories.
   */
  async streamArtifact(buildId: string, projectDir: string, appType: AppType) {
    const deployEngineUrl = process.env.DEPLOY_ENGINE_URL || 'http://localhost:4002';
    const tempArtifactPath = join(process.cwd(), `temp-${buildId}.tar.gz`);

    let validPaths: string[];

    if (isBackendFramework(appType)) {
      // For backend: include everything except node_modules
      validPaths = readdirSync(projectDir).filter((f) => f !== 'node_modules' && f !== '.git');
      console.log(`[ArtifactService] Backend app - packaging all files except node_modules`);
    } else {
      // For frontend: use selective paths from config
      validPaths = getExistingArtifactPaths(appType, projectDir);
    }

    if (validPaths.length === 0) {
      throw new Error('No build output found to package');
    }

    try {
      console.log(`[ArtifactService] Creating tarball with paths: ${validPaths.join(', ')}`);

      await tar.create(
        {
          gzip: true,
          file: tempArtifactPath,
          cwd: projectDir,
        },
        validPaths,
      );

      console.log(`[ArtifactService] Uploading artifact to ${deployEngineUrl}`);

      const file = Bun.file(tempArtifactPath);

      const response = await fetch(`${deployEngineUrl}/artifacts/upload?buildId=${buildId}`, {
        method: 'POST',
        body: file,
      });

      if (!response.ok) {
        throw new Error(`Failed to upload artifact: ${response.statusText}`);
      }

      console.log(`[ArtifactService] Upload completed successfully`);
    } catch (e) {
      console.error(`[ArtifactService] Upload failed`, e);
      throw e;
    } finally {
      if (existsSync(tempArtifactPath)) {
        await unlink(tempArtifactPath);
      }
    }

    return true;
  },
};
