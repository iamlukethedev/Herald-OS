// Bundle the Electron main process (ESM) and the preload script (CJS, sandbox-compatible).
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dev = process.argv.includes('--dev')

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: dev ? 'inline' : true,
  minify: false,
  logLevel: 'info',
  define: {
    'process.env.HERALD_OS_BUILD_MODE': JSON.stringify(dev ? 'development' : 'production')
  }
}

await build({
  ...common,
  entryPoints: [path.join(root, 'electron/main.ts')],
  outfile: path.join(root, 'dist/electron/main.mjs'),
  format: 'esm',
  // Native module and Electron stay external; everything else is inlined. dbus-next is bundled, but
  // its optional peers (x11 for an unused address lookup, usocket for unix-fd passing) are not installed;
  // leaving them external keeps the lazy `require` calls, which fail harmlessly at run time. koffi
  // carries a native binary per platform and is required only on Windows, for the control pipe.
  external: ['electron', 'node-pty', 'koffi', 'x11', 'usocket'],
  banner: {
    js: [
      "import { createRequire as __hermesCreateRequire } from 'node:module';",
      'const require = __hermesCreateRequire(import.meta.url);'
    ].join('\n')
  }
})

await build({
  ...common,
  entryPoints: [path.join(root, 'preload/index.ts')],
  outfile: path.join(root, 'dist/electron/preload.cjs'),
  format: 'cjs',
  external: ['electron']
})
