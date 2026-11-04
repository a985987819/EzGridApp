import { describe, expect, it } from 'vitest'
import { normalizeRecordIds } from './recordIds'

describe('记录深链 ID 列表', () => {
  it('缺省、空串和空片段均不产生 ID', () => {
    expect(normalizeRecordIds(undefined)).toEqual([])
    expect(normalizeRecordIds(null)).toEqual([])
    expect(normalizeRecordIds('')).toEqual([])
    expect(normalizeRecordIds(' ,  , ')).toEqual([])
  })

  it('去空白和重复，保持 ID 首次出现顺序', () => {
    const value = ' b-2, a, b-2, , c ,a'
    expect(normalizeRecordIds(value)).toEqual(['b-2', 'a', 'c'])
    expect(value).toBe(' b-2, a, b-2, , c ,a')
  })

  it('保留未知或格式未识别的 ID，匹配由索引负责', () => {
    expect(normalizeRecordIds('missing,never-seen, missing')).toEqual(['missing', 'never-seen'])
  })

  it('结果是独立数组', () => {
    const ids = normalizeRecordIds('a,b')
    ids.pop()
    expect(normalizeRecordIds('a,b')).toEqual(['a', 'b'])
  })
})
