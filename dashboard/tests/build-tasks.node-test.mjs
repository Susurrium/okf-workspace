import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTasks } from '../build-tasks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Tasks cache validates artifacts, serializes builds and preserves output on failure', async () => {
  const work = path.resolve(root, '../work/tasks-build-tests');
  await mkdir(work, { recursive: true });
  const fixture = await mkdtemp(path.join(work, 'fixture-'));
  const dashboard = path.join(fixture, 'dashboard');
  const output = path.join(dashboard, 'tasks-generated');
  try {
    for (const name of ['vendor/tasks/src', 'vendor/tasks/LICENSE', 'tasks-integration', 'apex/src/modal-theme.ts', 'build-tasks.mjs', 'package.json', 'package-lock.json']) {
      await cp(path.join(root, name), path.join(dashboard, name), { recursive: true });
    }
    assert.equal((await buildTasks(dashboard)).cached, false);
    const before = await readFile(path.join(output, 'core.js'));
    const originalTime = (await stat(path.join(output, 'core.js'))).mtimeMs;
    const warm = await Promise.all([buildTasks(dashboard), buildTasks(dashboard)]);
    assert.ok(warm.every(result => result.cached));
    assert.equal((await stat(path.join(output, 'core.js'))).mtimeMs, originalTime);
    await writeFile(path.join(output, 'chunk-AAAAAAAA.js'), '// stale generated chunk');
    assert.equal((await buildTasks(dashboard)).cached, false);
    assert.ok(!(await readdir(output)).includes('chunk-AAAAAAAA.js'));
    await writeFile(path.join(output, 'manual-note.md'), 'preserve me');
    await assert.rejects(buildTasks(dashboard), /Unexpected file/);
    assert.equal(await readFile(path.join(output, 'manual-note.md'), 'utf8'), 'preserve me');
    await rm(path.join(output, 'manual-note.md'));
    await writeFile(path.join(dashboard, 'vendor/tasks/src/styles.scss'), 'a { invalid: ;');
    await assert.rejects(buildTasks(dashboard));
    assert.deepEqual(await readFile(path.join(output, 'core.js')), before);
    assert.deepEqual(await readdir(path.join(fixture, 'work/tasks-build')), []);
  } finally {
    assert.equal(path.dirname(await realpath(fixture)), await realpath(work));
    await rm(fixture, { recursive: true, force: true });
  }
});
