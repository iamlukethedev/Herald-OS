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
const workflow = (steps: { name: string; if?: string; run?: string }[]) => ({ jobs: { mac: { steps } } })
const goodSteps = [
  { name: 'Package, sign and notarize the app', if: signedIf, run: 'npm run pack:mac --workspace apps/desktop -- -c.dmg.sign=true' },
  { name: 'Package the app, signed ad hoc', if: unsignedIf, run: 'npm run pack:mac --workspace apps/desktop -- -c.mac.notarize=false -c.mac.identity=-' },
  { name: 'Check the code signatures', run: 'node apps/desktop/scripts/check-mac-signatures.mjs' }
]

describe('releaseWorkflowProblems', () => {
  it('passes the shipped release workflow', () => {
    const shipped = YAML.parse(fs.readFileSync(fileURLToPath(new URL('../../../.github/workflows/release.yml', import.meta.url)), 'utf8'))

    expect(releaseWorkflowProblems(shipped)).toEqual([])
    expect(releaseWorkflowProblems(workflow(goodSteps))).toEqual([])
  })

  it('needs the unsigned build signed ad hoc, as alpha.4 was not', () => {
    const steps = goodSteps.map(step => (step.if === unsignedIf ? { ...step, run: 'npm run pack:mac --workspace apps/desktop -- -c.mac.notarize=false' } : step))

    expect(releaseWorkflowProblems(workflow(steps))).toEqual([expect.stringContaining('does not pass -c.mac.identity=-')])
  })

  it('does not let the signed build override the identity', () => {
    const steps = goodSteps.map(step => (step.if === signedIf ? { ...step, run: `${step.run} -c.mac.identity=-` } : step))

    expect(releaseWorkflowProblems(workflow(steps))).toEqual([expect.stringContaining('overrides mac.identity')])
  })

  it('needs the signature check on every build, after packing', () => {
    expect(releaseWorkflowProblems(workflow(goodSteps.slice(0, 2)))).toEqual(['The mac job does not run apps/desktop/scripts/check-mac-signatures.mjs.'])
    expect(releaseWorkflowProblems(workflow([...goodSteps.slice(0, 2), { ...goodSteps[2], if: signedIf }]))).toEqual([expect.stringContaining('has an if:')])
    expect(releaseWorkflowProblems(workflow([goodSteps[2], ...goodSteps.slice(0, 2)]))).toEqual([expect.stringContaining('runs before the app is packed')])
  })

  it('needs exactly one unsigned pack step', () => {
    expect(releaseWorkflowProblems(workflow([goodSteps[0], goodSteps[2]]))).toEqual([expect.stringContaining('exactly one unsigned pack:mac step')])
  })
})
