import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { macSigningProblems } from './check-mac-signing-config.mjs'

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
})
