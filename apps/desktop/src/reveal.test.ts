import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compile, optimize } from '@tailwindcss/node'
import { describe, expect, it } from 'vitest'

// These checks parse the CSS that Tailwind 4.3.x and its Lightning CSS optimiser print. A Tailwind
// upgrade can change that formatting; update the parsing here when it does.

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** The CSS the app ships for `reveal`, flattened the way the production build flattens it. */
async function revealCss(): Promise<string> {
  const compiler = await compile(fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8'), { base: SRC, onDependency: () => {} })
  const css = optimize(compiler.build(['reveal'])).code
  const start = css.indexOf('@layer utilities')

  return css.slice(start, css.indexOf('\n}\n', start) + 2)
}

/** Splits a selector list on its top-level commas, leaving the commas inside `:is()` and friends. */
function selectors(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''

  for (const char of list) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0

    if (char === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }

  return [...out, current.trim()].filter(Boolean)
}

/** The selectors of the rule that makes `reveal` visible outside a media query. */
async function shownSelectors(): Promise<string[]> {
  const css = await revealCss()

  return selectors(css.match(/\}\s*([^{}@]+)\{\s*opacity:\s*1;?\s*\}/)?.[1] ?? '')
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

const read = (file: string): string => fs.readFileSync(file, 'utf8')

/** A class token that would show a control only on hover or focus of an ancestor, whatever the class order or string it sits in. */
const HOVER_ONLY = /(?<![\w-])(?:group|in)-(?:hover|focus|focus-within|focus-visible)(?:\/[\w-]+)?:(?:opacity-\d+|visible|flex|grid|block|inline(?:-flex|-block|-grid)?|contents|table|\[(?:opacity|visibility|display):)/

const FOCUS_WITHIN = /(?<![\w-])(?:group-|peer-)?focus-within(?:\/[\w-]+)?:/

/** Whether a component gives some element the `reveal` class (not the word in text, nor a `'reveal'` action id). */
const usesReveal = (file: string): boolean =>
  file.endsWith('.tsx') && read(file).split('\n').some(line => /className|\bcn\(/.test(line) && /['"`](?:[^'"`\n]*\s)?reveal(?:\s[^'"`\n]*)?['"`]/.test(line))

describe('reveal CSS', () => {
  it('starts hidden', async () => {
    expect(await revealCss()).toMatch(/\.reveal\s*\{\s*opacity:\s*0;?\s*\}/)
  })

  it('shows on hover or keyboard focus of a reveal row, keyboard focus of the control, and an open menu', async () => {
    expect(await shownSelectors()).toEqual([
      '.reveal:is(:where(.group\\/reveal-row):is(:hover, :focus-visible, :has(:focus-visible)) *)',
      '.reveal:focus-visible',
      '.reveal:has(:focus-visible)',
      '.reveal[aria-expanded="true"]',
      '.reveal:has([aria-expanded="true"])'
    ])
  })

  it('keeps the control-level :has(:focus-visible) rule for wrappers around several buttons', async () => {
    expect(await shownSelectors()).toContain('.reveal:has(:focus-visible)')
  })

  it('ignores a plain group and mouse focus', async () => {
    const shown = (await shownSelectors()).join(' ')

    expect(shown).not.toMatch(/\.group(?!\\\/reveal-row)/)
    expect(shown).not.toContain(':focus-within')
    expect(shown).not.toMatch(/:focus(?![-\w])/)
  })

  it('is always visible on screens with any touch input', async () => {
    expect(await revealCss()).toMatch(/@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\),\s*\(any-pointer:\s*coarse\)\s*\{\s*\.reveal\s*\{\s*opacity:\s*1;?\s*\}/)
  })
})

describe('dock labels', () => {
  it('show on keyboard focus as well as hover', () => {
    const rule = read(path.join(SRC, 'styles.css')).match(/([^{}]*)\{[^{}]*\}/g)?.find(block => block.includes('.dock-item:hover .dock-label')) ?? ''

    expect(rule).toContain('.dock-item:focus-visible .dock-label')
    expect(rule).toMatch(/opacity:\s*1/)
  })
})

describe('hover-only guard', () => {
  it.each([
    ['opacity-0 group-hover:opacity-100'],
    ['group-hover:opacity-100 opacity-0'],
    ['invisible group-hover:visible'],
    ['hidden group-hover:flex'],
    ['hidden group-hover/row:inline-flex'],
    ["cn('opacity-0', 'group-hover:opacity-100')"],
    ["cn('flex opacity-0',\n  open && 'x', 'group-focus-within:opacity-100')"],
    ['opacity-0 in-hover:opacity-100'],
    ['opacity-0 group-hover:[opacity:1]']
  ])('catches %j', (classes) => {
    expect(classes).toMatch(HOVER_ONLY)
  })

  it.each([['group-hover:text-fg'], ['group-hover:text-black/60'], ['reveal hover:text-fg'], ['opacity-0']])('allows %j', (classes) => {
    expect(classes).not.toMatch(HOVER_ONLY)
  })

  it('finds no hover-only controls in the app', () => {
    const offenders = sources(SRC)
      .filter(file => HOVER_ONLY.test(read(file)))
      .map(file => path.relative(SRC, file))

    expect(offenders).toEqual([])
  })

  it('recognises the components that use reveal', () => {
    const users = sources(SRC).filter(usesReveal).map(file => path.relative(SRC, file))

    expect(users).toEqual(expect.arrayContaining(['features/chat/SessionList.tsx', 'features/office/docs/CommentsPanel.tsx', 'features/office/docs/TemplateGallery.tsx']))
    expect(users.length).toBeGreaterThanOrEqual(13)
  })

  it('finds no focus-within next to reveal, which a mouse click would leave stuck open', () => {
    expect("cn('reveal', 'focus-within:opacity-100')").toMatch(FOCUS_WITHIN)

    const offenders = sources(SRC)
      .filter(file => usesReveal(file) && FOCUS_WITHIN.test(read(file)))
      .map(file => path.relative(SRC, file))

    expect(offenders).toEqual([])
  })

  it('gives every reveal control a reveal row', () => {
    const offenders = sources(SRC)
      .filter(file => usesReveal(file) && !read(file).includes('group/reveal-row'))
      .map(file => path.relative(SRC, file))

    expect(offenders).toEqual([])
  })
})

describe('session delete button', () => {
  const list = read(path.join(SRC, 'features/chat/SessionList.tsx'))
  const button = list.match(/<button(?:(?!<button)[\s\S])*?aria-label="Delete session"[\s\S]*?>\s*<IconTrash/)?.[0] ?? ''
  const classes = button.match(/className="([^"]*)"/)?.[1].split(/\s+/) ?? []

  it('is found', () => {
    expect(button).not.toBe('')
  })

  it('stays in the Tab order', () => {
    expect(button).not.toMatch(/tabIndex/i)
    expect(button).not.toMatch(/\bdisabled\b|aria-hidden|inert/)
    expect(classes).not.toContain('hidden')
    expect(classes).not.toContain('invisible')
  })

  it('uses reveal inside a reveal row', () => {
    expect(classes).toContain('reveal')
    expect(list.slice(0, list.indexOf(button))).toMatch(/group\/reveal-row[^\n]*\n\s*<button[^\n]*openStoredSession/)
  })
})
