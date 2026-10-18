import { useStore } from '@nanostores/react'
import { IconChevronDown, IconPlus, IconSparkles, IconX } from '@tabler/icons-react'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalClipboardRead } from '../../../shared/ipc.ts'
import { overClipboardLimit, sanitizePaste, TERMINAL_CLIPBOARD_LIMIT } from '../../../shared/terminal-clipboard.ts'
import { terminalColors } from '../../../shared/theme.ts'
import { Button } from '../../components/ui/button.tsx'
import { EmptyState } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { logFailure } from '../../lib/report.ts'
import { useShellCommands } from '../../shell/surfaces/shell-utils.ts'
import { $env, $prefs } from '../../store/backend.ts'
import { $catalog, loadCatalog } from '../../store/catalog.ts'
import { setOwnPaste } from '../../store/edit-target.ts'
import { t } from '../../store/i18n.ts'
import { notify } from '../../store/notifications.ts'
import { $terminalRequest } from '../../store/terminal.ts'
import { TerminalMenu } from './TerminalMenu.tsx'

const MONO_STACK = 'SF Mono, JetBrains Mono, Menlo, monospace'

interface Tab {
  id: string
  title: string
}

const THEME = {
  background: '#050f33',
  foreground: '#e9eefb',
  cursor: '#5296ff',
  cursorAccent: '#050f33',
  selectionBackground: 'rgba(82, 150, 255, 0.3)',
  black: '#101a3f',
  red: '#e5645b',
  green: '#5fc98a',
  yellow: '#e3a54a',
  blue: '#6aa9ff',
  magenta: '#c58af9',
  cyan: '#5fd1d6',
  white: '#c9ced6',
  brightBlack: '#5b6270',
  brightRed: '#f08078',
  brightGreen: '#7fe0a6',
  brightYellow: '#f0c070',
  brightBlue: '#8fbfff',
  brightMagenta: '#d7a8ff',
  brightCyan: '#84e6ea',
  brightWhite: '#f4f6f8'
}

/** The clipboard limit as the notices name it. */
const LIMIT = `${TERMINAL_CLIPBOARD_LIMIT / (1024 * 1024)} MiB`

const KEYS = {
  copy: { hint: 'Ctrl+Shift+C', aria: 'Control+Shift+C' },
  paste: { hint: 'Ctrl+Shift+V', aria: 'Control+Shift+V' }
}
const MAC_KEYS = {
  copy: { hint: '⌘C', aria: 'Meta+C Control+Shift+C' },
  paste: { hint: '⌘V', aria: 'Meta+V Control+Shift+V' }
}

/** A request this recent, found at mount, is what opened the Terminal: it becomes the first tab. */
const FRESH_REQUEST_MS = 3000

/** Real shells in real PTYs. Tabs stay alive while the surface is hidden and end when it closes. */
export function TerminalSurface() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  const live = useRef(new Set<string>())

  const create = async (program?: { id: string; label: string }) => {
    if (pending.current) {
      return
    }

    pending.current = true

    try {
      const handle = await window.heraldOS.terminal.create({ cols: 120, rows: 30, program: program?.id })

      if (!mounted.current) {
        void window.heraldOS.terminal.dispose(handle.id).catch(logFailure('terminal.dispose'))

        return
      }

      live.current.add(handle.id)
      setTabs(current => [...current, { id: handle.id, title: program?.label ?? handle.shell.split('/').pop() ?? 'shell' }])
      setActive(handle.id)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      pending.current = false
    }
  }

  useEffect(() => {
    const request = $terminalRequest.get()

    if (tabs.length === 0 && !error) {
      void create(request && Date.now() - request.at < FRESH_REQUEST_MS ? { id: request.program, label: request.label } : undefined)
    }

    // Later requests (the Terminal already open) add a tab.
    return $terminalRequest.listen(next => {
      if (next) {
        void create({ id: next.program, label: next.label })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Panels mode: the Terminal is its own window and hears about agents as a command.
  useShellCommands(command => {
    if (command.type === 'terminal-program' && command.args?.[0]) {
      void create({ id: command.args[0], label: command.args[1] ?? command.args[0] })
    }
  })

  const catalog = useStore($catalog)
  const agents = useMemo(() => catalog.groups.flatMap(group => group.entries).filter(entry => entry.terminal && entry.installed), [catalog.groups])
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!catalog.loaded) {
      void loadCatalog()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const ids = live.current
    mounted.current = true

    return () => {
      mounted.current = false

      for (const id of ids) {
        void window.heraldOS.terminal.dispose(id).catch(logFailure('terminal.dispose'))
      }

      ids.clear()
    }
  }, [])

  useEffect(
    () =>
      window.heraldOS.terminal.onExit(id => {
        live.current.delete(id)
        setTabs(current => {
          const next = current.filter(tab => tab.id !== id)
          setActive(prev => (prev === id ? (next[next.length - 1]?.id ?? null) : prev))

          return next
        })
      }),
    []
  )

  const close = (id: string) => {
    live.current.delete(id)
    void window.heraldOS.terminal.dispose(id).catch(logFailure('terminal.dispose'))
    setTabs(current => {
      const next = current.filter(tab => tab.id !== id)
      setActive(prev => (prev === id ? (next[next.length - 1]?.id ?? null) : prev))

      return next
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 px-3">
        {tabs.map(tab => (
          <div key={tab.id} className={cn('group/reveal-row flex h-7 items-center gap-1 rounded-sm pr-1 pl-2.5 text-[12px]', tab.id === active ? 'bg-white/8 text-fg' : 'text-fg-3 hover:bg-white/4 hover:text-fg-2')}>
            <button type="button" onClick={() => setActive(tab.id)} className="font-mono">
              {tab.title}
            </button>
            <button type="button" aria-label="Close terminal" onClick={() => close(tab.id)} className="flex size-5 items-center justify-center rounded-xs text-fg-4 reveal hover:text-fg">
              <IconX size={12} />
            </button>
          </div>
        ))}
        <Button variant="ghost" size="icon-sm" aria-label="New terminal" onClick={() => void create()}>
          <IconPlus size={15} />
        </Button>
        {agents.length > 0 && (
          <div className="relative">
            <Button variant="ghost" size="icon-sm" aria-label="New tab with a coding agent" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>
              <IconChevronDown size={14} />
            </Button>
            {menuOpen && (
              <div role="menu" className="float animate-pop absolute top-[calc(100%+4px)] left-0 z-30 flex min-w-[200px] flex-col rounded-lg p-1" onMouseLeave={() => setMenuOpen(false)}>
                {agents.map(agent => (
                  <button
                    key={agent.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      void create({ id: agent.id, label: agent.label })
                    }}
                    className="flex h-8 items-center gap-2 rounded-md px-2.5 text-left hover:bg-white/8"
                  >
                    <IconSparkles size={14} className="text-fg-3" />
                    <span className="text-[12.5px]">{agent.label}</span>
                    <span className="ml-auto font-mono text-[11px] text-fg-4">{agent.bin}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1 px-3 pb-3">
        {error && (
          <EmptyState title="Terminal unavailable" description={error} action={<Button onClick={() => { setError(null); void create() }}>Try again</Button>} />
        )}
        {tabs.map(tab => (
          <TerminalView key={tab.id} id={tab.id} active={tab.id === active} />
        ))}
      </div>
    </div>
  )
}

function TerminalView({ id, active }: { id: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null)
  const mac = useStore($env)?.platform === 'darwin'
  const prefs = useStore($prefs)
  const theme = useMemo(() => (prefs.themeColors ? terminalColors(prefs.themeColors, prefs.themeScheme) : THEME), [prefs.themeColors, prefs.themeScheme])
  const fontFamily = prefs.fonts?.mono ? `${JSON.stringify(prefs.fonts.mono)}, ${MONO_STACK}` : MONO_STACK
  const initial = useRef({ theme, fontFamily })
  initial.current = { theme, fontFamily }

  useEffect(() => {
    if (term.current) {
      term.current.options.theme = theme
      term.current.options.fontFamily = fontFamily
      fit.current?.fit()
    }
  }, [theme, fontFamily])

  useEffect(() => {
    const el = host.current

    if (!el) {
      return
    }

    const terminal = new Terminal({
      theme: initial.current.theme,
      fontFamily: initial.current.fontFamily,
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 8000,
      macOptionIsMeta: true
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(el)

    try {
      terminal.loadAddon(new WebglAddon())
    } catch {
      // Canvas renderer fallback is automatic.
    }

    term.current = terminal
    fit.current = fitAddon
    const live = () => term.current === terminal
    const showMenu = (clientX: number, clientY: number) => {
      const bounds = el.parentElement?.getBoundingClientRect()

      if (bounds) {
        setMenu({ x: clientX - bounds.left, y: clientY - bounds.top, selection: terminal.getSelection() })
      }
    }
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && opensMenu(event)) {
        event.preventDefault()
        // xterm keeps its hidden input at the caret, so the menu opens there.
        const caret = terminal.textarea?.getBoundingClientRect() ?? el.getBoundingClientRect()
        showMenu(caret.left, caret.bottom)

        return false
      }

      const action = clipboardShortcut(event)

      if (!action) {
        return true
      }

      // Chromium would also copy or paste for these keys, and xterm would send them to the shell.
      event.preventDefault()

      if (event.type === 'keydown' && !event.repeat) {
        void (action === 'copy' ? copyText(terminal.getSelection()) : pasteInto(terminal, live))
      }

      return false
    })
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      showMenu(event.clientX, event.clientY)
    }
    el.addEventListener('contextmenu', onContextMenu)
    // Cmd+V, Shift+Insert and Edit > Paste arrive as a paste event, which xterm would hand to the
    // shell unfiltered; caught on the way down, it never reaches xterm's own listeners.
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      // A person pastes into the terminal they are typing in: a window in the background, or a
      // paste event aimed at a terminal without the keyboard, pastes nothing.
      sayPasteOutcome(document.hasFocus() && el.contains(document.activeElement) ? pasteText(terminal, event.clipboardData?.getData('text/plain') ?? '') : 'unfocused')
    }
    el.addEventListener('paste', onPaste, true)
    // Cmd+C, Edit > Copy and a spoken "copy" arrive as a copy event, which xterm would answer with
    // the whole selection; caught the same way, it takes Ctrl+Shift+C's copy and its limit.
    const onCopy = (event: ClipboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      void copyText(terminal.getSelection())
    }
    el.addEventListener('copy', onCopy, true)
    // xterm takes no drops, and dropped text would sit unread and unfiltered in its hidden input.
    // Dropped text pastes like any paste, filtered and capped; anything else dropped is refused.
    const onDragOver = (event: DragEvent) => {
      event.preventDefault()

      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = event.dataTransfer.types.includes('text/plain') ? 'copy' : 'none'
      }
    }
    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (terminal.textarea) {
        terminal.textarea.value = ''
      }

      const text = event.dataTransfer?.getData('text/plain') ?? ''

      if (text) {
        sayPasteOutcome(pasteText(terminal, text), 'drop')
        terminal.focus()
      } else {
        notify({ title: t('terminal.dropNotText'), body: t('terminal.dropNotTextBody'), level: 'info', key: 'terminal.clipboard' })
      }
    }
    el.addEventListener('dragover', onDragOver, true)
    el.addEventListener('drop', onDrop, true)
    // A spoken or Hermes "paste" takes the same read through main, and hears back why it was refused.
    const offOwnPaste = terminal.textarea ? setOwnPaste(terminal.textarea, async () => pasteProblem(await readAndPaste(terminal, live))) : () => {}
    const offData = window.heraldOS.terminal.onData((tid, data) => {
      if (tid === id) {
        terminal.write(data)
      }
    })
    const onInput = terminal.onData(data => window.heraldOS.terminal.write(id, data))
    const onResize = terminal.onResize(({ cols, rows }) => window.heraldOS.terminal.resize(id, cols, rows))
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        fitAddon.fit()
      }
    })
    observer.observe(el)
    fitAddon.fit()

    return () => {
      el.removeEventListener('contextmenu', onContextMenu)
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('copy', onCopy, true)
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('drop', onDrop, true)
      offOwnPaste()
      observer.disconnect()
      offData()
      onInput.dispose()
      onResize.dispose()
      terminal.dispose()
      term.current = null
    }
  }, [id])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fit.current?.fit()
        term.current?.focus()
      })
    } else {
      setMenu(null)
    }
  }, [active])

  const closeMenu = useCallback((refocus: boolean) => {
    setMenu(null)

    if (refocus) {
      term.current?.focus()
    }
  }, [])

  return (
    <>
      <div ref={host} className={cn('absolute inset-x-3 inset-y-0 bottom-3 overflow-hidden rounded-lg hairline', !active && 'invisible')} style={{ background: theme.background }} />
      {menu && (
        <TerminalMenu
          x={menu.x}
          y={menu.y}
          canCopy={menu.selection.length > 0}
          keys={mac ? MAC_KEYS : KEYS}
          onCopy={() => void copyText(menu.selection)}
          onPaste={() => {
            const terminal = term.current

            if (terminal) {
              void pasteInto(terminal, () => term.current === terminal)
            }
          }}
          onClose={closeMenu}
        />
      )}
    </>
  )
}

/** The keyboard's menu key, or Shift+F10. */
function opensMenu(event: KeyboardEvent): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey)
}

/**
 * Ctrl+Shift+C and Ctrl+Shift+V, by letter or, on a layout without Latin letters, by key position.
 * Ctrl+C without Shift stays the shell's interrupt.
 */
function clipboardShortcut(event: KeyboardEvent): 'copy' | 'paste' | null {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.isComposing) {
    return null
  }

  const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : event.code === 'KeyC' ? 'c' : event.code === 'KeyV' ? 'v' : ''

  return letter === 'c' ? 'copy' : letter === 'v' ? 'paste' : null
}

async function copyText(text: string): Promise<void> {
  if (!text) {
    return
  }

  if (overClipboardLimit(text)) {
    tooLarge('terminal.copyTooLarge', 'terminal.copyTooLargeBody')

    return
  }

  try {
    await window.heraldOS.terminal.writeClipboard(text)
  } catch (error) {
    clipboardFailed('terminal.copyFailed', error)
  }
}

/** What became of a paste: it went in, there was no text to paste, or why it did not. */
type PasteOutcome = 'pasted' | 'nothing' | 'unfocused' | 'rate-limited' | 'too-large' | 'failed' | 'closed'

/** The clipboard, read through main, pasted into `terminal`; says nothing itself. */
async function readAndPaste(terminal: Terminal, live: () => boolean): Promise<PasteOutcome> {
  let clipboard: TerminalClipboardRead

  try {
    clipboard = await window.heraldOS.terminal.readClipboard()
  } catch (error) {
    logFailure('terminal.clipboard')(error)

    return live() ? 'failed' : 'closed'
  }

  if (!live()) {
    return 'closed'
  }

  return 'refused' in clipboard ? clipboard.refused : 'tooLarge' in clipboard ? 'too-large' : pasteText(terminal, clipboard.text)
}

async function pasteInto(terminal: Terminal, live: () => boolean): Promise<void> {
  sayPasteOutcome(await readAndPaste(terminal, live))
}

/**
 * Every paste ends here, filtered as one string, then goes through xterm's paste, which brackets
 * it for a program that asked for bracketed paste.
 */
function pasteText(terminal: Terminal, text: string): PasteOutcome {
  if (overClipboardLimit(text)) {
    return 'too-large'
  }

  const clean = sanitizePaste(text)

  if (!clean) {
    return 'nothing'
  }

  terminal.paste(clean)

  return 'pasted'
}

/** Why a paste did not go in, in words, or null when it did. */
function pasteProblem(outcome: PasteOutcome): string | null {
  switch (outcome) {
    case 'pasted':
      return null
    case 'nothing':
      return t('terminal.pasteNothing')
    case 'unfocused':
      return t('terminal.pasteUnfocusedBody')
    case 'rate-limited':
      return t('terminal.pasteTooFastBody')
    case 'too-large':
      return t('terminal.pasteTooLargeBody', { size: LIMIT })
    case 'failed':
    case 'closed':
      return t('terminal.clipboardUnavailable')
  }
}

/** Keys held down, or pastes refused over and over, hear about it once in this long, not every time. */
const QUIET_MS = 5000
const saidAt = new Map<PasteOutcome, number>()

/**
 * A notice for a paste that did not go in, from the clipboard or from a drop. Each kind of
 * refusal is said once in QUIET_MS at most.
 */
function sayPasteOutcome(outcome: PasteOutcome, from: 'clipboard' | 'drop' = 'clipboard'): void {
  if (outcome === 'pasted' || outcome === 'nothing' || outcome === 'closed') {
    return
  }

  if (outcome === 'too-large') {
    tooLarge('terminal.pasteTooLarge', from === 'drop' ? 'terminal.dropTooLargeBody' : 'terminal.pasteTooLargeBody')

    return
  }

  if (outcome === 'failed') {
    notify({ title: t('terminal.pasteFailed'), body: t('terminal.clipboardUnavailable'), level: 'error', key: 'terminal.clipboard' })

    return
  }

  const now = Date.now()

  if (now - (saidAt.get(outcome) ?? -Infinity) < QUIET_MS) {
    return
  }

  saidAt.set(outcome, now)

  if (outcome === 'rate-limited') {
    notify({ title: t('terminal.pasteTooFast'), body: t('terminal.pasteTooFastBody'), level: 'info', key: 'terminal.clipboard' })
  } else {
    notify({ title: t('terminal.pasteUnfocused'), body: t('terminal.pasteUnfocusedBody'), level: 'warn', key: 'terminal.clipboard' })
  }
}

function clipboardFailed(title: 'terminal.copyFailed', error: unknown): void {
  logFailure('terminal.clipboard')(error)
  notify({ title: t(title), body: t('terminal.clipboardUnavailable'), level: 'error', key: 'terminal.clipboard' })
}

function tooLarge(title: 'terminal.copyTooLarge' | 'terminal.pasteTooLarge', body: 'terminal.copyTooLargeBody' | 'terminal.pasteTooLargeBody' | 'terminal.dropTooLargeBody'): void {
  notify({ title: t(title), body: t(body, { size: LIMIT }), level: 'warn', key: 'terminal.clipboard' })
}
