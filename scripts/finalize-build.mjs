import { writeFileSync } from 'node:fs';
// ncc worker assets are CommonJS even though the source project is ESM.
writeFileSync(new URL('../dist/package.json', import.meta.url), '{"type":"commonjs"}\n');
