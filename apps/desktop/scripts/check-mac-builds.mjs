// Checks what `npm run pack:mac` left in release/: one Herald OS.app, DMG and zip per architecture,
// each app built for its own architecture and carrying node-pty's prebuild for it. It reads the
// Mach-O headers itself, so it needs neither lipo nor a Mac of either kind.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** What the release ships, in electron-builder's names: Apple Silicon and Intel. */
export const MAC_ARCHES = ['arm64', 'x64']

const CPU_TYPES = { 0x0100000c: 'arm64', 0x01000007: 'x64' }

/** The architectures a Mach-O file is built for, [] when it is not one. Universal files list each. */
export function machoArches(file) {
  const header = Buffer.alloc(4096)
  const fd = fs.openSync(file, 'r')
  let length = 0
  try {
    length = fs.readSync(fd, header, 0, header.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (length < 8) return []
  const name = cpu => CPU_TYPES[cpu] ?? `cputype 0x${cpu.toString(16)}`

  if (header.readUInt32LE(0) === 0xfeedfacf) return [name(header.readUInt32LE(4))]

  const fat = header.readUInt32BE(0)
  if (fat !== 0xcafebabe && fat !== 0xcafebabf) return []
  const count = header.readUInt32BE(4)
  const size = fat === 0xcafebabe ? 20 : 32
  const arches = []
  for (let i = 0; i < count && 8 + (i + 1) * size <= length; i++) arches.push(name(header.readUInt32BE(8 + i * size)))
  return arches
}

/** The Herald OS.app bundles electron-builder wrote: release/mac-arm64/, release/mac/ and so on. */
function apps(releaseDir) {
  return fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(releaseDir, entry.name, 'Herald OS.app'))
    .filter(app => fs.existsSync(app))
    .sort()
}

export function macBuildProblems(releaseDir, arches = MAC_ARCHES) {
  if (!fs.existsSync(releaseDir)) return [`${releaseDir} does not exist: the app was not packaged.`]
  const problems = []
  const built = new Map()

  for (const app of apps(releaseDir)) {
    const where = path.relative(releaseDir, app)
    const executable = path.join(app, 'Contents', 'MacOS', 'Herald OS')
    const found = fs.existsSync(executable) ? machoArches(executable) : []
    if (found.length !== 1) {
      problems.push(`${where} is built for ${found.join(' and ') || 'no Mac architecture'}, not exactly one of ${arches.join(', ')}.`)
      continue
    }
    const [arch] = found
    if (!arches.includes(arch)) {
      problems.push(`${where} is built for ${arch}, which the release does not ship.`)
      continue
    }
    if (built.has(arch)) problems.push(`${where} and ${built.get(arch)} are both built for ${arch}.`)
    built.set(arch, where)

    const prebuild = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', `darwin-${arch}`)
    const pty = path.join(prebuild, 'pty.node')
    if (!fs.existsSync(pty)) problems.push(`${where} has no node-pty prebuild for darwin-${arch}, so its Terminal could not start.`)
    else if (!machoArches(pty).includes(arch)) problems.push(`${where} carries a darwin-${arch}/pty.node built for ${machoArches(pty).join(' and ') || 'no Mac architecture'}.`)
    if (!fs.existsSync(path.join(prebuild, 'spawn-helper'))) problems.push(`${where} has no darwin-${arch}/spawn-helper, so its Terminal could not start a shell.`)
  }

  const files = fs.readdirSync(releaseDir)
  for (const arch of arches) {
    if (!built.has(arch)) problems.push(`No Herald OS.app in ${releaseDir} is built for ${arch}.`)
    for (const ext of ['dmg', 'zip']) {
      if (!files.some(file => file.startsWith('HeraldOS-') && file.endsWith(`-mac-${arch}.${ext}`))) problems.push(`No HeraldOS-<version>-mac-${arch}.${ext} in ${releaseDir}.`)
    }
  }

  return problems
}

/** pack:mac must ask electron-builder for every architecture the release ships. */
export function packScriptProblems(scripts, arches = MAC_ARCHES) {
  const words = (scripts?.['pack:mac'] ?? '').split(/\s+/)
  return arches.filter(arch => !words.includes(`--${arch}`)).map(arch => `The pack:mac script does not build --${arch}.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const problems = [...packScriptProblems(scripts), ...macBuildProblems(path.join(appDir, 'release'))]

  for (const problem of problems) console.log(`::error::${problem}`)
  if (problems.length === 0) console.log(`release/ has a Herald OS.app, DMG and zip for each of ${MAC_ARCHES.join(', ')}.`)
  process.exit(problems.length ? 1 : 0)
}
