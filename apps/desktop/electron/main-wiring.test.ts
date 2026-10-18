import fs from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// main.ts starts Electron as it loads, so it is read as source here rather than run.
const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const statements = [...source.statements]
const firstAfterImports = statements.find(statement => !ts.isImportDeclaration(statement))

describe('main.ts', () => {
  it('takes setPackaged from paths.ts', () => {
    const imports = statements.filter(ts.isImportDeclaration).find(statement => (statement.moduleSpecifier as ts.StringLiteral).text === './paths.ts')
    const names = imports?.importClause?.namedBindings
    const imported = names && ts.isNamedImports(names) ? names.elements.map(element => element.name.text) : []

    expect(imported).toContain('setPackaged')
  })

  it('tells paths.ts whether it is installed, from app.isPackaged, before anything else runs', () => {
    expect(firstAfterImports && ts.isExpressionStatement(firstAfterImports)).toBe(true)
    const call = (firstAfterImports as ts.ExpressionStatement).expression

    expect(ts.isCallExpression(call) && call.expression.getText(source)).toBe('setPackaged')
    expect((call as ts.CallExpression).arguments.map(argument => argument.getText(source))).toEqual(['app.isPackaged'])
  })
})
