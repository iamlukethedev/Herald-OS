// @vitest-environment happy-dom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compile, optimize } from '@tailwindcss/node'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'

import { SearchField } from './components/ui/glass.tsx'

// These checks parse the CSS that Tailwind 4.3.x and its Lightning CSS optimiser print, as
// reveal.test.ts does. A Tailwind upgrade can change that formatting; update the parsing when it does.

const SRC = path.dirname(fileURLToPath(import.meta.url))

interface Rule {
  selector: string
  body: string
  layered: boolean
}

/** The style rules of the compiled sheet, each marked with whether it sits inside an `@layer` block. */
function rules(css: string): Rule[] {
  const out: Rule[] = []
  const stack: boolean[] = []
  let prelude = ''
  let i = 0

  while (i < css.length) {
    const char = css[i]

    if (char === '{') {
      const head = prelude.trim()
      const layered = stack.includes(true) || head.startsWith('@layer')

      if (head.startsWith('@')) {
        stack.push(layered)
        prelude = ''
        i++
        continue
      }

      const end = css.indexOf('}', i)
      out.push({ selector: head, body: css.slice(i + 1, end), layered })
      prelude = ''
      i = end + 1
      continue
    }

    if (char === '}') {
      stack.pop()
      prelude = ''
    } else if (char === ';' && prelude.trim().startsWith('@')) {
      prelude = ''
    } else {
      prelude += char
    }

    i++
  }

  return out
}

/** Splits a selector list on its top-level commas, leaving the commas inside `:is()` and `:not()`. */
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

const ZERO = /^0(?:\.0+)?(?:px|em|rem)?$/
const TRANSPARENT = /^(?:transparent|#[0-9a-f]{3}0|#[0-9a-f]{6}00|rgba?\([^)]*[,/]\s*0(?:\.0+)?%?\s*\))$/i

/** Whether a rule body leaves no visible outline: no style, zero width or a transparent colour. */
function removesOutline(body: string): boolean {
  return body.split(';').some(declaration => {
    const [property, ...rest] = declaration.split(':')
    const name = property.trim()
    const value = rest.join(':').trim()
    const parts = value.match(/\S+\([^)]*\)|\S+/g) ?? []

    switch (name) {
      case 'outline':
        return parts.some(part => part === 'none' || part === 'hidden' || ZERO.test(part) || TRANSPARENT.test(part))
      case 'outline-style':
        return value === 'none' || value === 'hidden'
      case 'outline-width':
        return ZERO.test(value)
      case 'outline-color':
        return TRANSPARENT.test(value)
      default:
        return false
    }
  })
}

let sheet: Rule[] = []

beforeAll(async () => {
  const compiler = await compile(fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8'), { base: SRC, onDependency: () => {} })
  sheet = rules(optimize(compiler.build(['outline-none'])).code)
})

/** The selectors of the unlayered rules that take the outline away, which beat the global ring. */
function outlineRemovers(): string[] {
  return sheet
    .filter(rule => !rule.layered && removesOutline(rule.body))
    .flatMap(rule => selectors(rule.selector))
}

/** Whether an element with keyboard focus would lose its outline to one of those rules. */
function losesOutline(element: Element): boolean {
  return outlineRemovers().some(selector => element.matches(selector.replace(/:focus(?:-visible)?(?![-\w])/g, '')))
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.replaceChildren(host)
  return host
}

describe('outline check', () => {
  it.each([
    'outline: none',
    'outline: 0',
    'outline: 0px',
    'outline-style: none',
    'outline-width: 0',
    'outline-width: 0px',
    'outline-color: transparent',
    'outline-color: #0000',
    'outline: 2px solid transparent',
    'outline: 2px solid #0000',
    'outline: 1px solid rgba(0, 0, 0, 0)',
    'outline-color: #fff0',
    'outline-color: #FFF0',
    'outline: 2px solid #2f7dff00',
    'outline: 2px solid #2F7DFF00'
  ])('counts %j as no visible ring', (body) => {
    expect(removesOutline(body)).toBe(true)
  })

  it.each(['outline: 1.5px solid var(--color-accent-strong)', 'outline: auto', 'outline-offset: 0', 'outline-color: #2f7dff', 'outline-color: #fff', 'outline-color: #fff8', 'outline: 2px solid #2f7dff80'])(
    'counts %j as a visible ring',
    (body) => {
      expect(removesOutline(body)).toBe(false)
    }
  )

  it.each([
    ['outline: 2px solid transparent', '#0000'],
    ['outline: 2px solid rgba(255, 255, 255, 0)', '#fff0'],
    ['outline: 2px solid rgb(47 125 255 / 0)', '#2f7dff00'],
    ['outline-color: rgba(255, 255, 255, 0)', '#fff0'],
    ['outline-color: rgb(47 125 255 / 0)', '#2f7dff00']
  ])('counts %j as no visible ring after the build prints it as %s', async (declaration, printed) => {
    const compiler = await compile(`.probe { ${declaration}; }`, { base: SRC, onDependency: () => {} })
    const probe = rules(optimize(compiler.build([])).code).find(rule => rule.selector === '.probe')

    expect(probe?.body).toContain(printed)
    expect(removesOutline(probe!.body)).toBe(true)
  })
})

describe('global focus ring', () => {
  it('is unlayered, so the outline-none utilities on buttons and links across the app cannot remove it', () => {
    const global = sheet.find(rule => rule.selector === ':focus-visible')

    expect(global).toBeDefined()
    expect(global?.layered).toBe(false)
    expect(global?.body).toMatch(/outline:\s*1\.5px solid var\(--color-accent-strong\)/)
  })

  it('cannot be beaten by the outline-none utility, which lives in the utilities layer', () => {
    const utility = sheet.find(rule => rule.selector === '.outline-none')

    expect(utility?.layered).toBe(true)
  })
})

describe('glass-input wrapper', () => {
  it('draws its own ring when anything inside it has focus', () => {
    const ring = sheet.find(rule => rule.selector === '.glass-input:focus-within')

    expect(ring?.layered).toBe(false)
    expect(ring?.body).toMatch(/border-color:\s*var\(--color-accent-strong\)/)
    expect(ring?.body).toMatch(/box-shadow:[^;]*0 0 0 3px/)
  })

  it('hides the outline with a transparent colour, so forced-colors mode still draws a ring', () => {
    const hiders = sheet.filter(rule => !rule.layered && rule.selector.includes('.glass-input') && removesOutline(rule.body))

    expect(hiders).not.toHaveLength(0)

    for (const rule of hiders) {
      const [width, style, colour] = rule.body.match(/(?:^|;)\s*outline:\s*([^;]+)/)?.[1].match(/\S+\([^)]*\)|\S+/g) ?? []

      expect([width, style]).toEqual(['2px', 'solid'])
      expect(colour).toMatch(TRANSPARENT)
    }
  })

  it('takes the outline off the SearchField input, so it shows one ring, not two', () => {
    const host = mount(renderToStaticMarkup(<SearchField value="" onChange={() => {}} placeholder="Search your memory…" trailing={<button type="button" aria-label="Clear">×</button>} />))
    const input = host.querySelector('input')

    expect(input?.closest('.glass-input')).not.toBeNull()
    expect(losesOutline(input!)).toBe(true)
  })

  it('keeps the outline on a button inside the SearchField, since the wrapper ring cannot say which control has focus', () => {
    const host = mount(renderToStaticMarkup(<SearchField value="" onChange={() => {}} trailing={<button type="button" aria-label="Clear">×</button>} />))

    expect(losesOutline(host.querySelector('button')!)).toBe(false)
  })

  it('takes the outline off a textarea inside a composer wrapper', () => {
    const host = mount('<div class="glass-input"><textarea></textarea><button type="button">Send</button></div>')

    expect(losesOutline(host.querySelector('textarea')!)).toBe(true)
    expect(losesOutline(host.querySelector('button')!)).toBe(false)
  })

  it.each([
    ['a button', '<button type="button">Go</button>'],
    ['a link', '<a href="#x">Open</a>'],
    ['a select', '<select><option>One</option></select>'],
    ['a checkbox', '<input type="checkbox">'],
    ['a radio', '<input type="radio">'],
    ['a slider', '<input type="range">'],
    ['a colour well', '<input type="color">'],
    ['a submit input', '<input type="submit" value="Go">'],
    ['a file input', '<input type="file">'],
    ['a button input', '<input type="button" value="Go">'],
    ['a reset input', '<input type="reset" value="Reset">'],
    ['an image input', '<input type="image" alt="Go">'],
    ['a focusable div', '<div tabindex="0">Row</div>']
  ])('keeps the outline on %s inside a wrapper', (_, html) => {
    const host = mount(`<label class="glass-input">${html}</label>`)

    expect(losesOutline(host.querySelector('label > *')!)).toBe(false)
  })

  it.each([
    ['an input', '<input class="glass-input outline-none">'],
    ['a search input', '<input type="search" class="glass-input">'],
    ['a password input', '<input type="password" class="glass-input">'],
    ['a number input', '<input type="number" class="glass-input">'],
    ['a textarea', '<textarea class="glass-input outline-none"></textarea>'],
    ['a select', '<select class="glass-input outline-none"><option>One</option></select>']
  ])('takes the outline off %s that is itself the glass-input, so its border and halo are the one ring', (_, html) => {
    const host = mount(html)

    expect(losesOutline(host.firstElementChild!)).toBe(true)
  })

  it.each([
    ['a button', '<button type="button" class="glass-input">Pick</button>'],
    ['a checkbox', '<input type="checkbox" class="glass-input">'],
    ['a radio', '<input type="radio" class="glass-input">'],
    ['a slider', '<input type="range" class="glass-input">'],
    ['a colour well', '<input type="color" class="glass-input">'],
    ['a file input', '<input type="file" class="glass-input">'],
    ['a button input', '<input type="button" class="glass-input" value="Go">'],
    ['a submit input', '<input type="submit" class="glass-input" value="Go">'],
    ['a reset input', '<input type="reset" class="glass-input" value="Reset">'],
    ['an image input', '<input type="image" class="glass-input" alt="Go">']
  ])('keeps the outline on %s that is itself the glass-input', (_, html) => {
    const host = mount(html)

    expect(losesOutline(host.firstElementChild!)).toBe(false)
  })

  it.each([
    ['a button', '<button type="button" class="outline-none">Go</button>'],
    ['a link', '<a href="#x" class="outline-none">Open</a>'],
    ['an input', '<input class="outline-none">'],
    ['a textarea', '<textarea class="outline-none"></textarea>']
  ])('keeps the outline on %s outside any wrapper, even with outline-none', (_, html) => {
    const host = mount(html)

    expect(losesOutline(host.firstElementChild!)).toBe(false)
  })
})
