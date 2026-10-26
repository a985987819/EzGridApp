import { Tag } from 'animal-island-ui'
import type { RepairChain } from '../domain/types'
import { money, price, qty, signedMoney, tone } from '../ui/format'

/**
 * 回本链（V9.46 新口径）：一次「亏着清仓」的原始亏损 + 后续归属交易的**已实现净盈利**。
 *
 * 用户口径：10 元买 1000 股、7 元清仓 → 当场确认 −3,000 并成链；
 *   之后 6 元买 500 卖 8 元（+1,000）、5 元买 500 卖 7 元（+1,000）归进来 →
 *   还差 1,000、覆盖 66%。**买回没卖出不算回本**，只算持仓；
 *   「卖 7 买 6 省下的钱」单独显示为回补节省，绝不与再卖出的盈利相加（相加就双算了）。
 */
export function RepairChainCard({
  chain,
  dense = false,
  rowLabel,
}: {
  chain: RepairChain
  dense?: boolean
  /** 行身份（V9.43）：明细/概览传「第 N 笔」，不再露出 Excel 行号 */
  rowLabel: (row: number) => string
}) {
  const pct = Math.round(chain.covered * 100)
  return (
    <div className="chain-card" data-chain={chain.anchorRow}>
      <div className="chain-head">
        <strong>回本链</strong>
        <Tag size="small" variant="soft" color={chain.done ? 'app-green' : 'app-yellow'}>
          {chain.done ? '已不亏钱' : `还差 ${money(chain.gapCents)}`}
        </Tag>
        {chain.closedByUserAt !== null && (
          <Tag size="small" variant="soft" color="default">
            已结束
          </Tag>
        )}
        <div className="spacer" />
        <span className="tiny muted">
          高位 {price(chain.anchorCostCents)} × {qty(chain.anchorQty)}
        </span>
      </div>

      <p className="tiny muted chain-line">
        {rowLabel(chain.anchorRow)}
        {chain.closedAtCents !== null && <> 已于 <b>{price(chain.closedAtCents)}</b> 卖出了结</>}；
        之后归属它的交易每实现一笔净盈利就往这里累加，一直不买回这笔亏损也留在账上。
      </p>

      <div className="chain-nums">
        <div className="chain-num">
          <span className="tiny muted">原始亏损</span>
          <b className="num down">{signedMoney(chain.lossCents)}</b>
        </div>
        <div className="chain-num">
          <span className="tiny muted">后续净盈利</span>
          <b className={`num ${tone(chain.profitCents)}`}>{signedMoney(chain.profitCents)}</b>
        </div>
        <div className="chain-num">
          <span className="tiny muted">链累计盈亏</span>
          <b className={`num ${tone(chain.netCents)}`}>{signedMoney(chain.netCents)}</b>
        </div>
        <div className="chain-num">
          <span className="tiny muted">还差多少</span>
          <b className="num">{chain.done ? '已不亏钱' : money(chain.gapCents)}</b>
        </div>
      </div>

      <div className="chain-bar" title={`后续净盈利 ${money(chain.profitCents)} / 原始亏损 ${money(-chain.lossCents)}`}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="chain-bar-meta">
        <span className="tiny">
          已覆盖 <b>{pct}%</b>
        </span>
        <div className="spacer" />
        <span className="tiny muted">
          当前持有 {qty(chain.holdingQty)} 股
          {chain.plannedQty > 0 && <> · 计划再买回 {qty(chain.plannedQty)} 股</>}
        </span>
      </div>

      {(chain.savingCents !== 0 || chain.unallocatedLossCents !== 0) && (
        <p className="tiny muted chain-line">
          {chain.savingCents !== 0 && (
            <>
              回补价差省下 <b className={tone(chain.savingCents)}>{signedMoney(chain.savingCents)}</b>
              （只作参考，<b>不计入回本进度</b>）
            </>
          )}
          {chain.savingCents !== 0 && chain.unallocatedLossCents !== 0 && '；'}
          {chain.unallocatedLossCents !== 0 && (
            <>
              还有 {qty(chain.plannedQty)} 股没买回，对应亏损{' '}
              <b className="down">{signedMoney(chain.unallocatedLossCents)}</b> 暂未分摊
            </>
          )}
        </p>
      )}

      {!dense && chain.branches.length > 0 && (
        <div className="data-block chain-cycles">
          {chain.branches.map((b) => (
            <div key={b.key} className="line" data-branch={b.kind}>
              <div className="left">
                <div className="t1 num">
                  {b.kind === 'sell' ? (
                    b.rootSellRow === null && b.sellPriceCents === null ? (
                      <>
                        P 档 {price(b.buyPriceCents)} 买回
                        <span className="muted">
                          {' '}
                          · 买 {qty(b.qty)} 股{b.remainingQty > 0 ? `（手持 ${qty(b.remainingQty)}）` : ''} · 卖了 {b.cycles} 次
                        </span>
                      </>
                    ) : (
                      <>
                        {b.sellPriceCents === null ? '—' : price(b.sellPriceCents)} 卖 → {price(b.buyPriceCents)} 买回
                        <span className="muted"> · 卖了 {b.cycles} 次</span>
                      </>
                    )
                  ) : (
                    <>
                      {price(b.buyPriceCents)} 买 → {b.sellPriceCents === null ? '未卖出' : price(b.sellPriceCents)} 卖
                      <span className="muted">
                        {' '}
                        · {qty(b.sellQty > 0 ? b.sellQty : b.qty)} 股
                        {b.remainingQty > 0 && `（手持 ${qty(b.remainingQty)}）`}
                      </span>
                    </>
                  )}
                  {b.netCents >= 0 && b.profitCents > 0 && (
                    <Tag size="small" variant="soft" color="app-green" style={{ marginLeft: 6 }}>
                      本支回本
                    </Tag>
                  )}
                </div>
                <div className="t2">
                  {b.kind === 'sell' ? (
                    b.rootSellRow === null && b.sellPriceCents === null ? (
                      <>
                        锚点 P 档 · 之后买在这个价位的批次自动归档，卖出盈利逐笔累加
                        {b.allocatedLossCents !== 0 && ` · 分摊亏损 ${money(b.allocatedLossCents)}`}
                        {b.savingCents !== 0 && ` · 回补省 ${money(b.savingCents)}`}
                      </>
                    ) : (
                      <>
                        价位槽 · 根 {b.rootSellRow !== null ? rowLabel(b.rootSellRow) : '—'}
                        {b.remainingQty > 0 ? ` · 手持 ${qty(b.remainingQty)}` : ''}
                        {b.allocatedLossCents !== 0 && ` · 分摊亏损 ${money(b.allocatedLossCents)}`}
                      </>
                    )
                  ) : (
                    <>
                      {b.kind === 'rebuy' ? '回补批次' : b.row !== null ? rowLabel(b.row) : '后续买入'}
                      {b.buyDate ? ` · ${b.buyDate} 买入` : ''}
                      {b.soldAt ? ` · ${b.soldAt} 卖出` : ''}
                      {b.allocatedLossCents !== 0 && ` · 分摊亏损 ${money(b.allocatedLossCents)}`}
                      {b.savingCents !== 0 && ` · 回补省 ${money(b.savingCents)}`}
                    </>
                  )}
                </div>
              </div>
              <span className={`num ${tone(b.netCents)}`}>
                {signedMoney(b.netCents)}
                {b.profitCents !== b.netCents && (
                  <span className="tiny muted"> （已实现 {signedMoney(b.profitCents)}）</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {!dense && chain.branches.length === 0 && (
        <p className="tiny muted" style={{ margin: '6px 0 0' }}>
          还没有归属交易：在这条链上「归入一笔」低位买卖，它的已实现盈亏就累加进来。
        </p>
      )}
    </div>
  )
}
