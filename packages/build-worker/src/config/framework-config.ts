import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Supported application framework types.
 */
export type AppType = 'nextjs' | 'vite' | 'express' | 'hono' | 'elysia';

export interface FrameworkConfig {
  id: AppType;
  displayName: string;
  category: 'frontend' | 'backend';
  /**
   * Files/directories to include in the deployment artifact.
   * For backend apps, these serve as fallbacks - we also detect from package.json.
   */
  artifactPaths: string[];
}

export const FRAMEWORKS: Record<AppType, FrameworkConfig> = {
  nextjs: {
    id: 'nextjs',
    displayName: 'Next.js',
    category: 'frontend',
    artifactPaths: [
      '.next',
      'public',
      'package.json',
      'bun.lockb',
      'next.config.mjs',
      'next.config.js',
      'next.config.ts',
      'out',
    ],
  },

  vite: {
    id: 'vite',
    displayName: 'Vite',
    category: 'frontend',
    artifactPaths: ['dist'],
  },

  express: {
    id: 'express',
    displayName: 'Express',
    category: 'backend',
    artifactPaths: ['dist', 'build', 'src', 'lib', 'api'],
  },

  hono: {
    id: 'hono',
    displayName: 'Hono',
    category: 'backend',
    artifactPaths: ['dist', 'build', 'src'],
  },

  elysia: {
    id: 'elysia',
    displayName: 'Elysia',
    category: 'backend',
    artifactPaths: ['dist', 'build', 'src'],
  },
};

export const APP_TYPES = Object.keys(FRAMEWORKS) as AppType[];

export function isValidAppType(type: string): type is AppType {
  return type in FRAMEWORKS;
}

export function isBackendFramework(type: AppType): boolean {
  return FRAMEWORKS[type].category === 'backend';
}

/**
 * Reads package.json and extracts the entry file path.
 * Prioritizes scripts.start (most accurate) over main field.
 */
function getEntryFromPackageJson(projectDir: string): string | null {
  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return null;

  const normalizePath = (p: string) => p.replace(/^\.\//, '');

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    // Prioritize start script - it's usually the most accurate entry point
    const startScript = pkg.scripts?.start;
    if (startScript) {
      const match = startScript.match(/(?:node|bun|ts-node|nodemon|tsx)\s+(\S+)/);
      if (match?.[1]) {
        const entry = normalizePath(match[1]);
        if (existsSync(join(projectDir, entry))) {
          return entry;
        }
      }
    }

    // Fall back to main field
    if (pkg.main) {
      const entry = normalizePath(pkg.main);
      if (existsSync(join(projectDir, entry))) {
        return entry;
      }
    }

    // Check module field
    if (pkg.module) {
      const entry = normalizePath(pkg.module);
      if (existsSync(join(projectDir, entry))) {
        return entry;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Gets artifact paths for packaging, dynamically detecting entry points for backend apps.
 */
export function getExistingArtifactPaths(appType: AppType, projectDir: string): string[] {
  const framework = FRAMEWORKS[appType];
  const paths = new Set<string>();

  console.log(`[ArtifactPaths] Detecting paths for ${appType} in ${projectDir}`);

  // Always include package.json and lock files
  for (const lockFile of ['package.json', 'package-lock.json', 'bun.lockb', 'tsconfig.json']) {
    if (existsSync(join(projectDir, lockFile))) {
      paths.add(lockFile);
      console.log(`[ArtifactPaths] Found: ${lockFile}`);
    }
  }

  // For backend apps, detect entry from package.json
  if (framework.category === 'backend') {
    const entry = getEntryFromPackageJson(projectDir);
    console.log(`[ArtifactPaths] Detected entry from package.json: ${entry}`);
    if (entry) {
      // Add the entry file
      if (existsSync(join(projectDir, entry))) {
        paths.add(entry);
        console.log(`[ArtifactPaths] Added entry file: ${entry}`);
      }
      // Add the parent directory of the entry (e.g., "api" from "api/index.js")
      const entryDir = dirname(entry);
      console.log(`[ArtifactPaths] Entry dir: ${entryDir}`);
      if (entryDir !== '.' && existsSync(join(projectDir, entryDir))) {
        paths.add(entryDir);
        console.log(`[ArtifactPaths] Added entry dir: ${entryDir}`);
      }
    }
  }

  // Add framework-specific paths that exist
  for (const p of framework.artifactPaths) {
    if (existsSync(join(projectDir, p))) {
      paths.add(p);
      console.log(`[ArtifactPaths] Found framework path: ${p}`);
    }
  }

  console.log(`[ArtifactPaths] Final paths: ${Array.from(paths).join(', ')}`);
  return Array.from(paths);
}
