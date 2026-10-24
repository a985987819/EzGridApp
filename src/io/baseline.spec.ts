import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseWorkbook } from './parseWorkbook'
import { buildLedger } from '../domain/ledger'
import { BASELINE, DEFAULT_STOCKS } from '../domain/defaults'
import { compareBaseline } from '../domain/baseline'

const buf = readFileSync(resolve(process.cwd(), 'tests/fixtures/26年网格记录.xlsx'))
const parsed = await parseWorkbook(new Uint8Array(buf))
const ledger = buildLedger(parsed.records, DEFAULT_STOCKS)

describe('真实文件 dry-run：8 个基准数（文档 §03 / S2 验收）', () => {
  it('只读第 1 个工作表「交易记录」', () => {
    expect(parsed.sheetName).toBe('交易记录')
  })

  it('62 行有效数据', () => {
    expect(ledger.totals.rows).toBe(BASELINE.rows)
  })

  it('买入 31,800 股 / ¥360,320', () => {
    expect(ledger.totals.buyQty).toBe(BASELINE.buyQty)
    expect(ledger.totals.buyAmountCents).toBe(BASELINE.buyAmountCents)
  })

  it('卖出 33 笔 / 18,600 股 / ¥190,558（文档 ¥190,559，差 ¥1 来自 E10=6.331 取整到分）', () => {
    expect(ledger.totals.sellCount).toBe(BASELINE.sellCount)
    expect(ledger.totals.sellQty).toBe(BASELINE.sellQty)
    expect(ledger.totals.sellAmountCents).toBe(19055800)
    expect(Math.abs(ledger.totals.sellAmountCents - BASELINE.sellAmountCents)).toBeLessThanOrEqual(100)
  })

  it('实现盈利 ¥9,830（文档 ¥9,831，R44 缺 E 不入池）', () => {
    expect(ledger.totals.profitCents).toBe(983000)
    expect(Math.abs(ledger.totals.profitCents - BASELINE.profitCents)).toBeLessThanOrEqual(100)
  })

  it('基准快照 16 项全部通过（容差内）', () => {
    const checks = compareBaseline(ledger)
    for (const c of checks) {
      expect(c.ok, `${c.name}: ${c.actual} vs ${c.expected}`).toBe(true)
    }
  })

  it('待卖 29 条 / 15,200 股 / ¥202,284 / 预期收益 ¥12,515', () => {
    expect(ledger.totals.targetCount).toBe(BASELINE.targetCount)
    expect(ledger.totals.targetQty).toBe(BASELINE.targetQty)
    expect(ledger.totals.targetAmountCents).toBe(BASELINE.targetAmountCents)
    expect(ledger.totals.expectProfitCents).toBe(BASELINE.expectProfitCents)
  })

  it('待买 4 条 / 2,100 股（含奖励 100 股）/ ¥16,601', () => {
    expect(ledger.totals.rebuyCount).toBe(BASELINE.rebuyCount)
    expect(ledger.totals.rebuyBaseQty).toBe(BASELINE.rebuyBaseQty)
    expect(ledger.totals.rewardQty).toBe(BASELINE.rewardQty)
    expect(ledger.totals.rebuyQty).toBe(BASELINE.rebuyQty)
    expect(ledger.totals.rebuyAmountCents).toBe(BASELINE.rebuyAmountCents)
  })

  it('净持仓 13,200 = 可卖 15,200 − 待补 2,000', () => {
    expect(ledger.totals.netQty).toBe(BASELINE.netQty)
    expect(ledger.totals.targetQty - ledger.totals.rebuyBaseQty).toBe(BASELINE.netQty)
    expect(ledger.totals.exposureQty).toBe(BASELINE.exposureQty)
  })

  it('三条守恒式全部成立（R7）', () => {
    for (const c of ledger.checks) {
      expect(c.ok, `${c.name}: ${c.actual}`).toBe(true)
    }
  })
})

describe('规则落地细节', () => {
  it('D2：33 笔历史卖出里只有 4 笔生成待买', () => {
    expect(ledger.sells.filter((s) => s.rebuyStatus === 'pending')).toHaveLength(4)
    expect(ledger.sells.filter((s) => s.rebuyStatus === 'repaid')).toHaveLength(29)
  })

  it('待买回补价取 P 列：8.01 / 7.71 / 8.11 / 7.81', () => {
    const prices = ledger.orders.map((o) => o.rebuyPriceCents).sort((a, b) => a - b)
    expect(prices).toEqual([771, 781, 801, 811])
  })

  it('7.81 组 1 手 100 股挂给 R63（不是已回补的 R46）', () => {
    const r63 = ledger.orders.find((o) => o.sourceRow === 63)
    expect(r63?.rewardQty).toBe(100)
    const r46Reward = ledger.orders.filter((o) => o.sourceRow === 46)
    expect(r46Reward).toHaveLength(0)
    const pool = ledger.groups.find((g) => g.groupKey === 'acc:default|stock:柳工|781')
    expect(pool?.grossProfitCents).toBe(99500)
    expect(pool?.capacityHands).toBe(1)
  })

  it('其余 3 组 0 手', () => {
    for (const o of ledger.orders) {
      if (o.groupKey === 'acc:default|stock:柳工|781') continue
      expect(o.rewardQty).toBe(0)
    }
  })

  it('D4：先卖后买 5 行合法，不进异常清单', () => {
    const rows = ledger.sells.filter((s) => s.sellBeforeBuy).map((s) => s.sourceRow)
    expect(rows).toEqual([40, 60, 61, 62, 63])
    expect(ledger.anomalies.some((a) => a.kind === 'needsPrice' && a.sourceRow === 40)).toBe(false)
    expect(ledger.anomalies).toHaveLength(12)
  })

  it('缺日期 9 笔，单列一桶', () => {
    expect(ledger.sells.filter((s) => s.dateMissing)).toHaveLength(9)
    expect(ledger.monthly.some((m) => m.month === '未填日期')).toBe(true)
  })

  it('R44 缺目标售价：不是待卖，也不入组池', () => {
    const sell = ledger.sells.find((s) => s.sourceRow === 44)
    expect(sell?.priceCents).toBeNull()
    expect(sell?.profitCents).toBeNull()
    expect(sell?.costComplete).toBe(false)
  })

  it('奥佳华 5 笔全部卖完，待卖 0', () => {
    const s = ledger.byStock.find((x) => x.stockName === '奥佳华')
    expect(s?.targetQty).toBe(0)
    expect(s?.sellCount).toBe(5)
    expect(s?.profitCents).toBe(-2000)
  })
})
