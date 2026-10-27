import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STOCKS } from '../domain/defaults'
import { snapshotViews, type LedgerSnapshot } from '../domain/ledgerSnapshot'
import { buildNanoIdIndex } from '../ui/nanoid'
import { exportLedgerWorkbook, parseLedgerWorkbook } from './ledgerWorkbook'
import { buildTemplateWorkbook, loadXlsx, parseCsvText, parseWorkbook } from './parseWorkbook'

const csv = await parseCsvText(readFileSync('tests/fixtures/26年网格记录-交易记录.csv', 'utf8'))
const base = (): LedgerSnapshot => ({
  schemaVersion: 11, exportedAt: '2026-10-27T12:00:00.000Z', settings: { deriveSellPrice: false },
  records: structuredClone(csv.records).map((r) => ({ ...r, batchId: 'batch:1000' })),
  stocks: structuredClone(DEFAULT_STOCKS), batches: [{ id: 'batch:1000', fileName: '原台账.csv', sheetName: 'Sheet1', importedAt: 1000, recordCount: 62, addedCount: 62 }],
  auditLogs: [], rebuyExecutions: [], hedges: [], chainLinks: [], merges: [], plans: [], extraTargets: [], buyTargets: [],
})
const parse = async (s: LedgerSnapshot) => (await parseLedgerWorkbook(await exportLedgerWorkbook(s)))!
async function edit(editWorkbook: (wb: import('xlsx').WorkBook, X: Awaited<ReturnType<typeof loadXlsx>>) => void, s = base()) {
  const X = await loadXlsx()
  const wb = X.read(await exportLedgerWorkbook(s), { type: 'array' })
  editWorkbook(wb, X)
  return new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' }))
}

describe('完整台账 Excel 往返', () => {
  it('真实 62 行重建六条先卖后买链，自动关联不变成人工关联', async () => {
    const s = base()
    const p = await parse(s)
    expect(p.snapshot).toEqual(s)
    expect(p.differences).toEqual([])
    expect(p.snapshot.hedges).toEqual([])
    expect(p.views['核对_高位关联'].filter((r) => r.来源 === '自动')).toHaveLength(6)
    expect(p.views['核对_回本链'].filter((r) => [40, 57, 60, 61, 62, 63].includes(Number(r.anchorRow))).reduce((a, c) => a + Number(c.lossCents), 0)).toBe(-517600)
    expect(p.views['核对_待买'].filter((o) => o.sellFirst && Number(o.remainingQty) > 0).map((o) => [o.sourceRow, o.remainingQty, o.rebuyPriceCents])).toEqual([[60, 500, 801]])
    expect(buildNanoIdIndex(p.snapshot.records).rowToId).toEqual(buildNanoIdIndex(s.records).rowToId)
  })

  it('保留空人工覆盖、拆高位分配、结束链、成员、拆档、计划、奖励、虚拟批次卖出与历史', async () => {
    const s = base()
    s.settings.deriveSellPrice = true
    s.hedges = [
      { id: 'hedge:60', sellRow: 60, items: [{ row: 7, qty: 200 }, { row: 8, qty: 300 }], at: 100 },
      { id: 'hedge:63', sellRow: 63, items: [], at: 101 },
    ]
    s.chainLinks = [{ id: 'chainlink:60', anchorRow: 60, stockName: '柳工', memberRows: [8, 9], closedAt: 1793000000000, at: 200 }]
    s.merges = [{ id: 'merge:7', stockName: '柳工', priceCents: 1071, rows: [7, 8], at: 300 }]
    s.plans = [{ id: 'plan:buy:stock:柳工:801', kind: 'buy', refId: 'buy:stock:柳工:801', qty: 100, priceCents: 800, at: 400 }]
    s.extraTargets = [{ id: 'extra:7', lotId: 'lot:7', qty: 100, priceCents: 1200, at: 500 }]
    s.buyTargets = [{ id: 'buytarget:60:600', sellRow: 60, qty: 200, priceCents: 801, at: 600 }]
    s.rebuyExecutions = [{ id: 'exec:测试', orderId: 'rb:sell:60', sellExecId: 'sell:60', stockId: 'stock:柳工', stockName: '柳工', qty: 200, rewardQty: 100, priceCents: 801, groupKeyAtExecution: 'stock:柳工|801', at: 1793000000000, note: '部分回补' }]
    s.rebuyExecutions[0].buyTargetId = 'buytarget:60:600'
    s.records.push({ ...s.records[0], sourceRow: 100000, importKey: 'manual:test:999999', origin: 'manual', deletedAt: null, batchId: null, soldLotId: 'lot:exec:exec:测试', buyPriceCents: null, buyQtyRaw: null, buyDateSerial: null, qtyNeedsDerive: false, targetPriceCents: 850, soldQty: 50, stockName: '柳工' })
    s.records[1].deletedAt = 900
    s.records[s.records.length - 1].soldTargetId = 'target:deleted-history'
    s.stocks[0].note = '〈null〉'
    s.stocks[1].note = ''
    s.auditLogs = [{ id: 800, entity: 'chain', entityId: 'chainlink:60', field: 'members', oldValue: '', newValue: '8,9', at: 700, source: '人工编辑' }]
    const p = await parse(s)
    expect(p.snapshot).toEqual(s)
    expect(p.differences).toEqual([])
    expect(p.views).toEqual(snapshotViews(s))
    expect(p.views['核对_批次'].some((r) => r.id === 'lot:exec:exec:测试')).toBe(true)
  })

  it('重排所有数据行、列、工作表后仍保持身份、原始顺序与各项结果', async () => {
    const s = base()
    const data = await edit((wb, X) => {
      wb.SheetNames.reverse()
      for (const name of wb.SheetNames.filter((n) => n !== '台账说明')) {
        const [header, ...rows] = X.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: null })
        wb.Sheets[name] = X.utils.aoa_to_sheet([header, ...rows.reverse()].map((r) => r.reverse()))
      }
    }, s)
    const p = (await parseLedgerWorkbook(data))!
    expect(p.snapshot).toEqual(s)
    expect(p.differences).toEqual([])
  })

  it('编辑交易或手动关联后重新计算，展示差异且保留可恢复数据', async () => {
    const data = await edit((wb, X) => {
      const ws = wb.Sheets['交易数据']
      const rows = X.utils.sheet_to_json<unknown[]>(ws, { header: 1 })
      const col = rows[0].indexOf('回补价（分）')
      const row = rows.findIndex((r) => r[1] === 60)
      ws[X.utils.encode_cell({ r: row, c: col })] = { t: 'n', v: 800 }
    })
    const p = (await parseLedgerWorkbook(data))!
    expect(p.snapshot.records.find((r) => r.sourceRow === 60)?.earlyBuyPriceCents).toBe(800)
    expect(p.differences.map((d) => d.sheet)).toContain('核对_待买')
  })

  it('无交易的完整台账也能恢复；旧模板和 CSV 路径不变', async () => {
    const s = base(); s.records = []; s.batches = []
    expect((await parse(s)).differences).toEqual([])
    expect(await parseLedgerWorkbook(await buildTemplateWorkbook())).toBeNull()
    expect((await parseWorkbook(await buildTemplateWorkbook())).sheetName).toBe('交易记录')
    await expect(parseWorkbook(await exportLedgerWorkbook(base()))).rejects.toThrow('完整台账')
  })

  it('原始 XLSX 的未缓存公式标记在完整格式中按原始状态保留', async () => {
    const s = base()
    s.records = (await parseWorkbook(readFileSync('tests/fixtures/26年网格记录.xlsx'))).records
    expect(s.records.some((r) => r.targetNeedsDerive || r.qtyNeedsDerive)).toBe(true)
    const p = await parse(s)
    expect(p.snapshot).toEqual(s)
    expect(p.differences).toEqual([])
  })
  it('兼容计算口径1缺少来源档列的旧完整文件', async () => {
    const data = await edit((wb, X) => {
      wb.Sheets['台账说明'].B4 = { t: 'n', v: 1 }
      for (const [name, label] of [['交易数据', '卖出来源档ID'], ['回补成交', '买入来源档ID']]) {
        const rows = X.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: null })
        const col = rows[0].indexOf(label)
        wb.Sheets[name] = X.utils.aoa_to_sheet(rows.map((r) => r.filter((_, i) => i !== col)))
      }
    })
    expect((await parseLedgerWorkbook(data))!.snapshot).toEqual(base())
  })
})

describe('坏工作簿在写库前整包拒绝', () => {
  it.each([
    ['重复记录ID', (wb: import('xlsx').WorkBook) => { wb.Sheets['交易数据'].B3 = { t: 'n', v: 2 } }, /交易数据.*ID.*重复/],
    ['非整数股数', (wb: import('xlsx').WorkBook) => { wb.Sheets['交易数据'].I2 = { t: 'n', v: 1.5 } }, /交易数据.*买入股数/],
    ['公式', (wb: import('xlsx').WorkBook) => { wb.Sheets['交易数据'].H2 = { t: 'n', v: 1, f: '1+0' } }, /交易数据.*H2.*公式/],
    ['缺表', (wb: import('xlsx').WorkBook) => { delete wb.Sheets['人工高位关联'] }, /人工高位关联.*缺失/],
    ['丢失说明', (wb: import('xlsx').WorkBook) => { delete wb.Sheets['台账说明'] }, /台账说明.*缺失/],
    ['未来版本', (wb: import('xlsx').WorkBook) => { wb.Sheets['台账说明'].B3 = { t: 'n', v: 999 } }, /不支持/],
  ] as const)('%s', async (_name, change, error) => {
    await expect(parseLedgerWorkbook(await edit(change))).rejects.toThrow(error)
  })

  it('悬空挂钩指出具体表与关联ID', async () => {
    const s = base()
    s.hedges = [{ id: 'hedge:60', sellRow: 60, items: [{ row: 999, qty: 500 }], at: 1 }]
    await expect(parse(s)).rejects.toThrow(/人工高位关联.*hedge:60.*999/)
  })

  it('虚拟批次引用也检查存在，父关联删掉不能留下子项', async () => {
    const s = base()
    s.extraTargets = [{ id: 'x', lotId: 'lot:exec:missing', priceCents: 500, qty: 100, at: 1 }]
    await expect(parse(s)).rejects.toThrow(/买单拆卖.*missing/)
    s.extraTargets = []
    s.hedges = [{ id: 'hedge:60', sellRow: 60, items: [{ row: 7, qty: 500 }], at: 1 }]
    const data = await edit((wb) => { wb.Sheets['人工高位关联']['!ref'] = 'A1:D1' }, s)
    await expect(parseLedgerWorkbook(data)).rejects.toThrow(/人工高位分配.*不存在/)
  })

  it('循环批次、悬空录入批次和多链重复成员均拒绝', async () => {
    let s = base()
    s.records[0].soldLotId = 'lot:3'
    s.records[1].soldLotId = 'lot:2'
    await expect(parse(s)).rejects.toThrow(/交易数据.*循环/)
    s = base(); s.batches = []
    await expect(parse(s)).rejects.toThrow(/交易数据.*导入批次/)
    s = base()
    s.chainLinks = [60, 61].map((anchorRow) => ({ id: `chainlink:${anchorRow}`, anchorRow, stockName: '柳工', memberRows: [8], closedAt: null, at: 1 }))
    await expect(parse(s)).rejects.toThrow(/人工回本链.*重复归属/)
  })
})
