import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['.build', 'dist']) {
  const target = resolve(root, name);
  if (dirname(target) !== root) throw new Error('Build output must stay within the project');
  rmSync(target, { recursive: true, force: true });
}
