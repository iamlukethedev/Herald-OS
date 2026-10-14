// electron-builder afterPack hook, run before the app is signed.
import fs from 'node:fs'
import path from 'node:path'

/**
 * The spawn-helpers under node-pty's folder in app.asar.unpacked: one it compiled, one per prebuild.
 * node-pty starts every macOS shell through the one beside the pty.node it loads, its npm tarball
 * ships them without the execute bit, and electron-builder copies a file's mode as it finds it.
 */
export function spawnHelpers(ptyRoot) {
  const prebuilds = path.join(ptyRoot, 'prebuilds')
  const dirs = [path.join(ptyRoot, 'build', 'Release'), ...(fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds).map(name => path.join(prebuilds, name)) : [])]

  return dirs.map(dir => path.join(dir, 'spawn-helper')).filter(file => fs.existsSync(file))
}

export default async function afterPack({ appOutDir, packager, electronPlatformName }) {
  const ptyRoot = path.join(packager.getResourcesDir(appOutDir), 'app.asar.unpacked', 'node_modules', 'node-pty')
  const helpers = spawnHelpers(ptyRoot)

  for (const helper of helpers) {
    fs.chmodSync(helper, fs.statSync(helper).mode | 0o755)
  }

  if (electronPlatformName === 'darwin' && helpers.length === 0) {
    throw new Error(`node-pty's spawn-helper is not in ${ptyRoot}, so the Terminal could not start a shell`)
  }
}
