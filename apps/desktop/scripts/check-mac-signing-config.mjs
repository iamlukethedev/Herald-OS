// Checks the electron-builder mac settings that Developer ID signing and notarization depend on, and
// the release workflow steps that sign an unsigned build ad hoc and check every build's signature.
// It needs no secrets, so the release workflow runs it on every macOS build, signed or not.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflowFile = path.resolve(appDir, '..', '..', '.github', 'workflows', 'release.yml')

export function macSigningProblems(build, exists = file => fs.existsSync(path.join(appDir, file))) {
  const mac = build?.mac ?? {}
  const problems = []

  if (mac.hardenedRuntime !== true) problems.push('mac.hardenedRuntime must be true: Apple only notarizes apps with the hardened runtime.')
  if (mac.notarize === false) problems.push('mac.notarize is false, so signed builds would never be notarized.')
  if (mac.identity === null) problems.push('mac.identity is null, so builds would never be signed.')
  if (mac.identity === '-') problems.push('mac.identity is "-", so even builds with a Developer ID certificate would be signed ad hoc.')

  for (const key of ['entitlements', 'entitlementsInherit']) {
    if (!mac[key]) problems.push(`mac.${key} is not set.`)
    else if (!exists(mac[key])) problems.push(`mac.${key} points at ${mac[key]}, which does not exist.`)
  }

  return problems
}

/**
 * The macOS release job must sign an unsigned build ad hoc over the whole bundle (`-c.mac.identity=-`):
 * left to the linker's signatures alone, the app has no sealed resources and macOS calls it damaged.
 * And it must check every build's signature, signed or not.
 */
export function releaseWorkflowProblems(workflow) {
  const steps = workflow?.jobs?.mac?.steps ?? []
  const packs = steps.filter(step => /npm run pack:mac\b/.test(step.run ?? ''))
  const unsigned = packs.filter(step => /signed != 'true'/.test(step.if ?? ''))
  const signed = packs.filter(step => /signed == 'true'/.test(step.if ?? ''))
  const problems = []

  if (unsigned.length !== 1) problems.push('The mac job needs exactly one unsigned pack:mac step (if: steps.signing.outputs.signed != \'true\').')
  for (const step of unsigned) {
    if (!/(^|\s)-c\.mac\.identity=-(\s|$)/.test(step.run)) problems.push(`"${step.name}" does not pass -c.mac.identity=-, so the unsigned app would ship with no sealed resources.`)
  }
  for (const step of signed) {
    if (/-c\.mac\.identity=/.test(step.run)) problems.push(`"${step.name}" overrides mac.identity, so it would not sign with the Developer ID certificate.`)
  }

  const lastPack = Math.max(...packs.map(step => steps.indexOf(step)))
  const check = steps.findIndex(step => /scripts\/check-mac-signatures\.mjs\b/.test(step.run ?? ''))
  if (check === -1) problems.push('The mac job does not run apps/desktop/scripts/check-mac-signatures.mjs.')
  else if (steps[check].if) problems.push(`"${steps[check].name}" has an if:, but it must check every build's signature.`)
  else if (check < lastPack) problems.push(`"${steps[check].name}" runs before the app is packed.`)

  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { build } = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const workflow = YAML.parse(fs.readFileSync(workflowFile, 'utf8'))
  const problems = [
    ...macSigningProblems(build).map(problem => `::error file=apps/desktop/package.json::${problem}`),
    ...releaseWorkflowProblems(workflow).map(problem => `::error file=.github/workflows/release.yml::${problem}`)
  ]

  for (const problem of problems) console.log(problem)
  if (problems.length === 0) console.log('The mac signing config is complete.')
  process.exit(problems.length ? 1 : 0)
}
