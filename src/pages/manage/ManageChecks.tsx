import { Collapse, Tag } from 'animal-island-ui'
import { useApp } from '../../store/useApp'
import { CheckList } from '../../components/CheckGrid'

/** 基准快照 + 数量守恒（V9.10 从概览挪来）：体检性质的内容放管理页，概览专心看树 */
export function ManageChecks() {
  const { baseline, ledger } = useApp()
  const failed = baseline.filter((c) => !c.ok).length
  const checksFailed = ledger.checks.filter((c) => !c.ok).length
  return (
    <div className="stack">
      <Collapse
        question={
          <span className="row" style={{ gap: 6 }}>
            基准快照（文档 §03）
            <Tag size="small" variant="soft" color={failed ? 'app-red' : 'app-green'}>
              {failed ? `${failed} 项不符` : '全中'}
            </Tag>
          </span>
        }
        answer={<CheckList checks={baseline} />}
      />
      <Collapse
        question={
          <span className="row" style={{ gap: 6 }}>
            数量守恒（R7）
            <Tag size="small" variant="soft" color={checksFailed ? 'app-red' : 'app-green'}>
              {checksFailed ? `${checksFailed} 项不符` : '全中'}
            </Tag>
          </span>
        }
        answer={<CheckList checks={ledger.checks} />}
      />
      <p className="tiny muted" style={{ margin: '8px 0 0' }}>
        这两项是台账自检：基准对文档 §03 的固定数字，守恒查买入 − 卖出 + 回补 = 净持仓等恒等式。
      </p>
    </div>
  )
}
