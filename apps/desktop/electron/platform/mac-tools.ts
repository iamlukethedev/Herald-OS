import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './exec.ts'

/*
 * macOS halves of the capture tools Herald OS Linux runs through its CLI: the colour picker (the
 * system eyedropper), reading text or a QR code in an image (the Vision framework), and copying
 * what a QR code says so clipboard managers leave it out. They are small JavaScript-for-Automation
 * scripts, so nothing extra is installed.
 */

const SAMPLER = `ObjC.import('AppKit')
function run() {
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  let result = ''
  let done = false
  $.NSColorSampler.alloc.init.showSamplerWithSelectionHandler(color => {
    if (color && !color.isNil()) {
      const c = color.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace)
      const hex = v => ('0' + Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)).slice(-2)
      result = '#' + hex(c.redComponent) + hex(c.greenComponent) + hex(c.blueComponent)
    }
    done = true
  })
  const until = $.NSDate.dateWithTimeIntervalSinceNow(120)
  while (!done && $.NSDate.date.compare(until) < 0) {
    const event = app.nextEventMatchingMaskUntilDateInModeDequeue($.NSEventMaskAny, $.NSDate.dateWithTimeIntervalSinceNow(0.05), $.NSDefaultRunLoopMode, true)
    if (event && !event.isNil()) app.sendEvent(event)
  }
  return result
}
`

const VISION = `ObjC.import('Foundation')
ObjC.import('Vision')
function run(argv) {
  const [mode, file] = argv
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(file), $.NSDictionary.dictionary)
  const request = mode === 'codes' ? $.VNDetectBarcodesRequest.alloc.init : $.VNRecognizeTextRequest.alloc.init
  if (mode !== 'codes') {
    request.recognitionLevel = 0
    request.usesLanguageCorrection = true
  }
  const error = $()
  if (!handler.performRequestsError($.NSArray.arrayWithObject(request), error)) {
    throw new Error(error.localizedDescription ? error.localizedDescription.js : 'Vision could not read the image')
  }
  const results = request.results
  const out = []
  for (let i = 0; i < results.count; i++) {
    const item = results.objectAtIndex(i)
    if (mode === 'codes') {
      const payload = item.payloadStringValue
      if (payload && !payload.isNil()) out.push(payload.js)
    } else {
      out.push(item.topCandidates(1).objectAtIndex(0).string.js)
    }
  }
  return JSON.stringify(out)
}
`

// The text arrives on stdin, so it is never in a process list. org.nspasteboard.ConcealedType is
// the nspasteboard.org marker clipboard managers read as "a password: do not keep or show this".
// Both types are declared, and the marker written, before the text, so no clipboard manager ever
// sees the text without the marker.
export const CONCEALED_COPY_SCRIPT = `ObjC.import('AppKit')
function run() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
  const board = $.NSPasteboard.generalPasteboard
  const concealed = 'org.nspasteboard.ConcealedType'
  board.declareTypesOwner($([concealed, $.NSPasteboardTypeString]), null)
  if (!board.setDataForType($.NSData.data, concealed)) throw new Error('The clipboard did not take the concealed marker')
  if (!board.setStringForType(text, $.NSPasteboardTypeString)) throw new Error('The clipboard did not take the text')
  return ''
}
`

function scriptFile(name: string, source: string): string {
  const dir = path.join(os.tmpdir(), 'herald-os-scripts')
  const file = path.join(dir, `${name}.js`)

  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== source) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, source)
  }

  return file
}

/** The system eyedropper: the colour clicked, as #rrggbb, or null when the person pressed Escape. */
export async function pickColourMac(): Promise<string | null> {
  const result = await run('osascript', ['-l', 'JavaScript', scriptFile('colour-sampler', SAMPLER)], 130_000)

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'The colour picker did not open')
  }

  const hex = result.stdout.trim()

  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null
}

/** Lines of text (OCR) or the QR codes and barcodes in an image, through Vision. */
export async function readImageMac(image: string, mode: 'text' | 'codes'): Promise<string[]> {
  const result = await run('osascript', ['-l', 'JavaScript', scriptFile('vision', VISION), mode, image], 60_000)

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Vision could not read the image')
  }

  return parseVisionOutput(result.stdout)
}

/** Text on the clipboard marked as concealed, so clipboard managers skip it; pasting works as usual. */
export async function copyConcealedMac(text: string): Promise<void> {
  const result = await run('osascript', ['-l', 'JavaScript', scriptFile('concealed-copy', CONCEALED_COPY_SCRIPT)], 10_000, text)

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'The clipboard did not take the text')
  }
}

/** The script's JSON list of strings, tidied (pure; tested). */
export function parseVisionOutput(stdout: string): string[] {
  try {
    const value: unknown = JSON.parse(stdout.trim() || '[]')

    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}
