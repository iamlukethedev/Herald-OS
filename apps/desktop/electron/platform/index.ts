import { DarwinPlatform } from './darwin.ts'
import { GenericPlatform } from './generic.ts'
import { LinuxPlatform } from './linux.ts'
import type { HostPlatform } from './types.ts'
import { WindowsPlatform } from './win32.ts'

let instance: HostPlatform | null = null

function createPlatform(): HostPlatform {
  switch (process.platform) {
    case 'darwin':
      return new DarwinPlatform()
    case 'linux':
      return new LinuxPlatform()
    case 'win32':
      return new WindowsPlatform()
    default:
      return new GenericPlatform()
  }
}

export function hostPlatform(): HostPlatform {
  if (!instance) {
    instance = createPlatform()
  }

  return instance
}

export type { EditorTarget, HostPlatform } from './types.ts'
