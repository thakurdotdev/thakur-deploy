import { existsSync, mkdirSync } from 'fs';
import { rm, unlink } from 'fs/promises';
import { join } from 'path';
import {
  AppType,
  FRAMEWORKS,
  getBackendStartCommand,
  isBackendFramework,
  shouldUseStaticServer,
} from '../config/framework-config';
import { LogService } from './log-service';
import { NginxService } from './nginx-service';

const BASE_DIR = process.env.BASE_DIR || join(process.cwd(), 'apps');
const ARTIFACTS_DIR = join(BASE_DIR, 'artifacts');
const IS_PLATFORM_PROD = process.env.PLATFORM_ENV === 'production';

// Ensure base dirs exist
if (!existsSync(ARTIFACTS_DIR)) {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

// Bounded retry with wall-clock timeout
async function retry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; timeoutMs?: number; name?: string } = {},
): Promise<T> {
  const { retries = 3, delayMs = 300, timeoutMs = 5000, name = 'operation' } = opts;

  const start = Date.now();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${name} timed out after ${timeoutMs}ms`);
    }

    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw lastErr;
}

export const DeployService = {
  async receiveArtifact(buildId: string, stream: ReadableStream<any>) {
    const path = join(ARTIFACTS_DIR, `${buildId}.tar.gz`);
    const buf = await new Response(stream).arrayBuffer();
    await Bun.write(path, buf);
    return { success: true, path };
  },

  serveRequest() {
    return new Response('Deploy Engine Running', { status: 200 });
  },

  async activateDeployment(
    projectId: string,
    buildId: string,
    port: number,
    appType: AppType,
    subdomain: string,
    envVars: Record<string, string> = {},
  ) {
    const paths = this.getPaths(projectId, buildId);

    if (!existsSync(paths.artifact)) {
      throw new Error(`Artifact not found: ${paths.artifact}`);
    }

    await LogService.stream(buildId, 'Starting deployment...');

    mkdirSync(paths.extractDir, { recursive: true });

    await LogService.stream(buildId, 'Extracting artifact...');
    await retry(() => this.extractArtifact(paths.artifact, paths.extractDir), {
      name: 'artifact extraction',
      timeoutMs: 8000,
    });

    // internal log only - don't expose symlink details to user
    await retry(() => this.updateSymlink(paths.projectDir, paths.extractDir, buildId), {
      name: 'symlink update',
    });

    await this.killProjectProcess(projectId, port);

    await LogService.stream(buildId, `Starting ${appType} application...`);
    await this.startApplication(
      paths.extractDir,
      port,
      appType,
      paths.projectDir,
      buildId,
      envVars,
    );

    if (IS_PLATFORM_PROD) {
      await LogService.stream(buildId, `Configuring domain...`);
      await retry(() => NginxService.createConfig(subdomain, port), {
        name: `nginx config ${subdomain}`,
        timeoutMs: 6000,
      });
    }

    await LogService.stream(buildId, '✅ Deployment successful!');
    return { success: true };
  },

  async stopDeployment(port: number, projectId?: string, buildId?: string) {
    if (buildId) await LogService.stream(buildId, 'Stopping deployment...');

    if (projectId) {
      await this.killProjectProcess(projectId, port);
    } else {
      await this.ensurePortFree(port);
    }

    if (buildId) await LogService.stream(buildId, '✅ Deployment stopped successfully!');
    return { success: true };
  },

  async deleteProject(projectId: string, port?: number, subdomain?: string, buildIds?: string[]) {
    if (port) {
      await this.killProjectProcess(projectId, port);
    }

    const projectDir = join(BASE_DIR, projectId);
    if (existsSync(projectDir)) {
      await rm(projectDir, { recursive: true, force: true });
    }

    if (buildIds) {
      for (const id of buildIds) {
        const p = join(ARTIFACTS_DIR, `${id}.tar.gz`);
        if (existsSync(p)) await unlink(p).catch(() => {});
      }
    }

    if (IS_PLATFORM_PROD && subdomain) {
      await retry(() => NginxService.removeConfig(subdomain), {
        name: `nginx cleanup ${subdomain}`,
      });
    }

    return { success: true };
  },

  // -------- helpers --------

  getPaths(projectId: string, buildId: string) {
    const projectDir = join(BASE_DIR, projectId);
    return {
      artifact: join(ARTIFACTS_DIR, `${buildId}.tar.gz`),
      projectDir,
      extractDir: join(projectDir, 'builds', buildId, 'extracted'),
    };
  },

  async extractArtifact(artifact: string, target: string) {
    const p = Bun.spawn(['tar', '-xzf', artifact, '-C', target]);
    await p.exited;
    if (p.exitCode !== 0) throw new Error('tar failed');
  },

  async updateSymlink(projectDir: string, target: string, buildId: string) {
    const current = join(projectDir, 'current');
    const temp = join(projectDir, `.current_tmp_${Date.now()}`);
    const idFile = join(projectDir, 'current_build_id');

    await Bun.write(idFile, buildId);
    await Bun.spawn(['ln', '-sf', target, temp]).exited;
    await Bun.spawn(['mv', '-Tf', temp, current]).exited;
  },

  async killProjectProcess(projectId: string, port: number) {
    const pidFile = join(BASE_DIR, projectId, 'server.pid');

    if (existsSync(pidFile)) {
      let pid: number | undefined;
      try {
        pid = parseInt(await Bun.file(pidFile).text(), 10);
        if (!isNaN(pid)) {
          // Try graceful shutdown first
          try {
            process.kill(pid, 'SIGTERM');
            await new Promise((r) => setTimeout(r, 300));
          } catch {
            // Process might already be dead, that's fine
          }

          // Check if still running, if so force kill
          try {
            process.kill(pid, 0); // Test if process exists
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process already dead, that's fine
          }
        }
      } catch (e) {
        // Failed to read pid file or parse, just continue
        console.log(`[DeployService] Could not read/parse pid file, continuing...`);
      }
      await unlink(pidFile).catch(() => {});
    }

    await this.ensurePortFree(port);
  },

  async ensurePortFree(port: number) {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      try {
        await fetch(`http://localhost:${port}`);
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        return;
      }
    }

    throw new Error(`Port ${port} did not free in time`);
  },

  async startApplication(
    cwd: string,
    port: number,
    appType: AppType,
    projectDir: string,
    buildId?: string,
    envVars: Record<string, string> = {},
  ) {
    const framework = FRAMEWORKS[appType];
    const useStaticServer = shouldUseStaticServer(appType, cwd);

    let startCmd: string[];
    let workingDir: string;

    if (useStaticServer) {
      if (buildId) await LogService.stream(buildId, 'Using static file server...');
      const serverScript = join(process.cwd(), 'src', 'static-server.ts');
      const distDir = join(cwd, appType === 'nextjs' ? 'out' : 'dist');
      startCmd = ['bun', 'run', serverScript, distDir, port.toString()];
      workingDir = process.cwd();
    } else {
      if (framework.requiresInstall) {
        if (buildId) await LogService.stream(buildId, 'Installing dependencies...');
        await this.ensureDependenciesInstalled(cwd);
        if (buildId) await LogService.stream(buildId, 'Dependencies installed!');
      }
      startCmd = isBackendFramework(appType)
        ? getBackendStartCommand(cwd)
        : framework.startCommand(port, cwd);
      workingDir = cwd;
    }

    console.log(`[DeployService] Starting app with command: ${startCmd.join(' ')}`);
    console.log(`[DeployService] Working directory: ${workingDir}`);
    console.log(`[DeployService] PORT env var will be set to: ${port}`);
    console.log(
      `[DeployService] Passing ${Object.keys(envVars).length} project env vars:`,
      Object.keys(envVars),
    );
    if (buildId) await LogService.stream(buildId, `Starting application server...`);

    const appProc = Bun.spawn(startCmd, {
      cwd: workingDir,
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
      env: {
        ...process.env,
        ...envVars, // Inject project-specific env vars
        NODE_ENV: 'production',
        PLATFORM_ENV: 'production',
        PORT: port.toString(),
      },
    });

    // Log app output for debugging
    const logAppOutput = async (stream: ReadableStream<Uint8Array> | null, label: string) => {
      if (!stream) return;
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          console.log(`[App ${label}]`, text);
          if (buildId) await LogService.stream(buildId, text);
        }
      } catch {
        // Stream closed, that's fine
      }
    };

    // Start logging app output in background (don't await)
    logAppOutput(appProc.stdout, 'stdout');
    logAppOutput(appProc.stderr, 'stderr');

    const pidFile = join(projectDir, 'server.pid');
    await Bun.write(pidFile, appProc.pid.toString());
    appProc.unref();

    if (buildId)
      await LogService.stream(buildId, `Application started, performing health check...`);

    try {
      await this.performHealthCheck(port);
      console.log(`[DeployService] Health check completed successfully for port ${port}`);
      if (buildId) await LogService.stream(buildId, `Health check passed!`);
    } catch (e) {
      console.error(`[DeployService] Health check failed for port ${port}:`, e);
      if (buildId) await LogService.stream(buildId, `❌ Health check failed: ${e}`);
      throw e;
    }
  },

  async ensureDependenciesInstalled(cwd: string) {
    const nodeModulesPath = join(cwd, 'node_modules');
    const packageJsonPath = join(cwd, 'package.json');

    console.log(`[DeployService] ensureDependenciesInstalled called with cwd: ${cwd}`);
    console.log(`[DeployService] Checking for package.json at: ${packageJsonPath}`);
    console.log(`[DeployService] package.json exists: ${existsSync(packageJsonPath)}`);

    // Check if package.json exists
    if (!existsSync(packageJsonPath)) {
      console.log(`[DeployService] No package.json found, skipping install`);
      return;
    }

    // Always run install for fresh deployments
    console.log(`[DeployService] Running: bun install in ${cwd}`);

    const installProc = Bun.spawn(['bun', 'install'], {
      cwd,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await installProc.exited;

    console.log(`[DeployService] bun install exited with code: ${installProc.exitCode}`);

    if (installProc.exitCode !== 0) {
      console.error(`[DeployService] bun install failed with exit code ${installProc.exitCode}`);
      throw new Error('Dependency install failed');
    }

    // Verify node_modules was created
    console.log(
      `[DeployService] node_modules exists after install: ${existsSync(nodeModulesPath)}`,
    );
    console.log(`[DeployService] Dependencies installed successfully`);
  },

  async performHealthCheck(port: number) {
    console.log(`[DeployService] Waiting for health check on port ${port}...`);

    const maxWaitMs = 10000; // total wait time
    const intervalMs = 500;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${port}`);
        console.log(`[DeployService] Health check response: ${res.status}`);
        if (res.ok || res.status < 500) {
          console.log(`[DeployService] Health check passed.`);
          return;
        }
      } catch {
        // service not up yet - no need to log every retry
        // service not up yet
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error(
      `Health check failed: application did not become ready on port ${port} within ${maxWaitMs}ms`,
    );
  },
};
