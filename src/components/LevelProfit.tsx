import type { GroupPool } from '../domain/types'
import { money, price, qty, signedMoney, tone } from '../ui/format'

/** 明细与挂单共用ledger.groups的同一份可奖励累计，不再另算一遍成交。 */
export function LevelProfit({ priceCents, group }: { priceCents: number; group?: GroupPool }) {
  const gross = group?.grossProfitCents ?? 0
  const used = group?.usedProfitCents ?? 0
  const balance = gross - used
  const available = Number.isSafeInteger(balance) ? Math.max(0, balance) : 0
  const rewardQty = Math.floor(available / (priceCents * 100)) * 100
  return <div className="level-profit" data-testid="level-profit" data-level-price={priceCents} data-gross={gross}
    data-used={used} data-available={available} data-reward-qty={rewardQty}>
    <div><span>当前价位累计盈利 <small>· {price(priceCents)} 元</small></span><b className={`num ${tone(gross)}`}>{signedMoney(gross)}</b></div>
    <p>已买奖励占用 {money(used)} · 剩余可用 {money(available)}{rewardQty > 0 ? ` · 可再买 ${qty(rewardQty)} 股` : ' · 暂不足一手'}</p>
    {(group?.chainLockedCents ?? 0) > 0 && <p className="level-profit-locked">回本占用未计入 {money(group!.chainLockedCents!)}</p>}
    {(group?.chainReleasedCents ?? 0) > 0 && <p>含已回本后的净超额 {money(group!.chainReleasedCents!)}</p>}
    {used > Math.max(0, gross) && <p className="level-profit-locked">已买奖励超过当前可计盈利，暂不新增奖励。</p>}
  </div>
}
