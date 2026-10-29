import { Collapse, Tag } from 'animal-island-ui'
import { useApp } from '../../store/useApp'
import { CheckList } from '../../components/CheckGrid'
import { buildManageHash } from '../../ui/nav'

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
        基准快照只用于固定样本，不要求你的台账与样本一致。数量守恒通过也不能保证来源、归属和备份引用全部正确。
        <a href={buildManageHash({ section: 'guide', topic: '39' })}>查看核对顺序与处理步骤</a>
      </p>
    </div>
  )
}
