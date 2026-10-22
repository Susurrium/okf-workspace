import esbuild from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import lockfile from 'proper-lockfile';
import * as sass from 'sass';
import { mkdir, readFile, writeFile, readdir, rename, rm, realpath, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const requiredFiles = ['core.js', 'plugin.js', 'styles.css'];
const generatedName = name => requiredFiles.includes(name) || /^chunk-[A-Z0-9]{8}\.js$/.test(name);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory()
    ? filesUnder(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  return files.flat().sort();
}

async function inputFingerprint(root) {
  const inputs = [...await filesUnder(path.join(root, 'vendor/tasks/src')),
    ...await filesUnder(path.join(root, 'tasks-integration')),
    ...['build-tasks.mjs', 'package.json', 'package-lock.json', 'vendor/tasks/LICENSE', 'apex/src/modal-theme.ts'].map(name => path.join(root, name))];
  const hasher = createHash('sha256').update(`${process.version}:${process.platform}:${process.arch}`);
  for (const input of inputs) hasher.update(path.relative(root, input)).update('\0').update(await readFile(input));
  return hasher.digest('hex');
}

async function outputEntries(output) {
  let entries;
  try { entries = await readdir(output, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || (entry.name !== '.build-state.json' && !generatedName(entry.name))) {
      throw new Error(`Unexpected file in Tasks generated directory: ${entry.name}`);
    }
  }
  return entries.map(entry => entry.name).sort();
}

async function intactCache(output, fingerprint) {
  const names = await outputEntries(output);
  let cached;
  try { cached = JSON.parse(await readFile(path.join(output, '.build-state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  if (cached?.fingerprint !== fingerprint || !cached.files || typeof cached.files !== 'object'
    || Array.isArray(cached.files) || requiredFiles.some(name => !Object.hasOwn(cached.files, name))) return false;
  const expectedNames = Object.keys(cached.files).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedNames, '.build-state.json'].sort())) return false;
  for (const name of expectedNames) {
    if (!generatedName(name) || !/^[a-f0-9]{64}$/.test(cached.files[name])) return false;
    if (digest(await readFile(path.join(output, name))) !== cached.files[name]) return false;
  }
  return true;
}

export async function buildTasks(root = toolRoot) {
  root = await realpath(root);
  const workspace = path.dirname(root);
  const work = path.join(workspace, 'work/tasks-build');
  await mkdir(work, { recursive: true });
  if (await realpath(work) !== work) throw new Error('Tasks build work directory must not contain symlinks');
  const output = path.join(root, 'tasks-generated');
  try {
    if (!(await lstat(output)).isDirectory() || await realpath(output) !== output) {
      throw new Error('Tasks generated directory must be a physical directory');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const release = await lockfile.lock(output, {
    realpath: false, stale: 30000, update: 10000,
    retries: { retries: 120, minTimeout: 250, maxTimeout: 1000 },
  });
  const candidate = path.join(work, `candidate-${randomUUID()}`);
  const previous = path.join(work, `previous-${randomUUID()}`);
  async function removeIntermediate(directory) {
    if (path.dirname(directory) !== work || !/^(candidate|previous)-[a-f0-9-]+$/.test(path.basename(directory))) {
      throw new Error('Unsafe Tasks build cleanup path');
    }
    try { if (await realpath(directory) !== directory) throw new Error('Unsafe Tasks build cleanup symlink'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await rm(directory, { recursive: true, force: true });
  }
  let movedPrevious = false;
  let published = false;
  try {
    const fingerprint = await inputFingerprint(root);
    if (await intactCache(output, fingerprint)) return { cached: true, fingerprint };
    await mkdir(candidate);
    const license = await readFile(path.join(root, 'vendor/tasks/LICENSE'), 'utf8');
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: { core: 'tasks-integration/core-entry.ts', plugin: 'tasks-integration/plugin-entry.ts' },
      bundle: true, splitting: true, format: 'esm', target: 'es2022', outdir: candidate,
      external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/autocomplete'],
      nodePaths: [path.join(root, 'vendor/tasks/src'), path.join(toolRoot, 'node_modules')],
      banner: { js: `/* Obsidian Tasks 8.5.0\n${license}\n*/` },
      plugins: [{ name: 'workbench-task-editor', setup(build) {
        build.onResolve({ filter: /[\\/]TaskModal(?:\.ts)?$/ }, args => {
          if (args.importer.endsWith('task-modal.ts')) return undefined;
          return { path: path.join(root, 'tasks-integration/task-modal.ts') };
        });
        build.onResolve({ filter: /[\\/]File(?:\.ts)?$/ }, args => {
          if (args.importer.endsWith('task-file.ts')) return undefined;
          const resolved = path.resolve(path.dirname(args.importer), args.path.replace(/\.ts$/, '') + '.ts');
          if (resolved !== path.join(root, 'vendor/tasks/src/Obsidian/File.ts')) return undefined;
          return { path: path.join(root, 'tasks-integration/task-file.ts') };
        });
      } }, esbuildSvelte({ compilerOptions: { css: 'injected' } })],
    });
    const css = sass.compile(path.join(root, 'vendor/tasks/src/styles.scss'), {
      silenceDeprecations: ['import', 'global-builtin', 'color-functions'],
    }).css;
    await writeFile(path.join(candidate, 'styles.css'), css, 'utf8');
    const files = {};
    for (const name of await outputEntries(candidate)) files[name] = digest(await readFile(path.join(candidate, name)));
    await writeFile(path.join(candidate, '.build-state.json'), JSON.stringify({ fingerprint, files }), 'utf8');
    if (await inputFingerprint(root) !== fingerprint) throw new Error('Tasks build inputs changed during compilation');
    await outputEntries(output);
    try { await rename(output, previous); movedPrevious = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(candidate, output); published = true; }
    catch (error) { if (movedPrevious) await rename(previous, output); throw error; }
    if (movedPrevious) await removeIntermediate(previous);
    return { cached: false, fingerprint };
  } finally {
    if (!published) await removeIntermediate(candidate);
    await release();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await buildTasks();
}
