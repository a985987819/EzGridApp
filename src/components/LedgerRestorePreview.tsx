import { useState } from 'react'
import { Button, Card, notificationOpen } from 'animal-island-ui'
import { exportLedgerWorkbook, type LedgerWorkbookPreview } from '../io/ledgerWorkbook'
import { useApp } from '../store/useApp'
import { downloadText, downloadBytes } from '../ui/csv'
import { money } from '../ui/format'

/** 预览不写库，最终恢复沿用唯一写库入口与原子事务。 */
export function LedgerRestorePreview({ preview, onClose }: { preview: LedgerWorkbookPreview; onClose: () => void }) {
  const { exportBackup, restoreBackup } = useApp()
  const [busy, setBusy] = useState(false)
  const s = preview.snapshot
  const totals = preview.views['核对_合计'][0]
  async function restore() {
    if (busy) return
    setBusy(true)
    try {
      const backup = await exportBackup()
      downloadText(`grid-before-excel-restore-${Date.now()}.json`, backup, 'application/json;charset=utf-8')
      await restoreBackup(JSON.stringify(s))
      notificationOpen({ message: '完整台账已恢复', description: '恢复前的 JSON 快照已下载，自动关联已重新计算。', type: 'success' })
      onClose()
    } catch (err) {
      notificationOpen({ message: '恢复失败', description: err instanceof Error ? err.message : String(err), type: 'error' })
    } finally { setBusy(false) }
  }
  return <Card>
    <div className="stack" data-testid="ledger-restore-preview" style={{ overflowWrap: 'anywhere' }}>
      <strong>完整台账恢复预览</strong>
      <p className="hint-block">导出时间：{s.exportedAt}。将整库替换，包含软删除记录及操作历史；不会与当前台账合并。恢复前自动下载当前 JSON 快照。</p>
      <div>{s.records.length} 笔记录 · {s.rebuyExecutions.length} 笔回补成交 · {preview.views['核对_回本链'].length} 条回本链</div>
      <div>已实现盈利 {money(Number(totals.profitCents))} · 待买 {String(totals.rebuyRemainingQty)} 股 · 待卖 {String(totals.targetQty)} 股</div>
      <div>{s.hedges.length} 条人工高位关联 · {s.chainLinks.length} 条人工链设置 · 自动关联重新推导</div>
      <strong>{preview.differences.length ? '与导出时快照有变化，请核对' : '核对通过：回本链、挂单、奖励及记录序号与导出时一致'}</strong>
      {preview.differences.length > 0 && <div>{preview.differences.map((d) => <details key={d.sheet}><summary>{d.sheet}：内容变化（原 {d.before} 行 → 重算 {d.after} 行）</summary><ul>{d.examples.map((e, i) => <li key={i}>{e}</li>)}</ul><p className="tiny muted">每张表最多展示 12 项；完整结果见重算核对表。</p></details>)}</div>}
      <details><summary>查看重算后的回本链</summary>
        {preview.views['核对_回本链'].map((c) => <p key={String(c.id)}>{String(c.stockName)} · {String(c.id)}：原始亏损 {money(Number(c.lossCents))}，后续净盈利 {money(Number(c.profitCents))}，实际盈亏 {money(Number(c.netCents))}，还差 {money(Number(c.gapCents))}</p>)}
      </details>
      <div className="row">
        <Button disabled={busy} onClick={() => {
          void exportLedgerWorkbook(s).then((bytes) => downloadBytes('完整台账-重算核对.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).catch((err: unknown) => notificationOpen({ message: '导出重算结果失败', description: String(err), type: 'error' }))
        }}>下载重算核对表</Button>
        <Button type="primary" danger disabled={busy} data-action="restore-ledger-confirm" onClick={() => void restore()}>{busy ? '正在恢复…' : '确认整库替换并恢复'}</Button>
        <Button disabled={busy} onClick={onClose}>取消</Button>
      </div>
    </div>
  </Card>
}
