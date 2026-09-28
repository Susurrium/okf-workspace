import * as fs from 'node:fs';
import * as path from 'node:path';

function getPathModule(value: string): typeof path.posix {
  return value.includes('\\') || /^[A-Za-z]:/.test(value)
    ? path.win32
    : path.posix;
}

function isHostPath(pathModule: typeof path.posix): boolean {
  return process.platform === 'win32'
    ? pathModule === path.win32
    : pathModule === path.posix;
}

function resolveExistingPath(value: string, pathModule: typeof path.posix): string {
  if (!isHostPath(pathModule)) {
    return pathModule.resolve(value);
  }

  const missingSegments: string[] = [];
  let existingPath = pathModule.resolve(value);
  while (!fs.existsSync(existingPath)) {
    const parent = pathModule.dirname(existingPath);
    if (parent === existingPath) {
      return pathModule.resolve(value);
    }
    missingSegments.unshift(pathModule.basename(existingPath));
    existingPath = parent;
  }

  let resolvedExistingPath: string;
  try {
    resolvedExistingPath = fs.realpathSync.native(existingPath);
  } catch {
    resolvedExistingPath = existingPath;
  }

  return pathModule.resolve(resolvedExistingPath, ...missingSegments);
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  if (!candidate.trim() || !root.trim()) {
    return false;
  }

  const pathModule = getPathModule(root);
  if (getPathModule(candidate) !== pathModule) {
    return false;
  }

  const normalizedRoot = resolveExistingPath(root, pathModule);
  const normalizedCandidate = resolveExistingPath(candidate, pathModule);
  const relative = pathModule.relative(normalizedRoot, normalizedCandidate);

  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${pathModule.sep}`)
    && !pathModule.isAbsolute(relative)
  );
}

export function isSamePath(left: string, right: string): boolean {
  return isPathWithinRoot(left, right) && isPathWithinRoot(right, left);
}
