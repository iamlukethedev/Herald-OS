import type { WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import type { XlsxReadResult } from '../../../../shared/office/xlsx/read.ts'
import type { XlsxWriteResult } from '../../../../shared/office/xlsx/write.ts'

/*
 * .xlsx files through a worker of their own, loaded the first time a workbook is opened or saved:
 * ExcelJS stays out of the window's code, and a big file does not stop the window while it is read.
 * Where there are no workers (tests), the same converters run here.
 */

type Work = { kind: 'read'; bytes: Uint8Array; options: { id: string; name: string; extension?: string } } | { kind: 'write'; workbook: WorkbookSnapshot; original?: Uint8Array }

export type XlsxRequest = Work & { id: number }

export type XlsxResponse = { id: number; ok: true; read?: XlsxReadResult; written?: XlsxWriteResult } | { id: number; ok: false; error: string }

let worker: Worker | null = null
let nextId = 0
const waiting = new Map<number, { resolve: (response: XlsxResponse) => void; reject: (error: Error) => void }>()
/** The file each workbook was read from, by the workbook's id: saving it carries over the parts Herald does not model. */
const originals = new Map<string, Uint8Array>()
const KEPT_ORIGINALS = 24

function start(): Worker | null {
  if (typeof Worker === 'undefined') {
    return null
  }

  if (!worker) {
    worker = new Worker(new URL('./xlsx-worker.ts', import.meta.url), { type: 'module', name: 'herald-sheets-xlsx' })
    worker.onmessage = (event: MessageEvent<XlsxResponse>) => {
      waiting.get(event.data.id)?.resolve(event.data)
      waiting.delete(event.data.id)
    }
    worker.onerror = (event) => {
      // A worker that cannot run gives way to the converters here, for this request and the next.
      event.preventDefault()
      const error = new Error(event.message || 'The workbook converter stopped')
      waiting.forEach((entry) => entry.reject(error))
      waiting.clear()
      worker?.terminate()
      worker = null
    }
  }

  return worker
}

function ask(request: Work): Promise<XlsxResponse> | null {
  const running = start()

  if (!running) {
    return null
  }

  const id = ++nextId

  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    running.postMessage({ ...request, id })
  })
}

/** Read an .xlsx file into a workbook snapshot, with what Herald Sheets could not keep. */
export async function readXlsx(bytes: Uint8Array, options: { id: string; name: string; extension?: string }): Promise<XlsxReadResult> {
  originals.set(options.id, bytes)

  for (const id of originals.keys()) {
    if (originals.size <= KEPT_ORIGINALS) {
      break
    }

    originals.delete(id)
  }

  const response = await ask({ kind: 'read', bytes, options })?.catch(() => null)

  if (!response) {
    return (await import('../../../../shared/office/xlsx/read.ts')).workbookFromXlsx(bytes, options)
  }

  if (!response.ok) {
    throw new Error(response.error)
  }

  return response.read!
}

/** Write a workbook snapshot as an .xlsx file, with what the file cannot keep. */
export async function writeXlsx(workbook: WorkbookSnapshot): Promise<XlsxWriteResult> {
  const original = originals.get(workbook.id)
  const response = await ask({ kind: 'write', workbook, original })?.catch(() => null)

  if (!response) {
    return (await import('../../../../shared/office/xlsx/write.ts')).xlsxFromWorkbook(workbook, { original })
  }

  if (!response.ok) {
    throw new Error(response.error)
  }

  return response.written!
}
