import { BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { OfficePdfRequest, OfficePrintRequest, OfficePrintResult } from '../../shared/ipc.ts'

/*
 * Export as PDF and Print share one path: the window's print view is written to a file and loaded,
 * scripts off, in a hidden window, which prints it to PDF bytes or to the printer the person picks
 * in the system's print dialog. What reaches paper is what a PDF export of the same document shows.
 */

/** The hidden page a print view loads in. */
export interface PrintSurface {
  load: (file: string) => Promise<void>
  toPdf: (options: Electron.PrintToPDFOptions) => Promise<Uint8Array>
  /** Show the print dialog and print; settles when the job is sent, cancelled or fails. */
  print: (options: Electron.WebContentsPrintOptions) => Promise<{ success: boolean; failureReason: string }>
  destroy: () => void
}

/** Print to File, for a system with no printer: where the PDF goes, and writing it there. */
export interface PrintToFile {
  /** The file the person picks for the PDF, or null when they cancel. */
  pick: (suggestedName: string) => Promise<string | null>
  write: (file: string, render: () => Promise<Uint8Array>) => Promise<void>
}

export function hiddenSurface(): PrintSurface {
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } })

  return {
    load: (file) => printer.loadFile(file),
    toPdf: async (options) => new Uint8Array(await printer.webContents.printToPDF(options)),
    print: (options) => new Promise((resolve) => printer.webContents.print(options, (success, failureReason) => resolve({ success, failureReason }))),
    destroy: () => printer.destroy()
  }
}

/** The document's name without its extension, safe as a file name. */
const baseNameOf = (name: string) => name.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').replace(/\.[a-z0-9]{1,5}$/i, '').trim().slice(0, 120) || 'Untitled'

/** A name for the page's file, which the print dialog offers when printing to a file. */
const fileNameOf = (name: string) => `${baseNameOf(name)}.html`

/** Electron's answers when the system has no printer: it then shows no print dialog at all. */
const NO_PRINTER = /^(No printers available on the network|Failed to enumerate printers)$/

// Print views set their page size and margins in CSS (@page), as the document has them.
const pdfOptions = (landscape: boolean, pageSize: OfficePdfRequest['pageSize'] = 'A4'): Electron.PrintToPDFOptions => ({ printBackground: true, landscape, pageSize, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })

async function withPrintView<T>(html: string, name: string, surface: PrintSurface, run: (surface: PrintSurface) => Promise<T>): Promise<T> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'herald-office-print-'))

  try {
    // A file, not a data: URL, so a print view with many pictures is not limited in length.
    const page = path.join(work, fileNameOf(name))
    await fs.writeFile(page, String(html))
    await surface.load(page)

    return await run(surface)
  } finally {
    surface.destroy()
    await fs.rm(work, { recursive: true, force: true })
  }
}

/** Print `html` (no scripts run) to PDF bytes. */
export function printToPdf(request: OfficePdfRequest, surface: PrintSurface = hiddenSurface()): Promise<Uint8Array> {
  return withPrintView(request.html, String(request.suggestedName || 'Untitled'), surface, (page) => page.toPdf(pdfOptions(Boolean(request.landscape), request.pageSize)))
}

/**
 * Print `html` (no scripts run) on the printer the person picks. The paper is the printer's; the
 * page's CSS lays each page out and sets its margins, so the default margin type must stay. With
 * no printer on the system, `toFile` makes it Print to File: a PDF where the person says.
 */
export async function printOnPaper(request: OfficePrintRequest, surface: PrintSurface = hiddenSurface(), toFile?: PrintToFile): Promise<OfficePrintResult> {
  const name = String(request.name || 'Untitled')
  const outcome = await withPrintView(request.html, name, surface, async (page) => {
    const printed = await page.print({ silent: false, printBackground: true, landscape: Boolean(request.landscape), usePrinterDefaultPageSize: true })

    if (printed.success || !toFile || !NO_PRINTER.test(printed.failureReason)) {
      return printed
    }

    const file = await toFile.pick(baseNameOf(name))

    if (!file) {
      return { success: false, failureReason: 'cancelled' }
    }

    await toFile.write(file, () => page.toPdf(pdfOptions(Boolean(request.landscape))))

    return { success: true, failureReason: '' }
  })

  if (outcome.success) {
    return { printed: true }
  }

  return /cancel/i.test(outcome.failureReason) ? { printed: false } : { printed: false, error: outcome.failureReason || 'The print job failed' }
}
