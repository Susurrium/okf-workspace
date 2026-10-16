import esbuild from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import * as sass from 'sass';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

await mkdir('tasks-generated', { recursive: true });
const license = await readFile('vendor/tasks/LICENSE', 'utf8');
await esbuild.build({
  entryPoints: { core: 'tasks-integration/core-entry.ts', plugin: 'tasks-integration/plugin-entry.ts' },
  bundle: true, splitting: true, format: 'esm', target: 'es2022', outdir: 'tasks-generated',
  external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/autocomplete'],
  nodePaths: ['vendor/tasks/src'],
  banner: { js: `/* Obsidian Tasks 8.5.0\n${license}\n*/` },
  plugins: [{ name: 'workbench-task-editor', setup(build) {
    build.onResolve({ filter: /[\\/]TaskModal(?:\.ts)?$/ }, args => {
      if (args.importer.endsWith('task-modal.ts')) return undefined;
      return { path: path.resolve('tasks-integration/task-modal.ts') };
    });
    build.onResolve({ filter: /[\\/]File(?:\.ts)?$/ }, args => {
      if (args.importer.endsWith('task-file.ts')) return undefined;
      const resolved = path.resolve(path.dirname(args.importer), args.path.replace(/\.ts$/, '') + '.ts');
      if (resolved !== path.resolve('vendor/tasks/src/Obsidian/File.ts')) return undefined;
      return { path: path.resolve('tasks-integration/task-file.ts') };
    });
  } }, esbuildSvelte({ compilerOptions: { css: 'injected' } })],
});
const css = sass.compile('vendor/tasks/src/styles.scss', { silenceDeprecations: ['import', 'global-builtin', 'color-functions'] }).css;
await writeFile('tasks-generated/styles.css', css, 'utf8');
