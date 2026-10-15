// Checks the electron-builder mac settings that Developer ID signing and notarization depend on, and
// the release workflow steps that sign an unsigned build ad hoc and check every build's signature.
// It needs no secrets, so the release workflow runs it on every macOS build, signed or not.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { packScriptProblems } from './check-mac-builds.mjs'

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

/** The checks every macOS build must run after packing, whatever the signing secrets. */
const REQUIRED_CHECKS = ['apps/desktop/scripts/check-mac-builds.mjs', 'apps/desktop/scripts/check-mac-signatures.mjs']
const ARCH_FLAG = /(^|\s)(--(x64|arm64|universal|ia32|armv7l)\b|-c\.mac\.target\b)/

/**
 * Whether a run: block really runs `node <script>`: not in a comment, not as an echo's argument and
 * not with `|| ...` swallowing its exit code.
 */
export function invokesScript(run, script) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const call = new RegExp(`^node\\s+${escaped}(\\s|$)`)
  return (run ?? '').split('\n').some(line => {
    const code = line.replace(/(^|\s)#.*$/, '').trim()
    return call.test(code) && !code.includes('||')
  })
}

/**
 * The macOS release job must sign an unsigned build ad hoc over the whole bundle (`-c.mac.identity=-`):
 * left to the linker's signatures alone, the app has no sealed resources and macOS calls it damaged.
 * Both builds must go through pack:mac, which builds every architecture, and every build must run
 * the architecture and signature checks. With `scripts`, pack:mac itself is checked too.
 */
export function releaseWorkflowProblems(workflow, scripts) {
  const job = workflow?.jobs?.mac ?? {}
  const steps = job.steps ?? []
  const packs = steps.filter(step => /npm run pack:mac\b/.test(step.run ?? ''))
  const unsigned = packs.filter(step => /signed != 'true'/.test(step.if ?? ''))
  const signed = packs.filter(step => /signed == 'true'/.test(step.if ?? ''))
  const problems = scripts ? packScriptProblems(scripts) : []

  if (job['continue-on-error']) problems.push('The mac job has continue-on-error, so a failed check would not fail the release.')
  if (unsigned.length !== 1) problems.push('The mac job needs exactly one unsigned pack:mac step (if: steps.signing.outputs.signed != \'true\').')
  if (signed.length !== 1) problems.push('The mac job needs exactly one signed pack:mac step (if: steps.signing.outputs.signed == \'true\').')
  for (const step of unsigned) {
    if (!/(^|\s)-c\.mac\.identity=-(\s|$)/.test(step.run)) problems.push(`"${step.name}" does not pass -c.mac.identity=-, so the unsigned app would ship with no sealed resources.`)
  }
  for (const step of signed) {
    if (/-c\.mac\.identity=/.test(step.run)) problems.push(`"${step.name}" overrides mac.identity, so it would not sign with the Developer ID certificate.`)
  }
  for (const step of packs) {
    if (ARCH_FLAG.test(step.run.split(/npm run pack:mac\b/)[1] ?? '')) problems.push(`"${step.name}" passes its own architecture or target to pack:mac, so it could skip arm64 or x64.`)
  }
  for (const step of steps) {
    if (/\b(electron-builder|dist:mac)\b/.test(step.run ?? '')) problems.push(`"${step.name}" runs electron-builder without pack:mac, which builds both arm64 and x64.`)
  }

  const lastPack = Math.max(...packs.map(step => steps.indexOf(step)))
  for (const script of REQUIRED_CHECKS) {
    const index = steps.findIndex(step => invokesScript(step.run, script))
    const step = steps[index]
    if (index === -1) problems.push(`The mac job does not run node ${script}.`)
    else if (step.if) problems.push(`"${step.name}" has an if:, but every build must run it.`)
    else if (step['continue-on-error']) problems.push(`"${step.name}" has continue-on-error, so its failure would not fail the release.`)
    else if (index < lastPack) problems.push(`"${step.name}" runs before the app is packed.`)
    if (script.endsWith('check-mac-signatures.mjs') && step && !/steps\.signing\.outputs\.signed\b/.test(step.env?.HERALD_OS_MAC_SIGNED ?? '')) {
      problems.push(`"${step.name}" does not set HERALD_OS_MAC_SIGNED from steps.signing.outputs.signed, so a signed build would pass with an ad hoc signature.`)
    }
  }

  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { build, scripts } = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const workflow = YAML.parse(fs.readFileSync(workflowFile, 'utf8'))
  const problems = [
    ...macSigningProblems(build).map(problem => `::error file=apps/desktop/package.json::${problem}`),
    ...releaseWorkflowProblems(workflow, scripts).map(problem => `::error file=.github/workflows/release.yml::${problem}`)
  ]

  for (const problem of problems) console.log(problem)
  if (problems.length === 0) console.log('The mac signing config is complete.')
  process.exit(problems.length ? 1 : 0)
}
