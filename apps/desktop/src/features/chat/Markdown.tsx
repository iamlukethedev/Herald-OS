import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { logFailure } from '../../lib/report.ts'

const plugins = [remarkGfm]

/** Transcript markdown. Links open outside the shell; the renderer never navigates. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `prose-hermes ${className}` : 'prose-hermes'}>
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={event => {
                event.preventDefault()

                if (href) {
                  void window.heraldOS.shell.openExternal(href).catch(logFailure('shell.openExternal'))
                }
              }}
            >
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
