import crypto from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type CompManifest, LIMITS, parseManifestText, referencedAssets, serializeManifest } from '../../shared/canvas/comp-format.ts'
import { encodePng } from './png.ts'

/*
 * Reading and writing `.comp` packages. Paths arrive already checked (see ipc.ts). Writes follow the
 * format's rule for a project someone may have open: images first, then the manifest through a
 * temporary file and a rename, so a reader sees the old manifest or the new one, never half of one.
 */

/** Project files are named after their layer: `<UUID>.png` and `<UUID>.mask.png`, and a Color Lookup layer's table `<UUID>.cube`. */
export const ASSET_NAME = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}((\.mask)?\.png|\.cube)$/

export interface RawImage {
  width: number
  height: number
  /** 4 for a layer (RGBA), 1 for a mask (grayscale). */
  channels: 1 | 4
  data: Uint8Array
}

export interface PackageContents {
  manifest: CompManifest
  /** Referenced image names and their sizes in bytes. */
  assets: Record<string, number>
  digest: string
}

/** Identifies a project's state from its manifest and each image's name and size (not file times). */
export function digestOf(manifestText: string, assets: Record<string, number>): string {
  const hash = crypto.createHash('sha256').update(manifestText)

  for (const name of Object.keys(assets).sort()) {
    hash.update(`\n${name}:${assets[name]}`)
  }

  return hash.digest('hex').slice(0, 32)
}

async function readManifestText(dir: string): Promise<string> {
  const file = path.join(dir, 'manifest.json')
  const stat = await fs.lstat(file).catch(() => null)

  if (!stat?.isFile()) {
    throw new Error(`${path.basename(dir)} has no manifest.json`)
  }

  if (stat.size > LIMITS.manifestBytes) {
    throw new Error('manifest.json is too large')
  }

  return fs.readFile(file, 'utf8')
}

async function assetSizes(dir: string, manifest: CompManifest): Promise<Record<string, number>> {
  const assets: Record<string, number> = {}

  for (const name of referencedAssets(manifest)) {
    // lstat: an image that is a link could point anywhere on the disk.
    const stat = await fs.lstat(path.join(dir, 'images', name)).catch(() => null)

    if (!stat?.isFile()) {
      throw new Error(`${name} is missing from the project`)
    }

    if (stat.size > LIMITS.assetBytes) {
      throw new Error(`${name} is too large`)
    }

    assets[name] = stat.size
  }

  return assets
}

export async function readPackage(dir: string): Promise<PackageContents> {
  const text = await readManifestText(dir)
  const manifest = parseManifestText(text)
  const assets = await assetSizes(dir, manifest)

  return { manifest, assets, digest: digestOf(text, assets) }
}

export async function readAsset(dir: string, name: string): Promise<Uint8Array> {
  if (!ASSET_NAME.test(name)) {
    throw new Error(`${name} is not a project file`)
  }

  const file = path.join(dir, 'images', name)
  const stat = await fs.lstat(file)

  if (!stat.isFile() || stat.size > LIMITS.assetBytes) {
    throw new Error(`${name} cannot be read`)
  }

  return new Uint8Array(await fs.readFile(file))
}

async function atomicWrite(file: string, data: Uint8Array | string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp`)
  await fs.writeFile(temporary, data)
  await fs.rename(temporary, file)
}

export interface WriteRequest {
  manifest: CompManifest
  /** Images to (re)write, by name; the others already on disk are kept. */
  assets: Record<string, RawImage | Uint8Array>
  /** Finder's preview of the project (JPEG); without one, the stale preview is removed. */
  preview?: Uint8Array
}

/** Write a project (creating it if needed) and return its new digest. */
export async function writePackage(dir: string, request: WriteRequest): Promise<string> {
  // serializeManifest re-validates: a manifest that would not load again is never written.
  const text = serializeManifest(request.manifest)
  const manifest = parseManifestText(text)
  const referenced = referencedAssets(manifest)
  const images = path.join(dir, 'images')
  await fs.mkdir(images, { recursive: true })

  for (const [name, image] of Object.entries(request.assets)) {
    if (!ASSET_NAME.test(name) || !referenced.has(name)) {
      throw new Error(`${name} is not part of this project`)
    }

    if (name.endsWith('.cube')) {
      if (!(image instanceof Uint8Array)) {
        throw new Error(`${name} is a colour table: it is written as the file's bytes`)
      }
    } else if (!(image instanceof Uint8Array)) {
      const isMask = name.endsWith('.mask.png')

      if (image.channels !== (isMask ? 1 : 4)) {
        throw new Error(`${name} must be ${isMask ? 'grayscale' : 'RGBA'}`)
      }
    }

    await atomicWrite(path.join(images, name), image instanceof Uint8Array ? image : encodePng(image))
  }

  // Every image the manifest names must be in place before the manifest goes in.
  const assets = await assetSizes(dir, manifest)
  await atomicWrite(path.join(dir, 'manifest.json'), text)

  // Images the manifest no longer names go once it is replaced.
  for (const entry of await fs.readdir(images)) {
    if (ASSET_NAME.test(entry) && !referenced.has(entry)) {
      await fs.rm(path.join(images, entry), { force: true })
    }
  }

  const quickLook = path.join(dir, 'QuickLook')

  if (request.preview) {
    await fs.mkdir(quickLook, { recursive: true })
    await atomicWrite(path.join(quickLook, 'Preview.jpg'), request.preview)
  } else {
    await fs.rm(quickLook, { recursive: true, force: true })
  }

  return digestOf(text, assets)
}

/**
 * Watches an open project for changes made elsewhere (Hermes, a script, Compositor). Fires about a
 * third of a second after writes stop, only when the project's digest moved, and ignores a state
 * that does not load, so a half-written project shows once it is complete.
 */
export class PackageWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private poll: NodeJS.Timeout | null = null
  private timer: NodeJS.Timeout | null = null
  private known: string
  private stamp = ''
  private writing = 0
  private running = false

  constructor(
    private readonly dir: string,
    digest: string,
    private readonly onChange: (contents: PackageContents) => void,
    private readonly delayMs = 350,
    private readonly pollMs = 2000
  ) {
    this.known = digest
  }

  start(): void {
    this.running = true
    this.watchFolders()
    void this.manifestStamp().then(stamp => {
      this.stamp ||= stamp
    })
    // Some file systems (network shares, some containers) report no events: the manifest's time and size still move.
    this.poll = setInterval(() => void this.probe(), this.pollMs)
    this.poll.unref()
    // A folder watch reports nothing until the system has set it up (on macOS, a moment after `watch` returns):
    // one check after starting finds what changed before then.
    this.schedule()
  }

  /**
   * Each folder is watched on its own rather than recursively: on Linux a recursive watch follows
   * files, so once a save renames a new manifest.json over the old one, later writes to it go
   * unreported. A folder's watch sees every change to its entries, renames included.
   */
  private watchFolders(): void {
    for (const folder of [this.dir, path.join(this.dir, 'images')]) {
      if (this.watchers.has(folder)) {
        continue
      }

      try {
        const watcher = watch(folder, () => this.schedule())
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(folder)
        })
        this.watchers.set(folder, watcher)
      } catch {
        // No images folder yet: it is watched from the check that its creation schedules.
      }
    }
  }

  private async manifestStamp(): Promise<string> {
    const stat = await fs.stat(path.join(this.dir, 'manifest.json')).catch(() => null)

    return stat ? `${stat.mtimeMs}:${stat.size}` : ''
  }

  private async probe(): Promise<void> {
    const stamp = await this.manifestStamp()

    if (stamp !== this.stamp) {
      this.stamp = stamp
      this.schedule()
    }
  }

  /** Herald's own save: checks wait while it writes, and its result is not an outside change. */
  async ownWrite(write: () => Promise<string>): Promise<string> {
    this.writing++

    try {
      const digest = await write()
      this.known = digest

      return digest
    } finally {
      this.writing--
    }
  }

  stop(): void {
    this.running = false

    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()

    if (this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    if (!this.running) {
      return
    }

    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.check()
    }, this.delayMs)
  }

  async check(): Promise<void> {
    if (this.writing) {
      this.schedule()

      return
    }

    if (this.running) {
      this.watchFolders()
    }

    try {
      const contents = await readPackage(this.dir)

      if (this.running && contents.digest !== this.known) {
        this.known = contents.digest
        this.onChange(contents)
      }
    } catch {
      // Not loadable yet (mid-write or broken): wait for the next change.
    }
  }
}
