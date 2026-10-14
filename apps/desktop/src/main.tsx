import './lib/report.ts'
import './lib/legacy-storage.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ShellRoot } from './shell/ShellRoot.tsx'
import { bootRenderer } from './store/boot.ts'
import { shellMode, surface } from './store/shell.ts'
import './styles.css'

bootRenderer()
// Lets the stylesheet adapt (transparent panel windows, no desktop chrome).
document.documentElement.dataset.shellMode = shellMode
document.documentElement.dataset.surface = surface

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ShellRoot />
  </StrictMode>
)
