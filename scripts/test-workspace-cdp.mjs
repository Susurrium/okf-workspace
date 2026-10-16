import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const normalize = (value) => path.resolve(value).replaceAll('\\', '/').toLowerCase();

export async function evaluateTestVault(port, vault, expression) {
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`CDP target discovery failed: ${response.status}`);
  const targets = (await response.json()).filter(t => t.type === 'page' && t.url.startsWith('app://obsidian'));
  if (targets.length !== 1) throw new Error('Expected exactly one test Obsidian page');
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  let id = 0;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 3000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    async function evaluate(code) {
      const current = ++id;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.removeEventListener('message', receive);
          reject(new Error('CDP evaluation timed out'));
        }, 15000);
        function receive(event) {
          const message = JSON.parse(String(event.data));
          if (message.id !== current) return;
          clearTimeout(timer);
          socket.removeEventListener('message', receive);
          if (message.error) reject(new Error(message.error.message));
          else if (message.result.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text));
          else resolve(message.result.result.value);
        }
        socket.addEventListener('message', receive);
        socket.send(JSON.stringify({ id: current, method: 'Runtime.evaluate', params: {
          expression: code, awaitPromise: true, returnByValue: true,
        } }));
      });
    }
    const actual = await evaluate('globalThis.app?.vault?.adapter?.basePath');
    if (!actual) throw new Error('Test Vault is not ready');
    if (normalize(actual) !== normalize(vault)) throw new Error(`VAULT_MISMATCH: ${actual}`);
    return await evaluate(expression);
  } finally {
    socket.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [configPath, mode, input] = process.argv.slice(2);
  if (!configPath || !['eval', 'file'].includes(mode) || !input) {
    throw new Error('Usage: node scripts/test-workspace-cdp.mjs <test deployment.json> eval|file <input>');
  }
  const deployment = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const marker = JSON.parse(await fs.readFile(path.join(path.dirname(configPath), 'test-environment.json'), 'utf8'));
  if (marker.environment !== 'test' || !deployment.installation_id ||
      marker.installation_id !== deployment.installation_id ||
      normalize(marker.vault) !== normalize(deployment.vault) ||
      normalize(marker.state) !== normalize(deployment.state) ||
      normalize(configPath) !== normalize(path.join(deployment.state, 'config/deployment.json')) ||
      marker.api_port !== deployment.api_port || deployment.api_port === 8765) {
    throw new Error('Invalid isolated test identity');
  }
  const expression = mode === 'file' ? await fs.readFile(input, 'utf8') : input;
  console.log(JSON.stringify(await evaluateTestVault(marker.cdp_port ?? 9366, deployment.vault, expression)));
}
