// Playwright global teardown: stop the detached server child from setup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export default async function globalTeardown() {
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(dir, '.server.pid'), 'utf8')); } catch { /* none */ }
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    // Give the server a moment to close cleanly (it removes .server.json).
    for (let i = 0; i < 20; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((res) => setTimeout(res, 250));
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const f of ['.server.pid']) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } }
}
