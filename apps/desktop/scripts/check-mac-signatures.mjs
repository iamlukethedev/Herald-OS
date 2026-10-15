// Checks that every Herald OS.app the release ships, as packed and inside each zip and DMG, has a
// signature over the whole bundle that codesign accepts, and so does each helper app and framework
// in it. Apple Silicon Macs report an app whose binaries carry only the linker's ad hoc signatures
// (no sealed resources) as "damaged" once it has been downloaded. Needs macOS (codesign, ditto,
// hdiutil); runs on signed and unsigned builds.
//
// HERALD_OS_MAC_SIGNED=true says the build should carry the Developer ID signature: an ad hoc one
// then fails, and with APPLE_TEAM_ID set the TeamIdentifier must match it. Otherwise both are ignored.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = 'Herald OS.app'

export const VERIFY_ARGS = ['--verify', '--deep', '--strict', '--verbose=2']
export const DISPLAY_ARGS = ['--display', '--verbose=4']

/**
 * What is wrong with one bundle's signature, from `codesign --verify --deep --strict` (`verify`, its
 * exit status and output) and `codesign --display --verbose=4` (`details`, which codesign prints on
 * stderr). With no `identifier`, any identifier passes (the helpers and frameworks have their own).
 */
export function signatureProblems(where, { verify, details }, { identifier, signed = false, teamId } = {}) {
  const problems = []
  if (verify.status !== 0) problems.push(`${where} fails codesign --verify --deep --strict: ${verify.output.trim() || `exit ${verify.status}`}`)

  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(details)?.[1].split(',') ?? []
  if (!/^CodeDirectory /m.test(details)) problems.push(`${where} is not signed.`)
  else if (flags.includes('linker-signed')) problems.push(`${where} has only the linker's ad hoc signature, not one over the bundle.`)

  if (!/^Sealed Resources version=/m.test(details)) problems.push(`${where} has no sealed resources (no _CodeSignature/CodeResources).`)
  if (!/^Info\.plist entries=/m.test(details)) problems.push(`${where} does not bind its Info.plist to the signature.`)
  const signedAs = /^Identifier=(.*)$/m.exec(details)?.[1]
  if (identifier !== undefined && signedAs !== identifier) problems.push(`${where} is signed as ${signedAs ?? 'nothing'}, not ${identifier}.`)

  if (signed) {
    if (/^Signature=adhoc$/m.test(details)) problems.push(`${where} is signed ad hoc, but this build should carry the Developer ID signature.`)
    const team = /^TeamIdentifier=(.*)$/m.exec(details)?.[1]
    if (teamId && team !== teamId) problems.push(`${where} has TeamIdentifier ${team ?? 'unset'}, not ${teamId}.`)
  }

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

/** electron-builder makes a zip and a DMG of each app, so fewer of either means one was not built. */
export function bundleCountProblems({ apps, zips, dmgs }, releaseDir) {
  const problems = []
  if (apps.length === 0) problems.push(`No ${APP} under ${releaseDir}.`)
  for (const [kind, files] of [['zip', zips], ['DMG', dmgs]]) {
    if (files.length < apps.length) problems.push(`${releaseDir} has ${files.length} ${kind}(s) for ${apps.length} app(s): each app needs its own ${kind}.`)
  }
  return problems
}

/** The helper apps and frameworks in an app's Contents/Frameworks, each signed on its own. */
export function nestedBundles(app) {
  const frameworks = path.join(app, 'Contents', 'Frameworks')
  if (!fs.existsSync(frameworks)) return []
  return fs
    .readdirSync(frameworks)
    .filter(name => name.endsWith('.app') || name.endsWith('.framework'))
    .sort()
    .map(name => path.join(frameworks, name))
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function checkBundle(bundle, where, options, exec) {
  const verify = exec('codesign', [...VERIFY_ARGS, bundle])
  const details = exec('codesign', [...DISPLAY_ARGS, bundle]).output
  return signatureProblems(where, { verify, details }, options)
}

/** The app's own signature, then each helper app's and framework's. */
export function checkApp(app, where, options, exec = run) {
  if (!fs.existsSync(app)) return [`${where} is missing.`]
  const problems = checkBundle(app, where, options, exec)
  for (const nested of nestedBundles(app)) {
    problems.push(...checkBundle(nested, `${where}: ${path.relative(app, nested)}`, { ...options, identifier: undefined }, exec))
  }
  return problems
}

/** Mounts `dmg` read-only, checks the app in it, then detaches it and removes the mount folder. */
export function checkDmg(dmg, options, { exec = run, check = checkApp, tmpdir = os.tmpdir() } = {}) {
  const name = path.basename(dmg)
  const mount = fs.mkdtempSync(path.join(tmpdir, 'herald-dmg-'))
  try {
    const attach = exec('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg])
    if (attach.status !== 0) return { checked: false, problems: [`${name} does not mount: ${attach.output.trim()}`] }
    try {
      return { checked: true, problems: check(path.join(mount, APP), `${name}: ${APP}`, options, exec) }
    } finally {
      exec('hdiutil', ['detach', mount, '-force'])
    }
  } finally {
    // Not recursive: if the detach failed, this must not delete anything inside the mounted DMG.
    try {
      fs.rmdirSync(mount)
    } catch {}
  }
}

function readBuild() {
  return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).build
}

/** Checks every copy of the app in `releaseDir`; returns the exit code. */
export function main({
  platform = process.platform,
  exec = run,
  log = console.log,
  releaseDir = path.join(appDir, 'release'),
  build = readBuild(),
  env = process.env,
  tmpdir = os.tmpdir()
} = {}) {
  if (platform !== 'darwin') {
    log('::error::check-mac-signatures.mjs needs macOS: it runs codesign, ditto and hdiutil.')
    return 1
  }
  const signed = env.HERALD_OS_MAC_SIGNED === 'true'
  const options = { identifier: build.appId, signed, teamId: signed ? env.APPLE_TEAM_ID || undefined : undefined }
  const { apps, zips, dmgs } = releaseBundles(releaseDir)
  const problems = bundleCountProblems({ apps, zips, dmgs }, releaseDir)
  let checked = 0

  for (const app of apps) {
    problems.push(...checkApp(app, path.relative(releaseDir, app), options, exec))
    checked++
  }

  for (const zip of zips) {
    const dir = fs.mkdtempSync(path.join(tmpdir, 'herald-zip-'))
    try {
      const unzip = exec('ditto', ['-x', '-k', zip, dir])
      if (unzip.status !== 0) problems.push(`${path.basename(zip)} does not unpack: ${unzip.output.trim()}`)
      else {
        problems.push(...checkApp(path.join(dir, APP), `${path.basename(zip)}: ${APP}`, options, exec))
        checked++
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  for (const dmg of dmgs) {
    const result = checkDmg(dmg, options, { exec, tmpdir })
    problems.push(...result.problems)
    if (result.checked) checked++
  }

  for (const problem of problems) log(`::error::${problem}`)
  if (problems.length === 0) log(`All ${checked} copies of ${APP} (packed, in each zip and in each DMG) and their helpers have a valid signature with sealed resources.`)
  return problems.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main())
