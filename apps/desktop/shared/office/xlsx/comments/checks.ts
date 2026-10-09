import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

/*
 * For tests: what other tools make of a file Herald wrote. openpyxl opens it as Excel's own format
 * (it reads notes as each cell's comment), and xmllint checks that every XML part is well formed.
 * Either is passed over where it is not installed.
 */

const PYTHON = process.env.HERALD_TEST_PYTHON ?? '/tmp/sheets-depth-venv/bin/python'

export const hasOpenpyxl = (): boolean => existsSync(PYTHON)

export const hasXmllint = (): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

/** Run a Python script with `book` opened by openpyxl from the file; gives what it prints. */
export function openpyxl(bytes: Uint8Array, script: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'herald-openpyxl-'))

  try {
    const file = join(folder, 'book.xlsx')
    writeFileSync(file, bytes)

    return execFileSync(PYTHON, ['-c', `import openpyxl, json, sys\nbook = openpyxl.load_workbook(sys.argv[1])\n${script}`, file], { encoding: 'utf8' })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

/** The parts of a package xmllint finds not well formed, with what it says. */
export async function malformedParts(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  const folder = mkdtempSync(join(tmpdir(), 'herald-xmllint-'))
  const problems: string[] = []

  try {
    for (const name of Object.keys(zip.files).filter((path) => /\.(xml|rels|vml)$/i.test(path) && !zip.files[path].dir)) {
      const file = join(folder, name.replace(/[/[\]]/g, '_'))
      writeFileSync(file, await zip.file(name)!.async('uint8array'))

      try {
        execFileSync('xmllint', ['--noout', file], { stdio: 'pipe' })
      } catch (error) {
        problems.push(`${name}: ${String((error as { stderr?: Buffer }).stderr ?? error).trim()}`)
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }

  return problems
}
