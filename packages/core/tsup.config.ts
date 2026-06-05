import { defineConfig } from 'tsup';
import fs from 'fs';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  minify: true,
  esbuildPlugins: [{
    name: 'wasm-inline',
    setup(build: any) {
      // Intercept any .wasm imports and transform them into native Uint8Array buffers
      build.onLoad({ filter: /\.wasm$/ }, async (args: any) => {
        const buffer = await fs.promises.readFile(args.path);
        return {
          contents: `export default new Uint8Array([${Array.from(buffer).join(',')}]);`,
          loader: 'js',
        };
      });
    },
  }],
  outExtension({ format }) {
    return {
        js: format === 'cjs' ? '.cjs' : '.js',
        dts: '.d.ts',
    }
  }
});