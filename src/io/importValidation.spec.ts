import { describe, expect, it } from 'vitest'
import { loadXlsx, parseCsvText, parseWorkbook } from './parseWorkbook'
import { serialToIso } from '../domain/defaults'

describe('普通导入股数准入', () => {
  it('小数股数在预览中定位到具体行和字段，不能作为正常股数导入', async () => {
    const parsed = await parseCsvText('股票,买入价,买入份额,目标售价,实现份数\nT,10,100,12,0\nT,10,100.5,12,0')
    expect(parsed).toMatchObject({
      validationIssues: [{ sourceRow: 3, field: 'buyQtyRaw', value: '100.5' }],
    })
  })

  it.each(['-1', '100.5', '9007199254740992', '100.0000000000000001', '9007199254740991.1', '1e-324', '1e309', 'Infinity', 'NaN', '0x10', '#VALUE!'])('数量文本 %s 不得被舍入或当作缺失放行', async value => {
    const parsed = await parseCsvText(`股票,买入价,买入份额\nT,0.01,${JSON.stringify(value)}`)
    expect(parsed.validationIssues).toHaveLength(1)
    expect(parsed.validationIssues?.[0]).toMatchObject({ sourceRow: 2, field: 'buyQtyRaw' })
  })

  it.each([['', null], ['   ', null], ['0', 0], ['-0', 0], ['125', 125], ['100.0', 100], ['1e3', 1000], ['1.25e2', 125], ['1,000', 1000], ['9007199254740991', Number.MAX_SAFE_INTEGER]] as const)('数量文本 %s 保持精确整数或空值语义', async (value, expected) => {
    const parsed = await parseCsvText(`股票,买入价,买入份额\nT,0.01,${JSON.stringify(value)}`)
    expect(parsed.validationIssues).toEqual([])
    expect(parsed.records[0].buyQtyRaw).toBe(expected)
  })

  it('Excel 数量错误单元格不能把错误码15当成15股', async () => {
    const X = await loadXlsx()
    const wb = X.utils.book_new()
    const sheet = X.utils.aoa_to_sheet([['股票', '买入价', '买入份额'], ['T', 10, 100]])
    sheet.C2 = { t: 'e', v: 15 }
    X.utils.book_append_sheet(wb, sheet, '交易记录')
    const parsed = await parseWorkbook(X.write(wb, { type: 'array', bookType: 'xlsx' }))
    expect(parsed.validationIssues?.[0]).toMatchObject({ sourceRow: 2, field: 'buyQtyRaw' })
    expect(parsed.records[0].buyQtyRaw).toBeNull()
  })

  it('超长价格明确报告，不变成 Infinity 或被静默当作空价格', async () => {
    const parsed = await parseCsvText(`股票,买入价,买入份额\nT,${'9'.repeat(400)},100`)
    expect(parsed.validationIssues?.[0]).toMatchObject({ sourceRow: 2, field: 'buyPriceCents' })
    expect(parsed.records[0].buyPriceCents).toBeNull()
  })

  it('不存在的日期必须报告，不能被 Date 自动推进到下个月', async () => {
    const parsed = await parseCsvText('股票,日期,买入价,买入份额\nT,2026-02-30,10,100')
    expect(parsed).toMatchObject({ validationIssues: [{ sourceRow: 2, field: 'buyDateSerial', value: '2026-02-30' }] })
  })

  it('1904 日期系统转换为同一个真实日期，不移动文本日期', async () => {
    const X = await loadXlsx()
    const wb = X.utils.book_new()
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([
      ['股票', '日期', '买入价', '买入份额'], ['T', 44500, 10, 100], ['T', '2025-11-01', 11, 100],
    ]), '交易记录')
    wb.Workbook = { WBProps: { date1904: true } }
    const parsed = await parseWorkbook(X.write(wb, { type: 'array', bookType: 'xlsx' }))
    expect(parsed.records.map(r => serialToIso(r.buyDateSerial))).toEqual(['2025-11-01', '2025-11-01'])
  })
})
