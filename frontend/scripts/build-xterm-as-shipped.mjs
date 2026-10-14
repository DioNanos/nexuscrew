#!/usr/bin/env node
// Rebuilds @xterm/xterm through the exact pipeline that ships it in dist/, so
// tests can exercise the code the browser actually runs.
//
// Why this exists (2026-10-14): the published `lib/xterm.mjs` of @xterm/xterm
// 6.0.0 contains, in requestMode (the DECRQM handler), the compiled const-enum
// emulation `let r;(P=>…)(r||={})` — legal as published. The vite build
// pipeline of this repo rewrites it to `(void 0||(n={}))`: an assignment to an
// identifier that nothing declares. In the shipped ES module (strict mode) the
// first DECRQM written to the terminal throws `ReferenceError: n is not
// defined` inside requestMode, and the write buffer never drains again — the
// phone-hosted cells' black screen. Plain esbuild or plain rollup do NOT
// produce the rewrite; the vite pipeline does, deterministically. So the only
// faithful reproduction is vite itself, which is what this script runs.
//
// Run: node scripts/build-xterm-as-shipped.mjs [outDir]
// Prints the artifact path on stdout (used by the test). The build runs in a
// plain Node process on purpose: esbuild refuses to run inside vitest's jsdom
// environment (cross-realm Uint8Array invariant).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xtermVersion = JSON.parse(
  fs.readFileSync(path.join(frontendRoot, 'node_modules', '@xterm', 'xterm', 'package.json'), 'utf8'),
).version;
const outRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(frontendRoot, 'node_modules', '.cache', 'nc-decrqm-bundle', xtermVersion);

fs.rmSync(path.join(outRoot, 'dist'), { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });
const entry = path.join(outRoot, 'entry.js');
// The assignment is retention, not behavior: rollup drops a bare re-export
// from the chunk (the artifact then loses the whole public API layer), while a
// real use of the binding keeps it. Never executed — the bundle is imported by
// tests only. '@xterm/xterm' resolves through node_modules from outRoot.
fs.writeFileSync(entry, [
  "import { Terminal } from '@xterm/xterm';",
  'export { Terminal };',
  'globalThis.__NC_XTERM_AS_SHIPPED__ = Terminal;',
  '',
].join('\n'));

await build({
  root: outRoot,
  configFile: false,
  logLevel: 'silent',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: true,
    rollupOptions: {
      input: entry,
      output: { format: 'es', entryFileNames: 'xterm-as-shipped.mjs' },
    },
  },
});

const artifact = path.join(outRoot, 'dist', 'xterm-as-shipped.mjs');
if (!fs.existsSync(artifact)) {
  console.error(`artifact missing after build: ${artifact}`);
  process.exit(1);
}
console.log(artifact);
