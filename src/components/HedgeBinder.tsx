/** 先卖后买的高位成本关联；默认分配可人工改挂，已回补份额仍保留原始亏损。 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Modal, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { isHedgeable } from '../domain/hedge'
import { recordNoLabel } from '../domain/recordNo'
import { isSandboxRow } from '../domain/sandbox'
import { price, qty, signedMoney, tone } from '../ui/format'

export function HedgeBinder({
  sellRow,
  onSaved,
  mode = 'real',
}: {
  sellRow: number
  onSaved?: () => void
  /** sandbox：用真实 + 模拟的预览账本，保存只改模拟挂钩，不写库 */
  mode?: 'real' | 'sandbox'
}) {
  const app = useApp()
  const recordNo = app.recordNo
  const sandboxMode = mode === 'sandbox'
  const ledger = sandboxMode ? app.sandboxLedger : app.ledger
  const records = sandboxMode ? app.sandboxPreviewRecords : app.records
  const hedges = ledger.effectiveHedges
  const setHedgeLink = sandboxMode ? app.setSandboxHedge : app.setHedgeLink
  const clearHedgeLink = sandboxMode ? app.clearSandboxHedge : app.clearHedgeLink
  const rec = records.find((r) => r.sourceRow === sellRow) ?? null
  const sell = ledger.sells.find((s) => s.sourceRow === sellRow) ?? null
  const order = ledger.orders.find((o) => o.sourceRow === sellRow) ?? null
  const link = hedges.find((h) => h.sellRow === sellRow) ?? null
  const soldQty = rec?.soldQty ?? 0
  /** V9.57：只算基础股——奖励股是额外买入，不算「已买回」的欠量 */
  const execQty = order ? Math.max(0, order.execQty - order.doneRewardQty) : 0
  /** 关联原始卖出股数；回补只改变持仓，不撤销高位成本。 */
  const required = soldQty
  const sellPrice = sell?.priceCents ?? rec?.targetPriceCents ?? null
  /** 这条挂钩现在有没有毛病（失效 / 超挂 / 挂不满）——异常由 ledger 给出，这里只显示 */
  const issues = ledger.anomalies.filter((a) => a.sourceRow === sellRow && a.kind.startsWith('hedge'))

  /** 候选未完成买单：同股票、还没卖完、有剩余；可挂量以台账当前剩余为准（已扣掉别人的挂钩） */
  const candidates = useMemo(() => {
    if (!rec) return []
    const own = new Map((link?.items ?? []).map((i) => [i.row, i.qty]))
    return ledger.lots
      .filter(
        (l) =>
          !l.id.startsWith('lot:exec:') && // 回补批次是虚拟批次，不当买单挂
          l.stockName === rec.stockName &&
          l.sourceRow !== sellRow &&
          !ledger.sells.some((s) => s.sourceRow === l.sourceRow && s.sellBeforeBuy),
      )
      .map((l) => ({
        lot: l,
        // remainingQty 已经扣掉所有活跃挂钩；把自己那份加回来，才改得动
        available: l.remainingQty + (own.get(l.sourceRow) ?? 0),
      }))
      .filter((c) => c.available > 0)
      // 高位在前：先挂高买价的批次，亏得明白
      .sort((a, b) => b.lot.buyPriceCents - a.lot.buyPriceCents || a.lot.sourceRow - b.lot.sourceRow)
  }, [rec, ledger.lots, ledger.sells, link, sellRow])

  // 已存的分配回填到输入框；换行 / 挂钩结果变了就重置
  const [draft, setDraft] = useState<Record<number, string>>({})
  useEffect(() => {
    const d: Record<number, string> = {}
    for (const it of link?.items ?? []) d[it.row] = String(it.qty)
    setDraft(d)
  }, [sellRow, link])

  /** 默认只列「高位买单」（买价高于卖价 → 挂上去才是亏损）；可放开展示全部 */
  const [showAll, setShowAll] = useState(false)
  /** 允许挂不满：差额继续按敞口算（V9.33） */
  const [allowPartial, setAllowPartial] = useState(false)
  const visible = candidates.filter(
    (c) =>
      showAll ||
      sellPrice === null ||
      c.lot.buyPriceCents > sellPrice ||
      (link?.items ?? []).some((i) => i.row === c.lot.sourceRow),
  )

  const items = Object.entries(draft)
    .map(([k, v]) => ({ row: Number(k), qty: Math.floor(Number(v)) }))
    .filter((i) => Number.isFinite(i.qty) && i.qty > 0)
  const assigned = items.reduce((a, i) => a + i.qty, 0)
  const diff = required - assigned
  /** 按当前分配会记成多少亏损（卖价 − 买价）× 股数 */
  const lossCents = sellPrice === null
    ? null
    : items.reduce((a, i) => {
        const lot = candidates.find((c) => c.lot.sourceRow === i.row)?.lot
        return lot ? a + (sellPrice - lot.buyPriceCents) * i.qty : a
      }, 0)

  /** 自动挂满：按列表顺序（买价从高到低）贪心填到「还需要挂的股数」 */
  function autoFill() {
    const d: Record<number, string> = {}
    let left = required
    for (const c of visible) {
      if (left <= 0) break
      const q = Math.min(c.available, left)
      d[c.lot.sourceRow] = String(q)
      left -= q
    }
    setDraft(d)
    if (left > 0) {
      notificationOpen({ message: `候选加起来还差 ${left} 股`, description: '可以打开「显示全部」，或先挂这么多', type: 'warning' })
      setAllowPartial(true)
    }
  }

  async function save() {
    if (assigned === 0) {
      // 清空写人工解除，后续重算不自动改挂。
      if (link) await clear()
      else notificationOpen({ message: '还没分配股数', description: '至少给一个买填股数', type: 'warning' })
      return
    }
    if (sellPrice === null) {
      notificationOpen({ message: '这笔卖缺成交价', description: '先把 E 列（成交价）补上，否则挂上去也暂记不了亏损', type: 'warning' })
      return
    }
    if (assigned > required) {
      notificationOpen({ message: '挂多了', description: `最多关联本笔卖出的 ${required} 股`, type: 'warning' })
      return
    }
    if (assigned < required && !allowPartial) {
      notificationOpen({
        message: '合计不等于卖出股数',
        description: `已分配 ${assigned} 股，还差 ${required - assigned} 股；只挂一部分请勾「允许挂不满」`,
        type: 'warning',
      })
      return
    }
    for (const it of items) {
      const c = candidates.find((x) => x.lot.sourceRow === it.row)
      if (!c || it.qty > c.available) {
        notificationOpen({ message: `${recordNoLabel(it.row, recordNo)}最多挂 ${c?.available ?? 0} 股`, type: 'warning' })
        return
      }
    }
    try {
      await setHedgeLink(sellRow, items)
      notificationOpen({
        message: assigned > 0 ? (sandboxMode ? '模拟挂钩已保存' : '已挂钩') : '已解除挂钩',
        description:
          assigned > 0
            ? sandboxMode
              ? `这 ${assigned} 股只记在沙盒预览里；点「记为成交」才转成真实挂钩`
              : `这 ${assigned} 股按原高位成本结算；回补后仍保留亏损和回本链`
            : '没有分配任何股数，等于解除',
        type: 'success',
      })
      onSaved?.()
    } catch (e) {
      notificationOpen({ message: '挂钩失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  async function clear() {
    try {
      await clearHedgeLink(sellRow)
      notificationOpen({ message: '已解除挂钩', type: 'info' })
      onSaved?.()
    } catch (e) {
      notificationOpen({ message: '解除失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  if (!rec || !isHedgeable(rec, execQty)) {
    return (
      <p className="tiny muted" style={{ margin: 0 }}>
        这行不是先卖后买，不需要挂钩。
      </p>
    )
  }

  return (
    <div className="hedge-binder">
      {/* V9.33 异常红条：失效 / 超挂 / 挂不满就地提示，不用跑去管理·校验找 */}
      {issues.length > 0 && (
        <div className="hedge-issues" role="status">
          {issues.map((a, i) => (
            <div key={i}>⚠ {a.detail}</div>
          ))}
        </div>
      )}

      <p className="tiny muted" style={{ margin: '0 0 8px' }}>
        {sandboxMode ? '沙盒预演：' : ''}选还没卖完的买单，把这笔卖的 <b>{qty(required)} 股</b>（
        {price(sellPrice)} 卖出
        {execQty > 0 ? `，已回补 ${qty(execQty)} 股` : ''}）算到它头上：
        被挂份额退出待卖、按（卖价 − 买价）记为亏损。
        {sandboxMode
          ? '只影响概览预览，点「记为成交」才会写进明细。'
          : '默认已按卖出日期分配最高价剩余买单；可在这里改挂。买回后的高位亏损仍留在链中，后续完成网格交易再抵减。'}
      </p>

      {sellPrice === null && (
        <p className="tiny up" style={{ margin: '0 0 8px' }}>
          这笔卖缺成交价（E 列），补上之前挂上去也暂记不了亏损。
        </p>
      )}

      <div className="data-block">
        {visible.map(({ lot, available }) => (
          <div key={lot.sourceRow} className="line">
            <div className="left">
              <div className="t1 num">
                买 {price(lot.buyPriceCents)} × {qty(lot.qty)}
              </div>
              <div className="t2">
                {isSandboxRow(lot.sourceRow) && <span className="sandbox-mark">模拟批次 · </span>}
                {sellPrice !== null && lot.buyPriceCents <= sellPrice && <span className="up">低位（挂上去记盈利）· </span>}
                {recordNoLabel(lot.sourceRow, recordNo)} · 买入 {lot.buyDate ?? '—'} · 目标 {price(lot.targetPriceCents)} · 可挂 {qty(available)}
              </div>
            </div>
            <Input
              className="hedge-qty"
              value={draft[lot.sourceRow] ?? ''}
              // V9.62：占位直接给「最多可挂量」——上限一目了然；留空仍表示不挂（防误挂满）
              placeholder={`≤${qty(available)}`}
              onChange={(e) => setDraft({ ...draft, [lot.sourceRow]: e.target.value })}
              data-field={`hedge-${lot.sourceRow}`}
              aria-label={`挂到${recordNoLabel(lot.sourceRow, recordNo)}的股数`}
            />
          </div>
        ))}
        {visible.length === 0 && (
          <p className="tiny muted" style={{ margin: 0 }}>
            {candidates.length === 0
              ? '没有可挂的未完成买单（同股票、还没卖完、有剩余份额）'
              : '没有高于卖价的未完成买单；点下面「显示全部」可以挂低位的'}
          </p>
        )}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Tag size="small" variant="soft" color={showAll ? 'app-teal' : 'default'} onClick={() => setShowAll(!showAll)}>
          {showAll ? '只显示高位买单' : `显示全部 ${candidates.length} 条`}
        </Tag>
        <Tag
          size="small"
          variant="soft"
          color={allowPartial ? 'app-orange' : 'default'}
          onClick={() => setAllowPartial(!allowPartial)}
        >
          {allowPartial ? '允许挂不满（差额算敞口）' : '必须挂满'}
        </Tag>
        <Button size="small" type="text" onClick={autoFill}>自动挂满</Button>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          className="tiny num"
          style={{ color: diff === 0 ? 'var(--animal-text-color-secondary, #9f927d)' : 'var(--up)' }}
        >
          已分配 {qty(assigned)} / {qty(required)} 股
        </span>
        {lossCents !== null && assigned > 0 && (
          <span className={`tiny num ${tone(lossCents)}`} title="按（卖价 − 买价）× 股数，记在被挂的买单行上">
            记亏 {signedMoney(lossCents)}
          </span>
        )}
        <div className="spacer" />
        <Button size="small" type="primary" data-action="save-hedge" onClick={() => void save()}>
          保存挂钩
        </Button>
        {link && (
          <Button size="small" danger onClick={() => void clear()}>
            解除并停止自动关联
          </Button>
        )}
      </div>
    </div>
  )
}

/** 从明细行/挂单行的「裸卖待挂钩」标签点开的弹层：内容就是上面这个面板 */
export function HedgeSheet({
  sellRow,
  onClose,
  mode = 'real',
}: {
  sellRow: number | null
  onClose: () => void
  mode?: 'real' | 'sandbox'
}) {
  return (
    <Modal
      open={sellRow !== null}
      title={mode === 'sandbox' ? '沙盒挂钩预演' : '先卖后买 · 高位关联'}
      typewriter={false}
      className="hedge-modal"
      onClose={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      {sellRow !== null && <HedgeBinder sellRow={sellRow} onSaved={onClose} mode={mode} />}
    </Modal>
  )
}
