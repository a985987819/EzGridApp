import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseCsvText, parseWorkbook } from './parseWorkbook'
import { buildLedger } from '../domain/ledger'
import { DEFAULT_STOCKS } from '../domain/defaults'

/**
 * CSV 导入回归：用户把「交易记录」导出成纯值 CSV 后（公式已烘焙、日期成文本、
 * Excel 错误值变成 #VALUE! 字面量），解析结果必须与 xlsx 首表口径对齐。
 */
const csvText = readFileSync(resolve(process.cwd(), 'tests/fixtures/26年网格记录-工作表3.csv'), 'utf8')
const parsed = await parseCsvText(csvText)
const ledger = buildLedger(parsed.records, DEFAULT_STOCKS)

const byRow = new Map(parsed.records.map((r) => [r.sourceRow, r]))

describe('CSV 单表解析：结构与行级取值', () => {
  it('62 行有效数据，尾部 436 个空行全部跳过', () => {
    expect(parsed.records).toHaveLength(62)
    expect(parsed.skippedRows).toHaveLength(436)
    expect(parsed.missingColumns).toEqual([])
  })

  it('BOM 去除后表头命中，「股票/日期/…」全部识别', () => {
    // UTF-8 BOM（EF BB BF）如果没剥掉，第一列会变成 "\uFEFF股票"，整表报缺列
    expect(parsed.records[0].stockName).toBe('柳工')
  })

  it('文本日期换算成 1900 系统序列号，与 xlsx 完全一致', () => {
    expect(byRow.get(2)?.buyDateSerial).toBe(46050) // 2026/1/28
    expect(byRow.get(2)?.sellDateSerial).toBe(46080) // 2026/2/27
    expect(byRow.get(40)?.buyDateSerial).toBe(46238) // 2026/8/4
  })

  it('新补的卖出日期生效：R46=2026/10/23，R57=2026/10/20', () => {
    expect(byRow.get(46)?.sellDateSerial).toBe(46318)
    expect(byRow.get(57)?.sellDateSerial).toBe(46315)
  })

  it('R44 目标售价 19.88 已烘焙成实值，不再依赖成交价推定', () => {
    expect(byRow.get(44)?.targetPriceCents).toBe(1988)
    expect(byRow.get(44)?.targetNeedsDerive).toBe(false)
  })

  it('#VALUE! 错误串与浮点噪声都落到干净的整数分', () => {
    // R60-63 的实现比例/实现盈利在原表里是 #VALUE!，留痕字段应为 null
    expect(byRow.get(60)?.rawProfitCents).toBeNull()
    // R13 的 405.000000000001 应按 ROUND_HALF_UP 舍到分
    expect(byRow.get(13)?.rawProfitCents).toBe(40500)
    // R60-63 待买行：P 列回补价仍在
    expect(byRow.get(60)?.earlyBuyPriceCents).toBe(801)
    expect(byRow.get(63)?.earlyBuyPriceCents).toBe(781)
  })

  it('importKey 行级唯一（同内容行加 #n），重复解析幂等', async () => {
    expect(new Set(parsed.records.map((r) => r.importKey)).size).toBe(62)
    const again = await parseCsvText(csvText)
    expect(again.records.map((r) => r.importKey)).toEqual(parsed.records.map((r) => r.importKey))
  })

  it('去 BOM 后解析结果一致', async () => {
    const noBom = await parseCsvText(csvText.replace(/^\uFEFF/, ''))
    expect(noBom.records.map((r) => r.importKey)).toEqual(parsed.records.map((r) => r.importKey))
  })
})

describe('CSV 解析 → ledger：与 xlsx 口径对齐', () => {
  it('真实日期触发高位分配记亏，全表盈利 ¥3,061 / 卖出额 ¥196,522', () => {
    expect(ledger.totals.profitCents).toBe(306100)
    expect(ledger.totals.sellAmountCents).toBe(19652200)
  })

  it('待卖 27 条 / 13,200 股，待买 4 条，净持仓 13,200 不变', () => {
    expect(ledger.totals.targetCount).toBe(27)
    expect(ledger.totals.targetQty).toBe(13200)
    expect(ledger.totals.rebuyCount).toBe(4)
    expect(ledger.totals.netQty).toBe(13200)
  })

  it('缺日期 0 笔（xlsx 里是 9 笔），异常只剩 2 个负盈利', () => {
    expect(ledger.sells.filter((s) => s.dateMissing)).toHaveLength(0)
    expect(ledger.anomalies).toHaveLength(2)
    expect(ledger.anomalies.every((a) => a.kind === 'negativeProfit')).toBe(true)
  })

  it('先卖后买 6 行：原 5 行 + R57（买 10/21、卖 10/20）', () => {
    expect(ledger.sells.filter((s) => s.sellBeforeBuy).map((s) => s.sourceRow)).toEqual([40, 57, 60, 61, 62, 63])
  })

  it('与 xlsx 首表互检：真实卖出/批次数量一致，真实日期决定自动分配', async () => {
    const buf = readFileSync(resolve(process.cwd(), 'tests/fixtures/26年网格记录.xlsx'))
    const xlsx = await parseWorkbook(new Uint8Array(buf))
    const xlsxLedger = buildLedger(xlsx.records, DEFAULT_STOCKS, { deriveSellPrice: true })
    expect(xlsxLedger.totals.sellCount).toBe(ledger.totals.sellCount)
    expect(xlsxLedger.lots).toHaveLength(ledger.lots.length)
    expect(xlsxLedger.effectiveHedges).toHaveLength(1)
    expect(ledger.effectiveHedges).toHaveLength(6)
    // 日期口径：xlsx 有 9 笔落在「未填日期」桶，CSV 全部有真日期
    expect(ledger.monthly.some((m) => m.dateMissing)).toBe(false)
    expect(xlsxLedger.monthly.some((m) => m.dateMissing)).toBe(true)
  })
})
