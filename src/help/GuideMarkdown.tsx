import { Children, isValidElement, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { headingId, resolveDocumentLink } from './content'

function textOf(children: ReactNode): string {
  return Children.toArray(children).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    return isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : ''
  }).join('')
}

/** 只渲染仓库内的 Markdown；不执行内嵌 HTML，文档链接留在当前应用内。 */
export function GuideMarkdown({ body, documentId }: { body: string; documentId?: string }) {
  return (
    <div className="guide-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={{
        h1: ({ children }) => <h2 id={headingId(textOf(children))}>{children}</h2>,
        h2: ({ children }) => <h2 id={headingId(textOf(children))}>{children}</h2>,
        h3: ({ children }) => <h3 id={headingId(textOf(children))}>{children}</h3>,
        h4: ({ children }) => <h4 id={headingId(textOf(children))}>{children}</h4>,
        a: ({ href, children }) => {
          const target = href ? resolveDocumentLink(href, documentId) : null
          if (!target) return <span className="guide-reference">{children}</span>
          return <a href={target} {...(target.startsWith('https://') || target.startsWith('http://') ? { target: '_blank', rel: 'noreferrer' } : {})}>{children}</a>
        },
        table: ({ children }) => <div className="guide-table" tabIndex={0} role="region" aria-label="文档表格，可横向滚动"><table>{children}</table></div>,
        pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
      }}>{body}</Markdown>
    </div>
  )
}
