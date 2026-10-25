import { Tag } from 'animal-island-ui'
import type { RepairChain } from '../domain/types'
import { money, price, qty, signedMoney, tone } from '../ui/format'

/**
 * 回本链（V9.36）：把一个高位批次的「了结亏损」和低位做T的「回血」摆在一起。
 *
 * 用户口径：10 元买 500 股、7 元先卖后买挂在它上面、6 元回补 →
 *   高位那笔按 7 元永久了结（记亏 −1,500，不再复活成待卖，股数才对得上），
 *   回补的 500 股成为唯一实盘批次；之后每做一轮「卖高 → 回补低」，
 *   价差就累加到这条链上，够 1,500 就把这笔 10 元买入彻底冲平。
 */
export function RepairChainCard({ chain, dense = false }: { chain: RepairChain; dense?: boolean }) {
  const need = Math.abs(chain.lossCents)
  const pct = need <= 0 ? 100 : Math.min(100, Math.round((chain.recoveredCents / need) * 100))
  return (
    <div className="chain-card" data-chain={chain.anchorRow}>
      <div className="chain-head">
        <strong>回本链</strong>
        <Tag size="small" variant="soft" color={chain.done ? 'app-green' : 'app-yellow'}>
          {chain.done ? '已冲平' : `还差 ${money(chain.gapCents)}`}
        </Tag>
        <div className="spacer" />
        <span className="tiny muted">
          高位 {price(chain.anchorCostCents)} × {qty(chain.anchorQty)}
        </span>
      </div>

      <p className="tiny muted chain-line">
        已于 <b>{price(chain.closedAtCents)}</b> 了结，记亏{' '}
        <b className="down">{signedMoney(chain.lossCents)}</b>
        ；低位每轮「卖高 → 回补低」的价差都补进来，凑够就冲平
        （那时有效成本降到 {price(chain.closedAtCents)}）。
      </p>

      <div className="chain-bar" title={`已回血 ${money(chain.recoveredCents)} / ${money(need)}`}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="chain-bar-meta">
        <span className="tiny">
          已回血 <b className="up">{signedMoney(chain.recoveredCents)}</b> / {money(need)} · {pct}%
        </span>
        <div className="spacer" />
        <span className="tiny muted">
          有效成本 {price(chain.anchorCostCents)} → <b className={tone(chain.anchorCostCents - chain.effectiveCostCents)}>
            {price(chain.effectiveCostCents)}
          </b>
        </span>
      </div>

      {!dense && chain.cycles.length > 0 && (
        <div className="data-block chain-cycles">
          {chain.cycles.map((c, i) => (
            <div key={`${c.sellRow}-${i}`} className="line">
              <div className="left">
                <div className="t1 num">
                  {price(c.sellPriceCents)} 卖 → {c.rebuyPriceCents === null ? '未回补' : `${price(c.rebuyPriceCents)} 回补`}
                  <span className="muted"> · {qty(c.qty)} 股</span>
                  {c.belowEffectiveCost && (
                    <Tag size="small" variant="soft" color="app-red" style={{ marginLeft: 6 }}>
                      低于摊薄成本
                    </Tag>
                  )}
                </div>
                <div className="t2">
                  行 {c.sellRow}
                  {c.soldAt ? ` · ${c.soldAt}` : ''} · 当时有效成本 {price(c.effectiveCostAtCents)}
                </div>
              </div>
              <span className={`num ${tone(c.recoveredCents)}`}>{signedMoney(c.recoveredCents)}</span>
            </div>
          ))}
        </div>
      )}

      {chain.cycles.length === 0 && (
        <p className="tiny muted" style={{ margin: '6px 0 0' }}>
          还没有回补配对：低位再做一轮「先卖后买 + 回补」，价差会自动累加到这里。
        </p>
      )}
    </div>
  )
}
