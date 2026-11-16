import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/local-writer', { recursive: true });
await build({ entryPoints: ['local-writer/worker.ts'], outfile: 'dist/local-writer/worker.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'warning' });
await copyFile('local-writer/read-token.ps1', 'dist/local-writer/read-token.ps1');
