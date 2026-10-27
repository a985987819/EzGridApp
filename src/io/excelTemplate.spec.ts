/**
 * V9.64 模板与导出闭环：
 *   模板（表头 + 填写说明）必须能被导入解析器原样吃下（0 行、缺列清单为空）；
 *   明细按【交易记录】表头导出后，再走一遍解析器，字段必须一一对应——
 *   用户导出 → 改 → 再导入的往返不丢数据。
 */
import { describe, expect, it } from 'vitest'
import { buildTemplateWorkbook, exportRecordsWorkbook, parseCsvText, parseWorkbook, TEMPLATE_HEADERS } from './parseWorkbook'
import { planImport } from '../domain/importPlan'
import type { RawRecord } from '../domain/types'

describe('Excel 模板与导出闭环', () => {
  it('旧明细CSV的已卖与成交价可识别；缺列不会清掉已有卖出字段', async () => {
    const p = await parseCsvText('股票,买入日期,买入价,买入份额,已卖,目标售价,成交价,卖出日期,回补价,实现盈利\nT,2026-10-20,5,500,500,9,7,2026-10-21,5,1000')
    expect(p.records[0]).toMatchObject({ soldQty: 500, targetPriceCents: 700, rawProfitCents: 100000 })
    expect(p.missingColumns).not.toContain('soldQty')
    const incomplete = await parseCsvText('股票,买入日期,买入价,买入份额\nT,2026-10-20,5,500')
    expect(planImport(p.records, incomplete.records, incomplete.absentFields).updates).toEqual([])
    const cleared = await parseCsvText('股票,买入日期,买入价,买入份额,已卖\nT,2026-10-20,5,500,')
    expect(planImport(p.records, cleared.records, cleared.absentFields).updates[0].to.soldQty).toBeNull()
  })
  it('查看用明细Excel/CSV拦截导入，防止关联丢失后重复建账', async () => {
    await expect(parseWorkbook(await exportRecordsWorkbook([['T', '2026-10-20', 5, 500, 7, 200, 400, '2026-10-21', 5]], true))).rejects.toThrow('查看用明细')
    await expect(parseCsvText('股票,已卖,导出用途（仅供查看，不可导入）\nT,200,查看用')).rejects.toThrow('完整台账')
  })
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
