#!/usr/bin/env node

/**
 * Bundle TypeScript regression scripts with this package's esbuild, then run each bundle
 * with the exact Node executable that launched npm. Keeping the orchestration in Node makes
 * these commands identical on macOS, Linux and Windows (no `/tmp`, shell chaining or
 * platform-specific `node_modules/.bin` path).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const entries = process.argv.slice(2).map((entry) => resolve(root, entry));

if (entries.length === 0) {
  console.error('usage: node scripts/run-ts-tests.mjs scripts/test-name.ts [...]');
  process.exit(2);
}

for (const entry of entries) {
  const local = relative(root, entry);
  if (local.startsWith('..') || !entry.endsWith('.ts') || !existsSync(entry)) {
    console.error(`invalid TypeScript test entry: ${local}`);
    process.exit(2);
  }
}

function runNode(file) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (signal) rejectRun(new Error(`Node was terminated by ${signal}`));
      else resolveRun(code ?? 1);
    });
  });
}

const scratch = await mkdtemp(join(tmpdir(), 'riffsheet-ts-tests-'));
try {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const outfile = join(scratch, `${index}-${basename(entry, '.ts')}.mjs`);
    console.log(`\n--- ${relative(root, entry)} ---`);
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'warning',
      // The same two aliases tsconfig.json and vite.config.ts already declare. Without them
      // a regression test may only reach modules that never mention the pipeline, which
      // quietly puts the whole build path — the part these tests exist to protect —
      // out of reach.
      alias: {
        '@pipeline': join(root, 'src/pipeline/index.ts'),
        '@pipeline-impl': resolve(root, '../pipeline/src/index.ts')
      }
    });
    const code = await runNode(outfile);
    if (code !== 0) process.exitCode = code;
    if (code !== 0) break;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

