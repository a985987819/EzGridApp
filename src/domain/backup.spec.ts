import { describe, expect, it } from 'vitest'
import { validateBackup } from './backup'

const goodRecord = { sourceRow: 1, importKey: 'k1', stockName: '柳工' }
const goodStock = { id: 'stock:柳工', name: '柳工', intervalCents: 57 }

describe('恢复前的备份内容校验', () => {
  it('合法备份通过', () => {
    expect(validateBackup({ schemaVersion: 5, records: [goodRecord], stocks: [goodStock] })).toBeNull()
  })

  it('只带部分表的备份（空对象）也通过', () => {
    expect(validateBackup({})).toBeNull()
  })

  it('records 非数组拒绝', () => {
    expect(validateBackup({ records: 'nope' })).toBe('records 不是数组')
  })

  it('records 缺 importKey / sourceRow / stockName 拒绝', () => {
    expect(validateBackup({ records: [{ sourceRow: 1, stockName: '柳工' }] })).toContain('importKey')
    expect(validateBackup({ records: [{ importKey: 'k', stockName: '柳工' }] })).toContain('sourceRow')
    expect(validateBackup({ records: [{ sourceRow: 1, importKey: 'k' }] })).toContain('stockName')
  })

  it('stocks 缺 intervalCents 拒绝', () => {
    expect(validateBackup({ stocks: [{ id: 's', name: '柳工' }] })).toContain('intervalCents')
  })

  it('accounts 缺 id 拒绝', () => {
    expect(validateBackup({ accounts: [{ name: '2027 年' }] })).toContain('id')
  })
})
