import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevron, IconDownload } from '../../ui/icons'
import { navigateManage, replaceManageRoute, type GuideMode, type ManageQuery } from '../../ui/nav'
import { transitionView } from '../../ui/transitions'
import { scrollToPageTop } from '../../ui/scrollHeader'
import { GuideMarkdown } from '../../help/GuideMarkdown'
import { categories, documentHeadings, documents, guideLink, issues, plainText, scenarioRows, topics } from '../../help/content'

const MODES: { key: GuideMode; title: string }[] = [
  { key: 'questions', title: '处理步骤' }, { key: 'scenarios', title: '场景核对' },
  { key: 'documents', title: '完整文档' }, { key: 'issues', title: '注意事项' },
]
const FREQUENT = [{ title: '先卖后买', id: '15' }, { title: '回本怎么算', id: '20' }, { title: '撤销与改错', id: '32' }, { title: '备份与迁移', id: '35' }]

function matches(text: string, query: string): boolean {
  const source = plainText(text).toLowerCase().replace(/\s+/g, '')
  return query.trim().toLowerCase().split(/\s+/).every(word => source.includes(word))
}

function excerpt(body: string, search: string): string {
  const plain = plainText(body)
  const first = search.trim().split(/\s+/)[0] ?? ''
  const hit = first ? plain.toLowerCase().indexOf(first.toLowerCase()) : 0
  const start = Math.max(0, hit - 24)
  return `${start > 0 ? '…' : ''}${plain.slice(start, start + 100)}${plain.length > start + 100 ? '…' : ''}`
}

function Highlight({ text, search }: { text: string; search: string }) {
  if (!search.trim()) return <>{text}</>
  const words = search.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${words.join('|')})`, 'gi')
  return <>{text.split(pattern).map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : part)}</>
}

function downloadDocument(title: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${title}.md`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function ManageGuide({ query }: { query: ManageQuery }) {
  const [search, setSearch] = useState(query.q ?? '')
  const [category, setCategory] = useState(query.category ?? 'all')
  const [mode, setMode] = useState<GuideMode>(query.mode ?? 'questions')
  const articleRef = useRef<HTMLElement>(null)
  const returnScroll = useRef(0)
  const previousArticle = useRef(false)
  const routeKey = JSON.stringify(query)

  useEffect(() => {
    const next = JSON.parse(routeKey) as ManageQuery
    setSearch(next.q ?? '')
    setCategory(next.category ?? 'all')
    setMode(next.mode ?? 'questions')
  }, [routeKey])

  const topic = topics.find(t => t.id === query.topic)
  const scenario = scenarioRows.find(t => t.id === query.scenario)
  const doc = documents.find(d => d.id === query.doc)
  const invalidArticle = Boolean((query.topic || query.scenario || query.doc) && !topic && !scenario && !doc)
  const isArticle = Boolean(topic || scenario || doc || invalidArticle)
  const articleKey = query.topic ?? query.scenario ?? query.doc

  useLayoutEffect(() => {
    if (isArticle) articleRef.current?.focus({ preventScroll: true })
    else if (previousArticle.current && returnScroll.current) {
      const frame = requestAnimationFrame(() => window.scrollTo({ top: returnScroll.current, behavior: 'instant' }))
      previousArticle.current = false
      return () => cancelAnimationFrame(frame)
    }
    previousArticle.current = isArticle
  }, [isArticle, articleKey])

  useEffect(() => {
    if (!query.anchor || !doc) return
    const frame = requestAnimationFrame(() => {
      const target = articleRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(query.anchor!)}"]`)
      target?.scrollIntoView({ block: 'start', behavior: 'instant' })
    })
    return () => cancelAnimationFrame(frame)
  }, [doc, query.anchor])

  const listQuery: ManageQuery = { section: 'guide', mode,
    ...(search ? { q: search } : {}), ...(category !== 'all' ? { category } : {}) }
  const open = (target: Partial<ManageQuery>) => {
    if (!isArticle) returnScroll.current = window.scrollY
    navigateManage({ ...listQuery, ...target })
  }
  const changeSearch = (value: string) => {
    setSearch(value)
    replaceManageRoute({ ...listQuery, q: value || undefined })
  }
  const changeCategory = (value: string) => {
    transitionView(() => setCategory(value))
    replaceManageRoute({ ...listQuery, category: value === 'all' ? undefined : value })
  }
  const changeMode = (next: GuideMode) => {
    transitionView(() => { setMode(next); setCategory('all') })
    replaceManageRoute({ ...listQuery, mode: next, category: undefined })
  }

  if (isArticle) {
    const title = topic?.title ?? scenario?.title ?? doc?.title ?? '没有找到这篇内容'
    const body = topic?.body ?? doc?.body.replace(/^# .*(?:\r?\n|$)/, '') ?? ''
    const headings = doc ? documentHeadings(body) : []
    let content: ReactNode
    if (scenario) {
      content = <>
        <section className="guide-answer"><h3>应有结果</h3><GuideMarkdown body={scenario.expected} /></section>
        <section className="guide-answer guide-evidence"><h3>验证与当前边界</h3><GuideMarkdown body={scenario.evidence} /></section>
        <p className="guide-footnote">应有结果用于核对。已复现问题表示当前实现仍有偏差，不能视为已修复。</p>
        <a href={guideLink({ ...listQuery, doc: 'boundaries' })} className="guide-related">查处理建议与最新状态 <IconChevron width={15} height={15} /></a>
      </>
    } else if (invalidArticle) {
      content = <p>链接可能已过期。返回指南搜索关键词，或从完整文档重新查找。</p>
    } else {
      content = <>
        {doc && (doc.kind === 'audit' || doc.kind === 'history') && <aside className="guide-note">这是带日期的审计或历史记录。当前处理办法与修复状态请看 <a href={guideLink({ doc: 'boundaries' })}>操作边界与核对</a>。</aside>}
        {headings.length > 0 && <details className="guide-toc"><summary>本篇目录 · {headings.length} 节</summary>
          <nav aria-label="文档目录">{headings.map((heading, i) => <a key={`${heading.id}:${i}`} href={guideLink({ ...listQuery, doc: doc!.id, anchor: heading.id })}>{heading.title}</a>)}</nav>
        </details>}
        <GuideMarkdown body={body} documentId={doc?.id} />
      </>
    }
    return <article ref={articleRef} tabIndex={-1} className="guide guide-article" data-testid="guide-article" aria-labelledby="guide-article-title">
      <div className="guide-reader-nav">
        <button type="button" className="guide-back" onClick={() => navigateManage(listQuery)} data-testid="guide-back"><IconChevron width={15} height={15} />返回指南</button>
        <button type="button" className="guide-top" onClick={scrollToPageTop}>回到顶部 ↑</button>
      </div>
      <div className="guide-eyebrow">{topic ? `${topic.category} · ${topic.id}` : scenario ? `场景 ${scenario.id} · ${scenario.category}` : '完整文档'}</div>
      <h2 id="guide-article-title">{title}</h2>
      {doc && <div className="guide-article-meta"><span>项目内文档 · 随应用保存</span><button type="button" onClick={() => downloadDocument(doc.title, doc.body)}><IconDownload width={14} height={14} />保存原文</button></div>}
      {content}
      {topic && <footer className="guide-article-footer"><a href={guideLink({ ...listQuery, doc: 'scenarios' })}>查看完整场景与算例</a><a href={guideLink({ ...listQuery, doc: 'boundaries' })}>查看注意事项</a></footer>}
    </article>
  }

  const filteredTopics = topics.filter(t => (category === 'all' || t.category === category) && matches(`${t.title} ${t.body} ${t.category}`, search))
  const filteredScenarios = scenarioRows.filter(t => (category === 'all' || t.category === category) && matches(`${t.id} ${t.title} ${t.expected} ${t.evidence}`, search))
  const filteredDocs = documents.filter(d => matches(`${d.title} ${d.summary} ${d.body}`, search))
  const filteredIssues = issues.filter(t => (category === 'all' || t.category === category) && matches(`${t.id} ${t.title} ${t.body}`, search))
  const categoryOptions = mode === 'questions' ? categories : [...new Set((mode === 'scenarios' ? scenarioRows : issues).map(t => t.category))]
  const count = mode === 'questions' ? filteredTopics.length : mode === 'scenarios' ? filteredScenarios.length : mode === 'documents' ? filteredDocs.length : filteredIssues.length

  return <div className="guide" data-testid="manage-guide">
    <header className="guide-intro">
      <div className="guide-eyebrow">随手查 · 慢慢核对</div>
      <h2>遇到这种情况<br />该怎么处理？</h2>
      <p>{topics.length} 个处理步骤，{scenarioRows.length} 个核对场景。<br />从操作到结果，把每一步看明白。</p>
      <span className="guide-edition">更新于 2026.10.29 · 可离线阅读</span>
    </header>

    <div className="guide-search"><label htmlFor="guide-search">搜索情况、步骤或关键词</label>
      <div><input id="guide-search" type="search" placeholder="试试：回本、拆分、撤销、备份…" value={search} onChange={event => changeSearch(event.target.value)} maxLength={160} />
        {search && <button type="button" onClick={() => changeSearch('')} aria-label="清空指南搜索">清空</button>}</div>
    </div>
    {!search && <nav className="guide-frequent" aria-label="常用问题">{FREQUENT.map(item => <button type="button" key={item.id} onClick={() => open({ topic: item.id })}>{item.title}<IconChevron width={13} height={13} /></button>)}</nav>}

    <nav className="guide-modes" aria-label="指南浏览方式">{MODES.map(item => <button key={item.key} type="button" aria-pressed={mode === item.key} onClick={() => changeMode(item.key)} data-guide-mode={item.key}>{item.title}</button>)}</nav>
    <div className="guide-filter">
      <p role="status" aria-live="polite" data-testid="guide-result-count">{search ? '搜索结果' : MODES.find(item => item.key === mode)?.title} <strong>{count}</strong> {mode === 'documents' ? '篇' : '项'}</p>
      {mode !== 'documents' && <select aria-label="指南分类" value={category} onChange={event => changeCategory(event.target.value)}><option value="all">全部分类</option>{categoryOptions.map(name => <option key={name} value={name}>{name}</option>)}</select>}
    </div>

    {mode === 'issues' && <aside className="guide-note">这里按证据日期标记修复状态，区分规则与当前实现偏差；不要用重复成交或改真实日期来凑平数字。</aside>}
    {count === 0 && <div className="guide-empty"><strong>没有找到匹配内容</strong><p>试试更短的关键词，或切换到场景核对、完整文档。</p><button type="button" onClick={() => {
      setSearch(''); setCategory('all'); replaceManageRoute({ section: 'guide', mode })
    }}>查看全部</button></div>}

    <div className="guide-results" data-testid="guide-results">
      {mode === 'questions' && filteredTopics.map(item => <button type="button" className="guide-result" key={item.id} data-guide-topic={item.id} onClick={() => open({ topic: item.id })}>
        <span className="guide-number">{item.id}</span><span><small>{item.category}</small><strong><Highlight text={item.title} search={search} /></strong>{search && <p><Highlight text={excerpt(item.body, search)} search={search} /></p>}</span><IconChevron width={16} height={16} />
      </button>)}
      {mode === 'scenarios' && filteredScenarios.map(item => <button type="button" className="guide-result" key={item.id} data-guide-scenario={item.id} onClick={() => open({ scenario: item.id })}>
        <span className="guide-number">{item.id}</span><span><small>{item.category}</small><strong><Highlight text={plainText(item.title)} search={search} /></strong><p><Highlight text={excerpt(search ? `${item.expected} ${item.evidence}` : item.expected, search)} search={search} /></p><em>{item.evidence.includes('已复现问题') ? '含已知问题 · 点开核对' : '查看应有结果与证据'}</em></span><IconChevron width={16} height={16} />
      </button>)}
      {mode === 'documents' && filteredDocs.map(item => <button type="button" className="guide-result guide-document" key={item.id} data-guide-doc={item.id} onClick={() => open({ doc: item.id })}>
        <span><small>{item.kind === 'audit' ? '审计快照' : item.kind === 'history' ? '维护与历史' : '指南与规则'}</small><strong><Highlight text={item.title} search={search} /></strong><p><Highlight text={search ? excerpt(item.body, search) : item.summary} search={search} /></p></span><IconChevron width={16} height={16} />
      </button>)}
      {mode === 'issues' && filteredIssues.map(item => <button type="button" className="guide-result" key={item.id} data-guide-issue={item.id} onClick={() => open({ doc: 'boundaries', anchor: item.id.toLowerCase() })}>
        <span className="guide-number">{item.id}</span><span><small>{item.category} · {item.body.includes('状态：本次已修复') ? '本次已修复' : '查看当前边界'}</small><strong><Highlight text={item.title} search={search} /></strong><p><Highlight text={excerpt(item.body, search)} search={search} /></p></span><IconChevron width={16} height={16} />
      </button>)}
    </div>
    <footer className="guide-library-footer">内容与项目文档同步，随应用保存。<br />完整资源缓存后可离线查阅，换设备仍需备份迁移台账。</footer>
  </div>
}
