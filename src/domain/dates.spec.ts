import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseWorkbook } from '../io/parseWorkbook'
import { buildLedger } from './ledger'
import { DEFAULT_STOCKS } from './defaults'

const buf = readFileSync(resolve(process.cwd(), 'tests/fixtures/26年网格记录.xlsx'))
const parsed = await parseWorkbook(new Uint8Array(buf))
const ledger = buildLedger(parsed.records, DEFAULT_STOCKS)

describe('真实文件的日期完整性', () => {
  it('买入日期只缺 R60–63（那 4 行本身是先卖后买，没有买入日期）', () => {
    const missing = parsed.records.filter((r) => r.buyDateSerial === null).map((r) => r.sourceRow)
    expect(missing).toEqual([60, 61, 62, 63])
  })

  it('其余 58 行的买入日期都能解析成真实日期', () => {
    const ok = parsed.records.filter((r) => r.buyDateSerial !== null)
    expect(ok).toHaveLength(58)
    for (const r of ok) expect(r.buyDateSerial).toBeGreaterThan(40000)
  })

  it('卖出日期：24 笔有真实日期，9 笔是 =TODAY() 公式且工作簿没存计算结果', () => {
    const realSells = ledger.sells.filter((s) => s.hedgedFromSellRow === undefined)
    const withDate = realSells.filter((s) => s.soldAt !== null)
    const missing = realSells.filter((s) => s.soldAt === null).map((s) => s.sourceRow)
    expect(realSells).toHaveLength(33)
    expect(withDate).toHaveLength(24)
    // 这 9 行是「填了实现份数、卖出日期用 TODAY() 自动填」的写法，文件里没有缓存值
    expect(missing).toEqual([46, 47, 49, 50, 57, 60, 61, 62, 63])
  })

  it('缺日期的行都带 needsTodayFormula 标记，便于界面说明原因', () => {
    for (const row of [46, 47, 49, 50, 57, 60, 61, 62, 63]) {
      const rec = parsed.records.find((r) => r.sourceRow === row)!
      expect(rec.sellDateNeedsToday).toBe(true)
    }
    for (const row of [60, 61, 62, 63]) {
      const rec = parsed.records.find((r) => r.sourceRow === row)!
      expect(rec.buyDateNeedsToday).toBe(true)
    }
    // 有真实日期的行不该带这个标记
    expect(parsed.records.find((r) => r.sourceRow === 2)!.sellDateNeedsToday).toBeFalsy()
  })
})
