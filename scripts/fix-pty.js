// node-pty's macOS prebuilds ship spawn-helper without the execute bit,
// which makes every spawn fail with "posix_spawnp failed".
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

try {
  const root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
    const helper = path.join(root, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch {
  // node-pty not installed yet; nothing to fix
}
