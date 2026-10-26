/**
 * V9.64 模板与导出闭环：
 *   模板（表头 + 填写说明）必须能被导入解析器原样吃下（0 行、缺列清单为空）；
 *   明细按【交易记录】表头导出后，再走一遍解析器，字段必须一一对应——
 *   用户导出 → 改 → 再导入的往返不丢数据。
 */
import { describe, expect, it } from 'vitest'
import { buildTemplateWorkbook, exportRecordsWorkbook, parseWorkbook, TEMPLATE_HEADERS } from './parseWorkbook'
import type { RawRecord } from '../domain/types'

describe('Excel 模板与导出闭环', () => {
  it('模板：两个工作表，表头齐全（缺列清单为空），解析出 0 行数据', async () => {
    const buf = await buildTemplateWorkbook()
    const res = await parseWorkbook(buf)
    expect(res.sheetName).toBe('交易记录')
    expect(res.missingColumns).toEqual([])
    expect(res.records).toEqual([])
    expect(res.skippedRows).toHaveLength(0)
  })

  it('导出 → 再导入：买入行与先卖后买行字段一一对应', async () => {
    // 一行常规先买后卖 + 一行纯先卖后买（买入侧全空、P 列有价）
    const rows: (string | number | null)[][] = [
      ['柳工', '2026-03-01', 7.81, 700, 8.38, 700, 435, '2026-03-20', null],
      ['三一重工', null, null, null, null, 500, 250, '2026-04-02', 5.0],
    ]
    const buf = await exportRecordsWorkbook(rows)
    const res = await parseWorkbook(buf)
    expect(res.missingColumns).toEqual([])
    expect(res.records).toHaveLength(2)
    expect(res.skippedRows).toHaveLength(0)

    const [buy, sellFirst] = res.records as RawRecord[]
    expect(buy).toMatchObject({
      stockName: '柳工',
      buyPriceCents: 781,
      buyQtyRaw: 700,
      targetPriceCents: 838,
      soldQty: 700,
      rawProfitCents: 43500,
      earlyBuyPriceCents: null,
    })
    expect(buy.buyDateSerial).toBeGreaterThan(20000)
    expect(buy.sellDateSerial).toBeGreaterThan(20000)

    // 先卖后买行：无买入侧、有卖出侧与 P 列
    expect(sellFirst).toMatchObject({
      stockName: '三一重工',
      buyPriceCents: null,
      buyQtyRaw: null,
      soldQty: 500,
      rawProfitCents: 25000,
      earlyBuyPriceCents: 500,
    })
    expect(sellFirst.buyDateSerial).toBeNull()
    expect(sellFirst.sellDateSerial).toBeGreaterThan(20000)
  })

  it('表头常量与解析别名对得上（改列名先改这里，模板/导出/导入保持同源）', () => {
    // TEMPLATE_HEADERS 的每一项都必须命中解析器的第一别名
    expect(TEMPLATE_HEADERS).toEqual(['股票', '日期', '买入价', '买入份额', '目标售价', '实现份数', '实现盈利', '卖出日期', '提前卖的买价'])
  })
})
