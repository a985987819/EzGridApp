import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseCsvText } from '../io/parseWorkbook'
import { buildNanoIdIndex, nanoIdOf } from './nanoid'
import type { RawRecord } from '../domain/types'

describe('nanoIdOf（importKey → 稳定短 id）', () => {
  it('同一 importKey 结果稳定，不同 importKey 结果不同', () => {
    const a = nanoIdOf('柳工|46090|1031|700|||')
    expect(nanoIdOf('柳工|46090|1031|700|||')).toBe(a)
    expect(nanoIdOf('柳工|46090|1031|700||')).not.toBe(a)
  })

  it('base36 短串（10 位上下），可直接进 URL', () => {
    const id = nanoIdOf('三一重工|46246|1881|300|1988|300|46265')
    expect(id).toMatch(/^[0-9a-z]+$/)
    expect(id.length).toBeGreaterThanOrEqual(8)
    expect(id.length).toBeLessThanOrEqual(12)
  })
})

describe('buildNanoIdIndex（同库唯一索引）', () => {
  it('62 行基准数据：id 全唯一，行号 ↔ id 双向对上', async () => {
    const csv = readFileSync(resolve(process.cwd(), 'tests/fixtures/26年网格记录-工作表3.csv'), 'utf8')
    const { records } = await parseCsvText(csv)
    const nano = buildNanoIdIndex(records)
    expect(nano.byId.size).toBe(62)
    expect(nano.rowToId.size).toBe(62)
    expect(new Set(nano.rowToId.values()).size).toBe(62)
    for (const [row, id] of nano.rowToId) {
      expect(nano.byId.get(id)?.sourceRow).toBe(row)
    }
  })

  it('哈希相撞时按行号序追加 -2/-3，仍然唯一且稳定', () => {
    const rec = (sourceRow: number, importKey: string): RawRecord =>
      ({ sourceRow, importKey }) as unknown as RawRecord
    const base = nanoIdOf('dup') // 两行同 importKey → 同哈希 → 靠后缀区分
    const nano = buildNanoIdIndex([rec(2, 'dup'), rec(1, 'dup'), rec(3, 'other')])
    expect(nano.rowToId.get(1)).toBe(base) // 行号小的先占基础名
    expect(nano.rowToId.get(2)).toBe(`${base}-2`)
    expect(nano.rowToId.get(3)).toBe(nanoIdOf('other'))
    expect(new Set(nano.rowToId.values()).size).toBe(3)
    // 与传入顺序无关（按行号序稳定）
    const again = buildNanoIdIndex([rec(3, 'other'), rec(2, 'dup'), rec(1, 'dup')])
    expect(again.rowToId.get(1)).toBe(nano.rowToId.get(1))
    expect(again.rowToId.get(2)).toBe(nano.rowToId.get(2))
  })
})
