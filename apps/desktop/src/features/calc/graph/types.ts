/* What the Graph view draws: functions of x, and points read from a sheet. */

export interface GraphSeries {
  /** "Budget.xlsx · column B". */
  label: string
  /** [x, y] in order of x; a sheet column's x is the row's position (1, 2, 3…). */
  points: Array<[number, number]>
}

/** One line of the Graph view: a function of x ("sin(x) * x") or a sheet to read ("column B of Budget.xlsx"). */
export interface GraphEntry {
  id: string
  text: string
}

/** What a command or the notepad asks the Graph view to draw. */
export interface GraphRequest {
  /** Each a function of x or a sheet to read. */
  entries?: string[]
  /** Points already read. */
  series?: GraphSeries[]
  xMin?: number
  xMax?: number
}

/** A sheet's cells to plot: "column B of Budget.xlsx" is { workbook: 'Budget.xlsx', range: 'B:B' }. */
export interface SheetPlotRef {
  /** A file (full path, ~/…, or a bare name to find) or an open workbook's name. */
  workbook: string
  /** "B:B", "B2:B40". */
  range: string
  sheet?: string
}
