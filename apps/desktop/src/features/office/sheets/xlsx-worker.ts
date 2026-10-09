import { workbookFromXlsx } from '../../../../shared/office/xlsx/read.ts'
import { xlsxFromWorkbook } from '../../../../shared/office/xlsx/write.ts'
import type { XlsxRequest, XlsxResponse } from './xlsx.ts'

/* Herald Sheets' .xlsx reading and writing, off the window's thread: ExcelJS takes a while over a big workbook. */

const post = (response: XlsxResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer)

self.onmessage = async (event: MessageEvent<XlsxRequest>) => {
  const request = event.data

  try {
    if (request.kind === 'read') {
      post({ id: request.id, ok: true, read: await workbookFromXlsx(request.bytes, request.options) })
    } else {
      const written = await xlsxFromWorkbook(request.workbook, { original: request.original })
      post({ id: request.id, ok: true, written }, [written.bytes.buffer as ArrayBuffer])
    }
  } catch (error) {
    post({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
