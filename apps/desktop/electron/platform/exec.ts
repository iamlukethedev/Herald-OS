import { execFile } from 'node:child_process'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

export interface ExecBufferResult {
  stdout: Buffer
  stderr: string
  code: number
}

/** Exit code reported when the binary itself is missing (shell convention; execFile surfaces it as ENOENT). */
export const MISSING_BINARY = 127

function exitCode(error: { code?: unknown } | null): number {
  if (!error) {
    return 0
  }

  const rawCode: unknown = error.code

  if (typeof rawCode === 'number') {
    return rawCode
  }

  return rawCode === 'ENOENT' ? MISSING_BINARY : 1
}

/** Small promise wrapper around execFile that never throws on non-zero exit. `input` goes to stdin. */
export function run(command: string, args: string[], timeoutMs = 8000, input?: string): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: exitCode(error) })
    })

    if (input !== undefined) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(input)
    }
  })
}

/** Same as `run`, but keeps stdout as raw bytes (for commands that emit images). */
export function runBuffer(command: string, args: string[], timeoutMs = 8000): Promise<ExecBufferResult> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0), stderr: stderr ? stderr.toString('utf8') : '', code: exitCode(error) })
    })
  })
}
