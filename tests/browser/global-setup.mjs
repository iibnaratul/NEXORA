// Playwright global setup: spawn tests/browser/serve.mjs as a detached child
// (so it survives this setup process exiting) and wait for its .server.json
// ready file + a passing /api/health probe. The pid is stored for teardown.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const infoPath = path.join(dir, '.server.json');
const logPath = path.join(dir, 'artifacts', 'server.log');
const pidPath = path.join(dir, '.server.pid');

export default async function globalSetup() {
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  for (const f of [infoPath, pidPath]) { try { fs.unlinkSync(f); } catch { /* stale */ } }
  const log = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, [path.join(dir, 'serve.mjs')], {
    cwd: path.join(dir, '..', '..'),
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env },
  });
  child.unref();
  fs.writeFileSync(pidPath, String(child.pid));
  const deadline = Date.now() + 90_000;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`browser test server exited early (code ${child.exitCode}); see tests/browser/artifacts/server.log`);
    }
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      const r = await fetch(`${info.baseUrl}/api/health`);
      if (r.ok) {
        console.log(`[browser global-setup] server up: ${info.baseUrl} db=${info.dbMode}`);
        return;
      }
      lastErr = `health status ${r.status}`;
    } catch (e) { lastErr = e.message; }
    await new Promise((res) => setTimeout(res, 500));
  }
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already dead */ }
  throw new Error(`browser test server did not become ready in 90s (last: ${lastErr}); see tests/browser/artifacts/server.log`);
}
