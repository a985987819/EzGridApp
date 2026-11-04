import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from 'animal-island-ui'
import { parseRecordSelection } from '../domain/recordSelection'
import { toCents, centsToYuan } from '../domain/money'
import { isoToSerial } from '../domain/edit'
import { serialToIso } from '../domain/defaults'
import { DateField } from '../ui/DateField'

export interface TradeRangeFilter {
  priceLo: number | null
  priceHi: number | null
  from: string
  to: string
}

/** 输入草稿只在应用时生效，避免打到一半就把列表筛空。 */
export function TradeFilterTools({
  nos, range, onSelectNumbers, onApplyRange, onClearRange,
}: {
  nos: string
  range: TradeRangeFilter
  onSelectNumbers: (value: string) => void
  onApplyRange: (value: TradeRangeFilter) => void
  onClearRange: () => void
}) {
  const [numbers, setNumbers] = useState(nos)
  const [numberError, setNumberError] = useState<string | null>(null)
  const [low, setLow] = useState(range.priceLo === null ? '' : centsToYuan(range.priceLo))
  const [high, setHigh] = useState(range.priceHi === null ? '' : centsToYuan(range.priceHi))
  const [from, setFrom] = useState(range.from)
  const [to, setTo] = useState(range.to)
  const [rangeError, setRangeError] = useState<string | null>(null)
  useEffect(() => { setNumbers(nos); setNumberError(null) }, [nos])
  useEffect(() => {
    setLow(range.priceLo === null ? '' : centsToYuan(range.priceLo))
    setHigh(range.priceHi === null ? '' : centsToYuan(range.priceHi))
    setFrom(range.from)
    setTo(range.to)
    setRangeError(null)
  }, [range.priceLo, range.priceHi, range.from, range.to])

  function selectNumbers(event: FormEvent) {
    event.preventDefault()
    const result = parseRecordSelection(numbers)
    setNumberError(result.error)
    if (!result.error) onSelectNumbers(numbers.trim())
  }
  function applyRange(event: FormEvent) {
    event.preventDefault()
    const priceLo = low.trim() ? toCents(low) : null
    const priceHi = high.trim() ? toCents(high) : null
    const fromSerial = from.trim() ? isoToSerial(from) : null
    const toSerial = to.trim() ? isoToSerial(to) : null
    let error: string | null = null
    if ((low.trim() && (priceLo === null || priceLo <= 0 || !Number.isSafeInteger(priceLo))) || (high.trim() && (priceHi === null || priceHi <= 0 || !Number.isSafeInteger(priceHi)))) error = '价格请填写有效且大于0的金额'
    else if (priceLo !== null && priceHi !== null && priceLo > priceHi) error = '最低价不能高于最高价'
    else if ((from.trim() && fromSerial === null) || (to.trim() && toSerial === null)) error = '日期请填写有效的年月日'
    const nextFrom = fromSerial === null ? '' : serialToIso(fromSerial) ?? ''
    const nextTo = toSerial === null ? '' : serialToIso(toSerial) ?? ''
    if (!error && nextFrom && nextTo && nextFrom > nextTo) error = '开始日期不能晚于结束日期'
    setRangeError(error)
    if (!error) onApplyRange({ priceLo, priceHi, from: nextFrom, to: nextTo })
  }

  return <div className="trade-filter-tools">
    <form onSubmit={selectNumbers} className="record-selection-form">
      <label htmlFor="record-selection-input" className="tiny">按第几笔查找</label>
      <div className="record-selection-controls">
        <Input id="record-selection-input" value={numbers} onChange={event => { setNumbers(event.target.value); setNumberError(null) }}
          placeholder="如 2、5、8-10" data-testid="record-selection-input" aria-describedby="record-selection-help" aria-invalid={Boolean(numberError)} />
        <Button size="small" htmlType="submit" data-action="apply-record-selection">应用序号</Button>
        {nos && <Button size="small" type="text" data-action="clear-record-selection" onClick={() => onSelectNumbers('')}>清除</Button>}
      </div>
      <p id="record-selection-help" className="tiny muted">逗号分隔多笔，短横线表示连续范围；应用后替换来源限定。</p>
      {numberError && <p className="tiny trade-filter-error" data-testid="record-selection-error" role="alert">{numberError}</p>}
    </form>
    <details className="trade-range-filter" data-testid="trade-range-filter">
      <summary>价格与日期筛选</summary>
      <form onSubmit={applyRange}>
        <div className="trade-range-fields">
          <label><span>最低价（元）</span><Input value={low} onChange={event => setLow(event.target.value)} inputMode="decimal" placeholder="不限" data-testid="filter-price-low" aria-label="最低价格" /></label>
          <label><span>最高价（元）</span><Input value={high} onChange={event => setHigh(event.target.value)} inputMode="decimal" placeholder="不限" data-testid="filter-price-high" aria-label="最高价格" /></label>
          <label><span>开始日期</span><DateField value={from} onChange={setFrom} data-field="filter-from" aria-label="筛选开始日期" placeholder="不限" /></label>
          <label><span>结束日期</span><DateField value={to} onChange={setTo} data-field="filter-to" aria-label="筛选结束日期" placeholder="不限" /></label>
        </div>
        <p className="tiny muted">价格匹配买入价、卖出价、目标价或回补价；卖出日期缺失时取买入日期。与股票、状态条件同时生效。</p>
        {rangeError && <p className="tiny trade-filter-error" role="alert">{rangeError}</p>}
        <div className="row"><Button size="small" htmlType="submit" data-action="apply-range-filter">应用区间</Button>
          <Button size="small" type="text" onClick={() => { setLow(''); setHigh(''); setFrom(''); setTo(''); setRangeError(null); onClearRange() }} data-action="clear-range-filter">清除区间</Button></div>
      </form>
    </details>
  </div>
}
