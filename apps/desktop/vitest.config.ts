import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@herald-os/client': fileURLToPath(new URL('../../packages/hermes-client/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.ts', 'shared/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node'
  }
})
