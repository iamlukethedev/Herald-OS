// Checks the electron-builder mac settings that Developer ID signing and notarization depend on.
// It needs no secrets, so the release workflow runs it on every macOS build, signed or not.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function macSigningProblems(build, exists = file => fs.existsSync(path.join(appDir, file))) {
  const mac = build?.mac ?? {}
  const problems = []

  if (mac.hardenedRuntime !== true) problems.push('mac.hardenedRuntime must be true: Apple only notarizes apps with the hardened runtime.')
  if (mac.notarize === false) problems.push('mac.notarize is false, so signed builds would never be notarized.')
  if (mac.identity === null) problems.push('mac.identity is null, so builds would never be signed.')

  for (const key of ['entitlements', 'entitlementsInherit']) {
    if (!mac[key]) problems.push(`mac.${key} is not set.`)
    else if (!exists(mac[key])) problems.push(`mac.${key} points at ${mac[key]}, which does not exist.`)
  }

  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { build } = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const problems = macSigningProblems(build)

  for (const problem of problems) console.log(`::error file=apps/desktop/package.json::${problem}`)
  if (problems.length === 0) console.log('The mac signing config is complete.')
  process.exit(problems.length ? 1 : 0)
}
