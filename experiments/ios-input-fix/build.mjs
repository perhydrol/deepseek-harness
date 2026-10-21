/** Build the classic Client registration script using the checkout's existing bundler. */
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';

await build({
  config: false,
  tsconfig: false,
  entry: { client: fileURLToPath(new URL('./src/client.js', import.meta.url)) },
  outDir: fileURLToPath(new URL('./', import.meta.url)),
  clean: false,
  platform: 'browser',
  target: 'safari15',
  format: 'iife',
  dts: false,
  outputOptions: { entryFileNames: 'client.js' },
});
