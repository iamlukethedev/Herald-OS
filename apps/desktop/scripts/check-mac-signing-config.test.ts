import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { macSigningProblems, releaseWorkflowProblems } from './check-mac-signing-config.mjs'

const complete = { mac: { hardenedRuntime: true, entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist' } }

describe('macSigningProblems', () => {
  it('passes the shipped config', () => {
    const { build } = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

    expect(macSigningProblems(build)).toEqual([])
  })

  it('needs the hardened runtime and both entitlements files', () => {
    expect(macSigningProblems({ mac: {} }, () => true)).toEqual([
      expect.stringContaining('hardenedRuntime'),
      expect.stringContaining('mac.entitlements is not set'),
      expect.stringContaining('mac.entitlementsInherit is not set')
    ])
  })

  it('names an entitlements file that is not there', () => {
    expect(macSigningProblems(complete, file => file !== 'build/entitlements.mac.plist')).toEqual([
      expect.stringContaining('mac.entitlements points at build/entitlements.mac.plist'),
      expect.stringContaining('mac.entitlementsInherit points at build/entitlements.mac.plist')
    ])
  })

  it('rejects settings that turn signing or notarization off', () => {
    expect(macSigningProblems({ mac: { ...complete.mac, notarize: false, identity: null } }, () => true)).toEqual([
      expect.stringContaining('mac.notarize is false'),
      expect.stringContaining('mac.identity is null')
    ])
  })

  it('rejects an ad hoc identity in the shared config, which would override the Developer ID one', () => {
    expect(macSigningProblems({ mac: { ...complete.mac, identity: '-' } }, () => true)).toEqual([expect.stringContaining('mac.identity is "-"')])
  })
})

const signedIf = "steps.signing.outputs.signed == 'true'"
const unsignedIf = "steps.signing.outputs.signed != 'true'"
type Step = { name: string; if?: string; run?: string; env?: Record<string, string>; 'continue-on-error'?: boolean }
const workflow = (steps: Step[], job: Record<string, unknown> = {}) => ({ jobs: { mac: { ...job, steps } } })
const SIGNED = 0
const UNSIGNED = 1
const BUILDS = 2
const SIGNATURES = 3
const goodSteps: Step[] = [
  { name: 'Package, sign and notarize the app', if: signedIf, run: 'npm run pack:mac --workspace apps/desktop -- -c.dmg.sign=true' },
  { name: 'Package the app, signed ad hoc', if: unsignedIf, run: 'npm run pack:mac --workspace apps/desktop -- -c.mac.notarize=false -c.mac.identity=-' },
  { name: 'Check the Apple Silicon and Intel builds', run: 'node apps/desktop/scripts/check-mac-builds.mjs' },
  {
    name: 'Check the code signatures',
    env: { HERALD_OS_MAC_SIGNED: '${{ steps.signing.outputs.signed }}', APPLE_TEAM_ID: '${{ secrets.APPLE_TEAM_ID }}' },
    run: 'node apps/desktop/scripts/check-mac-signatures.mjs'
  }
]
/** goodSteps with step `index` changed by `change`. */
const withStep = (index: number, change: Partial<Step>) => goodSteps.map((step, i) => (i === index ? { ...step, ...change } : step))
const without = (index: number) => goodSteps.filter((_, i) => i !== index)
const shippedScripts = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).scripts

describe('releaseWorkflowProblems', () => {
  it('passes the shipped release workflow and pack:mac', () => {
    const shipped = YAML.parse(fs.readFileSync(fileURLToPath(new URL('../../../.github/workflows/release.yml', import.meta.url)), 'utf8'))

    expect(releaseWorkflowProblems(shipped, shippedScripts)).toEqual([])
    expect(releaseWorkflowProblems(workflow(goodSteps))).toEqual([])
  })

  it('needs the unsigned build signed ad hoc, as alpha.4 was not', () => {
    const steps = withStep(UNSIGNED, { run: 'npm run pack:mac --workspace apps/desktop -- -c.mac.notarize=false' })

    expect(releaseWorkflowProblems(workflow(steps))).toEqual([expect.stringContaining('does not pass -c.mac.identity=-')])
  })

  it('does not let the signed build override the identity', () => {
    const steps = withStep(SIGNED, { run: `${goodSteps[SIGNED].run} -c.mac.identity=-` })

    expect(releaseWorkflowProblems(workflow(steps))).toEqual([expect.stringContaining('overrides mac.identity')])
  })

  it('needs both checks on every build, after packing', () => {
    expect(releaseWorkflowProblems(workflow(without(SIGNATURES)))).toEqual(['The mac job does not run node apps/desktop/scripts/check-mac-signatures.mjs.'])
    expect(releaseWorkflowProblems(workflow(without(BUILDS)))).toEqual(['The mac job does not run node apps/desktop/scripts/check-mac-builds.mjs.'])
    expect(releaseWorkflowProblems(workflow(withStep(SIGNATURES, { if: signedIf })))).toEqual([expect.stringContaining('has an if:')])
    expect(releaseWorkflowProblems(workflow([goodSteps[SIGNATURES], ...without(SIGNATURES)]))).toEqual([expect.stringContaining('runs before the app is packed')])
  })

  it('rejects continue-on-error on a check or on the whole job', () => {
    expect(releaseWorkflowProblems(workflow(withStep(SIGNATURES, { 'continue-on-error': true })))).toEqual([
      '"Check the code signatures" has continue-on-error, so its failure would not fail the release.'
    ])
    expect(releaseWorkflowProblems(workflow(withStep(BUILDS, { 'continue-on-error': true })))).toEqual([expect.stringContaining('"Check the Apple Silicon and Intel builds" has continue-on-error')])
    expect(releaseWorkflowProblems(workflow(goodSteps, { 'continue-on-error': true }))).toEqual([expect.stringContaining('The mac job has continue-on-error')])
  })

  it.each([
    ['echoed', 'echo node apps/desktop/scripts/check-mac-signatures.mjs'],
    ['commented out', '# node apps/desktop/scripts/check-mac-signatures.mjs\ntrue'],
    ['commented out after other code', 'true # node apps/desktop/scripts/check-mac-signatures.mjs'],
    ['with its failure swallowed', 'node apps/desktop/scripts/check-mac-signatures.mjs || true'],
    ['another script with the same prefix', 'node apps/desktop/scripts/check-mac-signatures.mjs.bak']
  ])('rejects a signature check that is %s', (_name, run) => {
    expect(releaseWorkflowProblems(workflow(withStep(SIGNATURES, { run })))).toEqual(['The mac job does not run node apps/desktop/scripts/check-mac-signatures.mjs.'])
  })

  it('accepts the check on its own line in a longer run: block', () => {
    expect(releaseWorkflowProblems(workflow(withStep(SIGNATURES, { run: 'set -euo pipefail\n  node apps/desktop/scripts/check-mac-signatures.mjs  # every copy\n' })))).toEqual([])
  })

  it('reads || in a trailing comment as part of the comment', () => {
    expect(releaseWorkflowProblems(workflow(withStep(SIGNATURES, { run: 'node apps/desktop/scripts/check-mac-signatures.mjs # signed || unsigned' })))).toEqual([])
  })

  it('needs the signature check to know whether the build is signed', () => {
    expect(releaseWorkflowProblems(workflow(withStep(SIGNATURES, { env: undefined })))).toEqual([expect.stringContaining('does not set HERALD_OS_MAC_SIGNED')])
  })

  it.each(['--x64', '--arm64', '--universal', '-c.mac.target=dmg'])('rejects a pack step that passes %s, so it cannot skip an architecture', flag => {
    expect(releaseWorkflowProblems(workflow(withStep(UNSIGNED, { run: `${goodSteps[UNSIGNED].run} ${flag}` })))).toEqual([expect.stringContaining('could skip arm64 or x64')])
    expect(releaseWorkflowProblems(workflow(withStep(SIGNED, { run: `${goodSteps[SIGNED].run} ${flag}` })))).toEqual([expect.stringContaining('could skip arm64 or x64')])
  })

  it('rejects packing with electron-builder directly instead of pack:mac', () => {
    const steps = [...goodSteps, { name: 'Pack Intel', run: 'npx electron-builder --mac --x64' }]

    expect(releaseWorkflowProblems(workflow(steps))).toEqual(['"Pack Intel" runs electron-builder without pack:mac, which builds both arm64 and x64.'])
  })

  it('rejects a pack:mac script that builds only one architecture', () => {
    expect(releaseWorkflowProblems(workflow(goodSteps), { 'pack:mac': 'electron-builder --mac --x64 --publish never' })).toEqual(['The pack:mac script does not build --arm64.'])
    expect(releaseWorkflowProblems(workflow(goodSteps), { 'pack:mac': 'electron-builder --mac --arm64 --publish never' })).toEqual(['The pack:mac script does not build --x64.'])
  })

  it('needs exactly one unsigned and one signed pack step', () => {
    expect(releaseWorkflowProblems(workflow(without(UNSIGNED)))).toEqual([expect.stringContaining('exactly one unsigned pack:mac step')])
    expect(releaseWorkflowProblems(workflow(without(SIGNED)))).toEqual([expect.stringContaining('exactly one signed pack:mac step')])
  })
})
