import { Tag } from 'animal-island-ui'
import type { CheckResult } from '../domain/types'

export function CheckList({ checks }: { checks: CheckResult[] }) {
  const failed = checks.filter((c) => !c.ok).length
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <Tag size="small" variant="soft" color={failed ? 'app-red' : 'app-green'}>
          {failed === 0 ? `${checks.length} 项全中` : `${failed} 项不符`}
        </Tag>
      </div>
      {checks.map((c) => (
        <div className="line" key={c.name}>
          <div className="left">
            <div className="t1" style={{ fontWeight: 500 }}>{c.name}</div>
            {!c.ok && <div className="t2">应为 {c.expected}</div>}
            {c.ok && c.detail && <div className="t2">{c.detail}</div>}
          </div>
          <div className="right num" style={{ color: c.ok ? 'var(--down)' : 'var(--up)', fontSize: 13 }}>
            {c.actual} {c.ok ? '✓' : '✗'}
          </div>
        </div>
      ))}
    </div>
  )
}
