import { readFile, writeFile } from 'node:fs/promises'
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
  splitting: false,
  external: ['@solana/kit', '@agentauth-sol/registry'],
  async onSuccess() {
    // tsup (esbuild + dts pass) can emit the sourceMappingURL comment twice; keep exactly one.
    const file = 'dist/index.js'
    const text = await readFile(file, 'utf8')
    const comment = '//# sourceMappingURL=index.js.map'
    const cleaned = text.split(comment).join('').trimEnd() + '\n' + comment + '\n'
    await writeFile(file, cleaned)
  },
})
