import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';

it('bounds pathological reference parsing while preserving ordinary task tokens', async () => {
  const modulePath = createRequire(import.meta.url).resolve('markdown-it');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const MarkdownIt = require(workerData);
    const source = '- [ ] #task 合成任务\\n\\n[a]: /u "' + 'x\\n'.repeat(400000);
    const tokens = new MarkdownIt('commonmark').parse(source, {});
    parentPort.postMessage(tokens.some(token => token.type === 'list_item_open'));
  `, { eval: true, workerData: modulePath });
  try {
    const result = await new Promise<boolean>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Markdown 解析超过 5 秒')), 5_000);
      worker.once('message', (value: boolean) => { clearTimeout(deadline); resolve(value); });
      worker.once('error', (error) => { clearTimeout(deadline); reject(error); });
      worker.once('exit', code => {
        clearTimeout(deadline);
        if (code !== 0) reject(new Error(`Markdown 解析进程退出：${code}`));
      });
    });
    expect(result).toBe(true);
  } finally {
    await worker.terminate();
  }
}, 10_000);
