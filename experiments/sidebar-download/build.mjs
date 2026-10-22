/** Emit installable Host modules and the classic browser registration script. */
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
const root = fileURLToPath(new URL('./', import.meta.url));
await build({ config: false, tsconfig: false, entry: { index: `${root}src/index.ts` },
  outDir: `${root}lib`, clean: true, platform: 'node', format: 'esm', dts: false, deps: { neverBundle: ['archiver'] },
  outputOptions: { entryFileNames: '[name].js' } });
await build({ config: false, tsconfig: false, entry: { client: `${root}src/client.ts` },
  outDir: root, clean: false, platform: 'browser', target: 'safari15', format: 'iife', dts: false,
  outputOptions: { entryFileNames: 'client.js' } });
