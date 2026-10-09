import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { type PrintSurface, printOnPaper, printToPdf } from './print.ts'

vi.mock('electron', () => ({ BrowserWindow: vi.fn() }))

/** A hidden page that records what it loaded and how it was asked to print. */
function fakeSurface(outcome = { success: true, failureReason: '' }) {
  const seen = { html: '', file: '', destroyed: false, printed: [] as Electron.WebContentsPrintOptions[], pdf: [] as Electron.PrintToPDFOptions[] }
  const surface: PrintSurface = {
    load: async (file) => {
      seen.file = file
      seen.html = fs.readFileSync(file, 'utf8')
    },
    toPdf: async (options) => {
      seen.pdf.push(options)

      return new Uint8Array([37, 80, 68, 70])
    },
    print: async (options) => {
      seen.printed.push(options)

      return outcome
    },
    destroy: () => {
      seen.destroyed = true
    }
  }

  return { surface, seen }
}

const view = '<!doctype html><title>Plan</title><style>@page { size: A4 landscape; margin: 0.5in; }</style><table><tr><td>1</td></tr></table>'

describe('printOnPaper', () => {
  it('prints the print view through the dialog, with the page’s own margins and the printer’s paper', async () => {
    const { surface, seen } = fakeSurface()

    await expect(printOnPaper({ html: view, name: 'Plan.xlsx', landscape: true }, surface)).resolves.toEqual({ printed: true })
    expect(seen.html).toBe(view)
    expect(seen.printed).toEqual([{ silent: false, printBackground: true, landscape: true, usePrinterDefaultPageSize: true }])
    expect(seen.printed[0]).not.toHaveProperty('margins')
  })

  it('names the page after the document, which the dialog offers when printing to a file', async () => {
    const { surface, seen } = fakeSurface()

    await printOnPaper({ html: view, name: 'Q3: plan/draft.docx' }, surface)

    expect(seen.file.endsWith('/Q3- plan-draft.html')).toBe(true)
  })

  it('takes a cancelled dialog quietly and reports a failed job', async () => {
    await expect(printOnPaper({ html: view, name: 'Plan' }, fakeSurface({ success: false, failureReason: 'Print job canceled' }).surface)).resolves.toEqual({ printed: false })
    await expect(printOnPaper({ html: view, name: 'Plan' }, fakeSurface({ success: false, failureReason: 'Invalid printer settings' }).surface)).resolves.toEqual({ printed: false, error: 'Invalid printer settings' })
    await expect(printOnPaper({ html: view, name: 'Plan' }, fakeSurface({ success: false, failureReason: '' }).surface)).resolves.toEqual({ printed: false, error: 'The print job failed' })
  })

  it('prints to a PDF file the person picks when the system has no printer, which Electron shows no dialog for', async () => {
    for (const failureReason of ['No printers available on the network', 'Failed to enumerate printers']) {
      const { surface, seen } = fakeSurface({ success: false, failureReason })
      const picked: string[] = []
      const written: Array<[string, Uint8Array]> = []
      const toFile = {
        pick: async (name: string) => {
          picked.push(name)

          return '/tmp/Plan.pdf'
        },
        write: async (file: string, render: () => Promise<Uint8Array>) => {
          expect(seen.destroyed).toBe(false)
          written.push([file, await render()])
        }
      }

      await expect(printOnPaper({ html: view, name: 'Q3: plan.xlsx', landscape: true }, surface, toFile)).resolves.toEqual({ printed: true })
      expect(picked).toEqual(['Q3- plan'])
      expect(written).toEqual([['/tmp/Plan.pdf', new Uint8Array([37, 80, 68, 70])]])
      expect(seen.pdf).toEqual([{ printBackground: true, landscape: true, pageSize: 'A4', preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } }])
      expect(seen.destroyed).toBe(true)
    }
  })

  it('takes a cancelled Print to File quietly, and leaves a printer’s own failure alone', async () => {
    const write = vi.fn()
    const cancelled = fakeSurface({ success: false, failureReason: 'No printers available on the network' })

    await expect(printOnPaper({ html: view, name: 'Plan' }, cancelled.surface, { pick: async () => null, write })).resolves.toEqual({ printed: false })
    expect(cancelled.seen.pdf).toEqual([])

    const pick = vi.fn()

    await expect(printOnPaper({ html: view, name: 'Plan' }, fakeSurface({ success: false, failureReason: 'Invalid printer settings' }).surface, { pick, write })).resolves.toEqual({ printed: false, error: 'Invalid printer settings' })
    await expect(printOnPaper({ html: view, name: 'Plan' }, fakeSurface({ success: false, failureReason: 'No printers available on the network' }).surface)).resolves.toEqual({ printed: false, error: 'No printers available on the network' })
    expect(pick).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('closes the hidden page and removes its file whatever happens', async () => {
    const { surface, seen } = fakeSurface()
    surface.print = async () => {
      throw new Error('gone')
    }

    await expect(printOnPaper({ html: view, name: 'Plan' }, surface)).rejects.toThrow('gone')
    expect(seen.destroyed).toBe(true)
    expect(fs.existsSync(seen.file)).toBe(false)
  })
})

describe('printToPdf', () => {
  it('loads the same print view the printer gets, and prints it at the page’s CSS size', async () => {
    const paper = fakeSurface()
    const pdf = fakeSurface()

    await printOnPaper({ html: view, name: 'Plan', landscape: true }, paper.surface)
    await expect(printToPdf({ html: view, suggestedName: 'Plan', landscape: true }, pdf.surface)).resolves.toEqual(new Uint8Array([37, 80, 68, 70]))

    expect(pdf.seen.html).toBe(paper.seen.html)
    expect(pdf.seen.pdf).toEqual([{ printBackground: true, landscape: true, pageSize: 'A4', preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } }])
    expect(pdf.seen.destroyed).toBe(true)
    expect(fs.existsSync(pdf.seen.file)).toBe(false)
  })
})
