import type { CheckResult } from '../domain/types'

export function CheckGrid({ checks, compact = false }: { checks: CheckResult[]; compact?: boolean }) {
  const failed = checks.filter((c) => !c.ok).length
  return (
    <div>
      {!compact && (
        <p className="note" style={{ marginTop: 0 }}>
          {failed === 0 ? '全部命中' : `${failed} 项不符`} · {checks.length} 项基准
        </p>
      )}
      <div className="checks">
        {checks.map((c) => (
          <div className="check" key={c.name}>
            <div style={{ minWidth: 0 }}>
              <div className="n">{c.name}</div>
              {!c.ok && <span className="d">应为 {c.expected}</span>}
              {c.ok && c.detail && <span className="d">{c.detail}</span>}
            </div>
            <span className="v" style={{ color: c.ok ? 'var(--jade)' : 'var(--accent)' }}>
              {c.actual} {c.ok ? '✓' : '✗'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
