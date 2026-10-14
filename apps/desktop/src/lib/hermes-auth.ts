// Pure helpers for the model-provider sign-in (no DOM): shared by the store and its tests.

const AUTH_ERROR = /access token|logged out|not logged in|login|relogin|Nous Portal|oauth|unauthori[sz]ed|\b401\b|invalid_grant|refresh session/i

/** True when a turn failed because the model provider needs the user to sign in. */
export function isAuthErrorText(text: string | undefined | null): boolean {
  return Boolean(text && AUTH_ERROR.test(text))
}

/** `model.provider` from the raw YAML; the schema view flattens `model` to a string. */
export function parseActiveProvider(yaml: string): string | null {
  const block = /^model:\s*\n((?:[ \t]+.*\n?)*)/m.exec(yaml)
  const match = block ? /^[ \t]+provider:\s*['"]?([\w.-]+)['"]?/m.exec(block[1]) : null

  return match?.[1] ?? null
}

/**
 * The provider the sign-in card signs into: one the person picked, else the active one. With no
 * provider set yet (`auto` resolves one itself) it is the first that signs in with a code; when
 * the active provider takes an API key there is nothing to sign in to.
 */
export function signInTarget<P extends { id: string; flow: string }>(providers: readonly P[], activeProvider: string | null, chosen: string | null): P | null {
  const byId = (id: string) => providers.find(provider => provider.id === id) ?? null

  if (chosen) {
    return byId(chosen)
  }

  if (activeProvider && activeProvider !== 'auto') {
    return byId(activeProvider)
  }

  return providers.find(provider => provider.flow === 'device_code') ?? null
}
