// Checks what `npm run pack:mac` left in release/: one Herald OS.app per architecture, every Mach-O
// file in it built for that architecture alone, and this version's DMG and zip for each. It reads
// the Mach-O headers itself, so it needs neither lipo nor a Mac of either kind.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** What the release ships, in electron-builder's names: Apple Silicon and Intel. */
export const MAC_ARCHES = ['arm64', 'x64']

const CPU_TYPES = {
  0x0100000c: 'arm64',
  0x01000007: 'x64',
  0x0200000c: 'arm64_32 (32-bit)',
  0x0000000c: 'arm (32-bit)',
  0x00000007: 'i386 (32-bit)',
  0x00000012: 'ppc (32-bit)',
  0x01000012: 'ppc64'
}

const THIN = { 0xfeedfacf: 64, 0xfeedface: 32 }

function cpuName(cpu, bits) {
  return CPU_TYPES[cpu] ?? `cputype 0x${cpu.toString(16)}${bits === 32 ? ' (32-bit)' : ''}`
}

/**
 * What a Mach-O file is built for: `{ fat, arches }`, where a universal (fat) file lists each slice.
 * null when the file is not Mach-O.
 */
export function machO(file) {
  const header = Buffer.alloc(4096)
  const fd = fs.openSync(file, 'r')
  let length = 0
  try {
    length = fs.readSync(fd, header, 0, header.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (length < 8) return null

  for (const read of ['readUInt32LE', 'readUInt32BE']) {
    const bits = THIN[header[read](0)]
    if (bits) return { fat: false, arches: [cpuName(header[read](4), bits)] }
  }

  const magic = header.readUInt32BE(0)
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return null
  const count = header.readUInt32BE(4)
  // Java class files share 0xcafebabe; their next word is a class file version (45 and up), not a slice count.
  if (count === 0 || count > 32) return null
  const size = magic === 0xcafebabe ? 20 : 32
  const arches = []
  for (let i = 0; i < count && 8 + (i + 1) * size <= length; i++) arches.push(cpuName(header.readUInt32BE(8 + i * size)))
  return { fat: true, arches }
}

function describe(info) {
  if (!info) return 'not a Mac binary'
  return info.fat ? `universal (${info.arches.join(' and ')})` : info.arches[0]
}

/** Every regular file under `dir`, relative to it. Symlinks are skipped: frameworks link to their own files. */
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full, base)
    return entry.isFile() ? [path.relative(base, full)] : []
  })
}

/**
 * The architecture a file in the app has to be built for. node-pty picks its prebuild by folder
 * name (prebuilds/<platform>-<arch>), so both apps can carry both darwin prebuilds as long as each
 * file sits in its own architecture's folder. Other platforms' prebuilds are never loaded on a Mac.
 */
function expectedArch(rel, appArch) {
  const prebuild = rel.split(path.sep).join('/').match(/\/prebuilds\/([^/]+)-([^/-]+)\//)
  if (!prebuild) return appArch
  return prebuild[1] === 'darwin' ? prebuild[2] : null
}

const NATIVE = /(\.node|\/spawn-helper)$/

/** The Herald OS.app bundles electron-builder wrote: release/mac-arm64/, release/mac/ and so on. */
function apps(releaseDir) {
  return fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(releaseDir, entry.name, 'Herald OS.app'))
    .filter(app => fs.existsSync(app))
    .sort()
}

/** Every Mach-O in `app` that is not exactly `arch`, and every native module that is not Mach-O. */
export function appProblems(app, arch, where = app) {
  const problems = []
  for (const rel of walk(app)) {
    const expected = expectedArch(rel, arch)
    const info = machO(path.join(app, rel))
    const posix = `/${rel.split(path.sep).join('/')}`
    if (!info) {
      if (expected && NATIVE.test(posix)) problems.push(`${where}: ${rel} is not a Mac binary, but node would load it on ${expected}.`)
      continue
    }
    if (!expected) continue
    if (info.fat || info.arches[0] !== expected) problems.push(`${where}: ${rel} is ${describe(info)}, not ${expected} alone.`)
  }
  return problems
}

export function macBuildProblems(releaseDir, { arches = MAC_ARCHES, version } = {}) {
  if (!version) return ['No version to check the DMG and zip names against.']
  if (!fs.existsSync(releaseDir)) return [`${releaseDir} does not exist: the app was not packaged.`]
  const problems = []
  const built = new Map()

  for (const app of apps(releaseDir)) {
    const where = path.relative(releaseDir, app)
    const executable = path.join(app, 'Contents', 'MacOS', 'Herald OS')
    const info = fs.existsSync(executable) ? machO(executable) : null
    if (!info || info.fat) {
      problems.push(`${where} is ${info ? describe(info) : 'missing its Herald OS executable'}, not exactly one of ${arches.join(', ')}.`)
      continue
    }
    const [arch] = info.arches
    if (!arches.includes(arch)) {
      problems.push(`${where} is built for ${arch}, which the release does not ship.`)
      continue
    }
    if (built.has(arch)) problems.push(`${where} and ${built.get(arch)} are both built for ${arch}.`)
    built.set(arch, where)

    const prebuild = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', `darwin-${arch}`)
    if (!fs.existsSync(path.join(prebuild, 'pty.node'))) problems.push(`${where} has no node-pty prebuild for darwin-${arch}, so its Terminal could not start.`)
    if (!fs.existsSync(path.join(prebuild, 'spawn-helper'))) problems.push(`${where} has no darwin-${arch}/spawn-helper, so its Terminal could not start a shell.`)
    problems.push(...appProblems(app, arch, where))
  }

  const expected = new Set()
  for (const arch of arches) {
    if (!built.has(arch)) problems.push(`No Herald OS.app in ${releaseDir} is built for ${arch}.`)
    for (const ext of ['dmg', 'zip']) {
      const name = `HeraldOS-${version}-mac-${arch}.${ext}`
      expected.add(name)
      if (!fs.existsSync(path.join(releaseDir, name))) problems.push(`No ${name} in ${releaseDir}.`)
    }
  }
  // The release job uploads every DMG and zip it finds, so a leftover from another version would ship.
  for (const file of fs.readdirSync(releaseDir).sort()) {
    if (/\.(dmg|zip)$/.test(file) && !expected.has(file)) problems.push(`${file} in ${releaseDir} is not this build's (${version}); it would be uploaded with it.`)
  }

  return problems
}

/** pack:mac must ask electron-builder for every architecture the release ships. */
export function packScriptProblems(scripts, arches = MAC_ARCHES) {
  const words = (scripts?.['pack:mac'] ?? '').split(/\s+/)
  return arches.filter(arch => !words.includes(`--${arch}`)).map(arch => `The pack:mac script does not build --${arch}.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { scripts, version } = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const problems = [...packScriptProblems(scripts), ...macBuildProblems(path.join(appDir, 'release'), { version })]

  for (const problem of problems) console.log(`::error::${problem}`)
  if (problems.length === 0) console.log(`release/ has a Herald OS.app, DMG and zip of ${version} for each of ${MAC_ARCHES.join(', ')}.`)
  process.exit(problems.length ? 1 : 0)
}
