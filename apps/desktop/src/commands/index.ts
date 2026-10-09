import { defineCommands, type OsCommand } from '../store/os-commands.ts'
import { automationCommands } from './automations.ts'
import { canvasCommands } from './canvas.ts'
import { captureCommands } from './capture.ts'
import { connectionCommands } from './connections.ts'
import { continuityCommands } from './continuity.ts'
import { controlCommands } from './controls.ts'
import { crashCommands } from './crash.ts'
import { docsCommands } from './docs.ts'
import { editCommands } from './edit.ts'
import { filesCommands } from './files.ts'
import { hermesCommands } from './hermes.ts'
import { memoryCommands } from './memory.ts'
import { navigationCommands } from './navigation.ts'
import { officeCommands } from './office.ts'
import { openCommands } from './open.ts'
import { studioCommands } from './studio.ts'
import { screenCommands } from './screen.ts'
import { sheetsCommands } from './sheets.ts'
import { slidesCommands } from './slides.ts'
import { switchCommands } from './switches.ts'
import { systemCommands } from './system.ts'
import { themeCommands } from './themes.ts'
import { brandingCommands } from './branding.ts'
import { menuBarCommands } from './menubar.ts'
import { pluginCommands } from './plugins.ts'
import { softwareCommands } from './software.ts'
import { typingCommands } from './typing.ts'

/** Every command group by file, in the order they register. A group file registers once it is listed here. */
export const commandGroups: Record<string, readonly OsCommand[]> = {
  navigation: navigationCommands,
  edit: editCommands,
  hermes: hermesCommands,
  memory: memoryCommands,
  files: filesCommands,
  automations: automationCommands,
  connections: connectionCommands,
  system: systemCommands,
  studio: studioCommands,
  open: openCommands,
  continuity: continuityCommands,
  crash: crashCommands,
  themes: themeCommands,
  screen: screenCommands,
  controls: controlCommands,
  switches: switchCommands,
  capture: captureCommands,
  typing: typingCommands,
  software: softwareCommands,
  plugins: pluginCommands,
  menubar: menuBarCommands,
  branding: brandingCommands,
  canvas: canvasCommands,
  office: officeCommands,
  docs: docsCommands,
  sheets: sheetsCommands,
  slides: slidesCommands
}

let registered = false

/** Register every OS command once at boot. New user-visible actions belong in one of these files. */
export function registerOsCommands(): void {
  if (registered) {
    return
  }

  registered = true

  // A bad definition costs only itself: defineCommands registers the rest of its group before it
  // throws. Report it and keep booting.
  for (const [group, commands] of Object.entries(commandGroups)) {
    try {
      defineCommands(commands)
    } catch (error) {
      console.error(`[os-commands] skipped in ${group}:`, error)
    }
  }
}
