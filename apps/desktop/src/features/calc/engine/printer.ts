import { ParseError, type Node } from './parser.ts'

/*
 * An expression of x written out as math.js reads it, for drawing: "sin(x) * x", "x^2 - 2".
 * Degrees become radians in the text, "log" of one number is log10 and "ln" stays ln (the drawing
 * instance defines it), so printing what the parser read back gives the same text. Pure.
 */

const NAMES: Readonly<Record<string, string>> = { trunc: 'fix' }

/** How a name prints: its text, or null when it has no value to draw with. */
export type NamePrinter = (key: string, name: string) => string | null

/** The expression for math.js; throws a ParseError for what cannot be drawn (money, units, conversions). */
export function printExpression(node: Node, names: NamePrinter): string {
  return print(node, names).text
}

interface Printed {
  text: string
  /** 1 sum, 2 product, 3 sign, 4 power, 5 atom. */
  level: number
}

function wrap(printed: Printed, level: number): string {
  return printed.level < level ? `(${printed.text})` : printed.text
}

function print(node: Node, names: NamePrinter): Printed {
  switch (node.type) {
    case 'number':
      return { text: node.value, level: 5 }
    case 'group':
      return { text: `(${print(node.value, names).text})`, level: 5 }
    case 'name': {
      if (node.key === 'pi' || node.key === 'e' || node.key === 'phi' || node.key === 'tau') {
        return { text: node.key, level: 5 }
      }

      const text = names(node.key, node.name)

      if (text === null) {
        throw new ParseError(`“${node.name}” has no value to draw with: use x, or give it a number on a line above`, node.from)
      }

      return { text, level: text.startsWith('-') ? 3 : 5 }
    }
    case 'quantity':
      if (node.unit.unit === 'deg') {
        return { text: `${wrap(print(node.value, names), 2)} * pi / 180`, level: 2 }
      }

      if (node.unit.unit === 'rad') {
        return print(node.value, names)
      }

      throw new ParseError('Graphs draw plain numbers, without units', node.from)
    case 'money':
      throw new ParseError('Graphs draw plain numbers, without money', node.from)
    case 'convert':
      throw new ParseError('Graphs draw plain numbers, without conversions', node.from)
    case 'percent':
      return { text: `${wrap(print(node.value, names), 2)} / 100`, level: 2 }
    case 'negate':
      return { text: `-${wrap(print(node.value, names), 4)}`, level: 3 }
    case 'factorial':
      return { text: `${wrap(print(node.value, names), 5)}!`, level: 5 }
    case 'call': {
      const args = node.args.map(arg => print(arg, names).text)
      const name = node.fn === 'log' && args.length === 1 ? 'log10' : (NAMES[node.fn] ?? node.fn)

      return { text: `${name}(${args.join(', ')})`, level: 5 }
    }
    case 'binary': {
      const left = print(node.left, names)
      const right = print(node.right, names)

      switch (node.op) {
        case '+':
          return { text: `${wrap(left, 1)} + ${wrap(right, 2)}`, level: 1 }
        case '-':
          return { text: `${wrap(left, 1)} - ${wrap(right, 2)}`, level: 1 }
        case '*':
        case 'juxt':
        case 'of':
          return { text: `${wrap(left, 2)} * ${wrap(right, 3)}`, level: 2 }
        case '/':
          return { text: `${wrap(left, 2)} / ${wrap(right, 3)}`, level: 2 }
        case '^':
          return { text: `${wrap(left, 5)}^${wrap(right, 4)}`, level: 4 }
        case 'mod':
          return { text: `mod(${left.text}, ${right.text})`, level: 5 }
        case 'off':
        case 'on':
          return { text: `${wrap(right, 2)} * (1 ${node.op === 'on' ? '+' : '-'} ${wrap(left, 2)})`, level: 2 }
      }
    }
  }
}
