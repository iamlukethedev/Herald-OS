import type { ReadContext } from '../extras.ts'
import type { FinishContext } from '../finish.ts'
import type { PackageSheet, XlsxPackage } from '../package.ts'
import type { Resource } from '../rules.ts'

/*
 * Herald Sheets' charts in .xlsx files: each chart floating over a sheet written as an Excel chart
 * (a DrawingML chart part and an anchor in the sheet's drawing), and charts of the common kinds read
 * back from any file into charts Herald draws.
 */

/** Add the workbook's charts to the package being finished. */
export async function finishCharts(_ctx: FinishContext): Promise<void> {}

/** The sheet drawings resource with the charts of a file, when it has any Herald can draw. */
export async function readCharts(_ctx: ReadContext): Promise<Resource[]> {
  return []
}

/**
 * Which anchors of a sheet's drawing in a file Herald reads as charts, by their place in the drawing
 * (see drawingOf): those come back from the workbook's charts, and every other anchor is kept as it is.
 */
export async function shownAnchors(_pkg: XlsxPackage, _sheet: PackageSheet): Promise<Set<number>> {
  return new Set()
}
