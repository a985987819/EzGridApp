/**
 * 回本链归属（V9.46）：把「独立录入的低位买卖」人工挂到某条亏损清仓的链上。
 *
 * **只写 chainLinks 关联，records 一分不动**：每笔的盈亏仍由 buildLedger 每次重算，
 * 一笔只能归一条链（先到先得），归进来后它的**已实现净盈利**就累加到那条链的进度上。
 * 链上的「＋ 新增一笔」会把新行自动归入本链（链发起的交易自动继承归属）。
 */
import { useMemo, useState } from 'react'
import { Button, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../store/useApp'
import { recordNoLabel } from '../domain/recordNo'
import type { Ledger } from '../domain/types'
import { money, price, qty, signedMoney } from '../ui/format'

export function ChainBinder({
  row,
  onAddToChain,
}: {
  row: number
  /** 「＋ 新增一笔归入本链」：由明细页打开新增表单，落库后自动归入这条链 */
  onAddToChain?: (anchorRow: number) => void
}) {
  const {
    ledger,
    records,
    recordNo,
    chainLinks,
    setChainMembers,
    removeFromChain,
    closeRepairChain,
    reopenRepairChain,
  } = useApp()
  const chain = ledger.repairChains.find((c) => c.anchorRow === row) ?? null
  const link = chainLinks.find((l) => l.anchorRow === row) ?? null
  /** 这一行是被别的链收进来的成员 → 只给一个「移出」出口 */
  const asMember = chainLinks.find((l) => l.memberRows.includes(row)) ?? null
  const memberOf = asMember ? ledger.repairChains.find((c) => c.anchorRow === asMember.anchorRow) ?? null : null
  const rec = records.find((r) => r.sourceRow === row) ?? null

  const initial = () => (link?.memberRows ?? []).slice()
  const [selected, setSelected] = useState<number[]>(initial)

  /** 候选：同股票的真实买入批次；排除锚点、已归入别条链的行 */
  const candidates = useMemo(() => {
    if (!chain || !rec) return []
    const ownedElsewhere = new Set(
      chainLinks.filter((l) => l.anchorRow !== row).flatMap((l) => l.memberRows),
    )
    /** V9.49：已经被价位槽自动收编的行不再列出——它们已经在链里，勾进来只会打乱自动归属 */
    const autoRows = new Set(
      ledger.repairChains.flatMap((c) => c.branches.filter((b) => b.kind === 'sell').flatMap((b) => b.memberRows)),
    )
    return ledger.lots
      .filter((l) => l.id === `lot:${l.sourceRow}`)
      .filter((l) => l.stockName === chain.stockName && l.sourceRow !== chain.anchorRow)
      .filter((l) => !ownedElsewhere.has(l.sourceRow))
      .filter((l) => !autoRows.has(l.sourceRow))
      .filter((l) => !chainLinks.some((link)=>link.anchorRow===l.sourceRow && link.memberRows.length>0))
      .sort((a, b) => (b.buyDate ?? '').localeCompare(a.buyDate ?? '') || b.sourceRow - a.sourceRow)
  }, [chain, ledger.lots, ledger.repairChains, chainLinks, rec, row])

  if (memberOf) {
    return (
      <div className="divider-top" data-testid="chain-member">
        <div className="row nowrap" style={{ gap: 6 }}>
          <span className="tiny muted grow">
            本笔归入 <b>{recordNoLabel(memberOf.anchorRow, recordNo)}</b> 的回本链
            {memberOf.done ? '（已不亏钱）' : ` · 那条链还差 ${money(memberOf.gapCents)}`}
          </span>
          <Button size="small" data-action="chain-leave" onClick={() => void removeFromChain(row)}>
            移出回本链
          </Button>
        </div>
      </div>
    )
  }

  if (!chain) return null

  const anchorRow = chain.anchorRow
  const picked = candidates.filter((c) => selected.includes(c.sourceRow))

  const toggle = (r: number) =>
    setSelected((s) => (s.includes(r) ? s.filter((x) => x !== r) : [...s, r]))

  async function save() {
    try {
      await setChainMembers(anchorRow, selected)
      notificationOpen({
        message: selected.length ? `已归入 ${selected.length} 笔` : '已解除归属',
        description: '链的进度按这些交易的已实现盈亏重算，明细数据没动',
        type: 'success',
      })
    } catch (e) {
      notificationOpen({ message: '归属失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    }
  }

  async function close() {
    if (selected.length > 0 && !sameList(selected, link?.memberRows ?? [])) {
      await setChainMembers(anchorRow, selected)
    }
    await closeRepairChain(anchorRow)
    notificationOpen({
      message: '这条链已结束',
      description: '历史与归属都留着；之后再做的交易算独立的一笔',
      type: 'success',
    })
  }

  return (
    <div className="divider-top" data-testid="chain-binder">
      <div className="sec-head sm">
        <strong>回本链归属</strong>
        <div className="spacer" />
        <span className="sec-sub">
          {chain.done ? '已不亏钱' : `还差 ${money(chain.gapCents)}`} · 持仓 {qty(chain.holdingQty)} 股
        </span>
      </div>

      <div className="data-block chain-candidates" data-testid="chain-candidates">
        {candidates.length === 0 && <p className="tiny muted" style={{ margin: 0 }}>没有可归属的买入批次。</p>}
        {candidates.map((c) => (
          <label key={c.sourceRow} className="line merge-row" data-chain-candidate={c.sourceRow}>
            <input
              type="checkbox"
              checked={selected.includes(c.sourceRow)}
              onChange={() => toggle(c.sourceRow)}
              aria-label={`归入 ${recordNoLabel(c.sourceRow, recordNo)}`}
            />
            <div className="left">
              <div className="t1">
                {recordNoLabel(c.sourceRow, recordNo)}
                <span className="muted" style={{ fontWeight: 400 }}>
                  {' '}
                  · {price(c.buyPriceCents)} 买 × {qty(c.qty)} 股
                </span>
                {c.remainingQty > 0 && (
                  <Tag size="small" variant="soft" color="app-blue" style={{ marginLeft: 6 }}>
                    手持 {qty(c.remainingQty)}
                  </Tag>
                )}
              </div>
              <div className="t2">
                {c.buyDate ?? '—'} · 已卖 {qty(c.soldQty)} 股{c.remainingQty > 0 ? ' · 未卖出部分只算持仓' : ''}
              </div>
            </div>
            <span className="num">{signedMoney(profitOf(ledger, c.sourceRow))}</span>
          </label>
        ))}
      </div>

      <div className="row nowrap" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <span className="tiny muted grow">
          已选 {picked.length} 笔 · 已实现合计 {signedMoney(picked.reduce((a, c) => a + profitOf(ledger, c.sourceRow), 0))}
        </span>
        <Button size="small" type="primary" data-action="chain-save" onClick={() => void save()}>
          保存归属
        </Button>
        {onAddToChain && (
          <Button size="small" data-action="chain-add" onClick={() => onAddToChain(chain.anchorRow)}>
            ＋ 新增一笔归入本链
          </Button>
        )}
        {chain.closedByUserAt === null ? (
          <Button size="small" data-action="chain-close" onClick={() => void close()}>
            结束这条链
          </Button>
        ) : (
          <Button size="small" data-action="chain-reopen" onClick={() => void reopenRepairChain(chain.anchorRow)}>
            重新打开
          </Button>
        )}
      </div>
      <p className="tiny muted" style={{ margin: '6px 0 0' }}>
        每笔盈亏只归属一次：勾进来就计入这条链的「后续净盈利」，取消勾选即退回独立交易。买回还没卖出的部分只算持仓，不计回本。
      </p>
    </div>
  )
}

function sameList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => b[i] === x)
}

/** 某一行的已实现卖出盈亏（链的进度就靠它，口径与 domain/chain.ts 一致） */
function profitOf(ledger: Ledger, row: number): number {
  return ledger.sells
    .filter((s) => s.sourceRow === row && (s.hedgedFromSellRow === undefined || s.hedgeClosed === true))
    .reduce((a, s) => a + (s.profitCents ?? 0), 0)
}
