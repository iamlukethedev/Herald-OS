import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compile, optimize } from '@tailwindcss/node'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** The CSS the app ships for `reveal`, flattened the way the production build flattens it. */
async function revealCss(): Promise<string> {
  const compiler = await compile(fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8'), { base: SRC, onDependency: () => {} })
  const css = optimize(compiler.build(['reveal'])).code
  const start = css.indexOf('@layer utilities')

  return css.slice(start, css.indexOf('\n}\n', start) + 2)
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return sources(full)
    }

    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [full] : []
  })
}

describe('reveal', () => {
  it('starts hidden and shows on row hover, keyboard focus and an open menu', async () => {
    const css = await revealCss()

    expect(css).toMatch(/\.reveal\s*\{\s*opacity:\s*0;?\s*\}/)

    const shown = css.match(/([^{}]+)\{\s*opacity:\s*1;?\s*\}/)?.[1] ?? ''

    const row = shown.match(/\.reveal:is\(:where\(\.group\\\/reveal-row\):is\((.*?)\) \*\)/)?.[1].split(/,\s*/) ?? []

    expect(row).toEqual([':hover', ':focus-visible', ':has(:focus-visible)'])
    expect(shown).toContain('.reveal:focus-visible')
    expect(shown).toMatch(/\.reveal\[aria-expanded=["']?true/)
  })

  it('is always visible on screens that cannot hover', async () => {
    const css = await revealCss()

    expect(css).toMatch(/@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{\s*\.reveal\s*\{\s*opacity:\s*1;?\s*\}/)
  })

  it('replaces every hover-only control in the app', () => {
    const hoverOnly = /\b(?:opacity-0|hidden)\b[^'"`]*\bgroup-hover(?:\/[\w-]+)?:(?:opacity-100|flex|grid|block|inline-flex)\b/
    const offenders = sources(SRC)
      .filter(file => hoverOnly.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(SRC, file))

    expect(offenders).toEqual([])
  })
})
