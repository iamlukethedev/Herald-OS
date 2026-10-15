// Checks that every Herald OS.app the release ships, as packed and inside each zip and DMG, has a
// signature over the whole bundle that codesign accepts. Apple Silicon Macs report an app whose
// binaries carry only the linker's ad hoc signatures (no sealed resources) as "damaged" once it has
// been downloaded. Needs macOS (codesign, ditto, hdiutil); runs on signed and unsigned builds.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = 'Herald OS.app'

/**
 * What is wrong with one app's signature, from `codesign --verify --deep --strict` (`verify`, its
 * exit status and output) and `codesign --display --verbose=4` (`details`, which codesign prints on stderr).
 */
export function signatureProblems(where, { verify, details }, { identifier }) {
  const problems = []
  if (verify.status !== 0) problems.push(`${where} fails codesign --verify --deep --strict: ${verify.output.trim() || `exit ${verify.status}`}`)

  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(details)?.[1].split(',') ?? []
  if (!/^CodeDirectory /m.test(details)) problems.push(`${where} is not signed.`)
  else if (flags.includes('linker-signed')) problems.push(`${where} has only the linker's ad hoc signature, not one over the bundle.`)

  if (!/^Sealed Resources version=/m.test(details)) problems.push(`${where} has no sealed resources (no Contents/_CodeSignature/CodeResources).`)
  if (!/^Info\.plist entries=/m.test(details)) problems.push(`${where} does not bind its Info.plist to the signature.`)
  const signed = /^Identifier=(.*)$/m.exec(details)?.[1]
  if (signed !== identifier) problems.push(`${where} is signed as ${signed ?? 'nothing'}, not ${identifier}.`)

  return problems
}

/** The apps electron-builder left in release/ (one folder per architecture), then its zips and DMGs. */
export function releaseBundles(releaseDir) {
  if (!fs.existsSync(releaseDir)) return { apps: [], zips: [], dmgs: [] }
  const entries = fs.readdirSync(releaseDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  return {
    apps: entries.filter(e => e.isDirectory() && fs.existsSync(path.join(releaseDir, e.name, APP))).map(e => path.join(releaseDir, e.name, APP)),
    zips: entries.filter(e => e.isFile() && e.name.endsWith('.zip')).map(e => path.join(releaseDir, e.name)),
    dmgs: entries.filter(e => e.isFile() && e.name.endsWith('.dmg')).map(e => path.join(releaseDir, e.name))
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function checkApp(app, where, options) {
  if (!fs.existsSync(app)) return [`${where} is missing.`]
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const details = run('codesign', ['--display', '--verbose=4', app]).output
  return signatureProblems(where, { verify, details }, options)
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('::error::check-mac-signatures.mjs needs macOS: it runs codesign, ditto and hdiutil.')
    return 1
  }
  const { build } = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const options = { identifier: build.appId }
  const releaseDir = path.join(appDir, 'release')
  const { apps, zips, dmgs } = releaseBundles(releaseDir)
  const problems = []
  let checked = 0

  if (apps.length === 0) problems.push(`No ${APP} under ${releaseDir}.`)
  for (const app of apps) {
    problems.push(...checkApp(app, path.relative(releaseDir, app), options))
    checked++
  }

  for (const zip of zips) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-zip-'))
    try {
      const unzip = run('ditto', ['-x', '-k', zip, dir])
      if (unzip.status !== 0) problems.push(`${path.basename(zip)} does not unpack: ${unzip.output.trim()}`)
      else problems.push(...checkApp(path.join(dir, APP), `${path.basename(zip)}: ${APP}`, options))
      checked++
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  for (const dmg of dmgs) {
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-dmg-'))
    const attach = run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg])
    if (attach.status !== 0) {
      problems.push(`${path.basename(dmg)} does not mount: ${attach.output.trim()}`)
      continue
    }
    try {
      problems.push(...checkApp(path.join(mount, APP), `${path.basename(dmg)}: ${APP}`, options))
      checked++
    } finally {
      run('hdiutil', ['detach', mount, '-force'])
    }
  }

  for (const problem of problems) console.log(`::error::${problem}`)
  if (problems.length === 0) console.log(`All ${checked} copies of ${APP} (packed, in each zip and in each DMG) have a valid signature with sealed resources.`)
  return problems.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main())
