import { describe, expect, it } from 'vitest'
import { MAX_RECORD_SELECTION, parseRecordSelection } from './recordSelection'

describe('明细按展示序号选择', () => {
  it('空输入表示未指定序号，每次返回独立集合', () => {
    const first = parseRecordSelection(' \n\t')
    expect(first).toEqual({ numbers: new Set(), error: null })
    first.numbers.add(7)
    expect(parseRecordSelection('').numbers.size).toBe(0)
  })

  it('列表、闭区间和中文序号可混用，并去重保留首次顺序', () => {
    const input = '第2笔、5,8-10 9；第12笔至第13笔'
    const parsed = parseRecordSelection(input)
    expect(parsed.error).toBeNull()
    expect([...parsed.numbers]).toEqual([2, 5, 8, 9, 10, 12, 13])
    expect(input).toBe('第2笔、5,8-10 9；第12笔至第13笔')
  })

  it('支持全角数字、逗号、范围和范围两侧空白', () => {
    const parsed = parseRecordSelection('第 ２ 笔，５ ， ８ － １０\n１２ ～ １３')
    expect(parsed.error).toBeNull()
    expect([...parsed.numbers]).toEqual([2, 5, 8, 9, 10, 12, 13])
  })

  it.each(['0', '-1', '2.5', '1e3', 'NaN', 'Infinity', '1/2', '第第2笔', '2笔笔', 'abc', '2-3-4', '2，错误'])('非法输入 %s 不返回局部匹配', input => {
    const parsed = parseRecordSelection(input)
    expect(parsed.error).toBeTruthy()
    expect(parsed.numbers.size).toBe(0)
  })

  it('倒序范围明确报错，相同起止只选一笔', () => {
    expect(parseRecordSelection('10-8').error).toContain('从小到大')
    expect([...parseRecordSelection('8-8').numbers]).toEqual([8])
  })

  it('只输入分隔符不能被当成空条件', () => {
    expect(parseRecordSelection('，、；').error).toBeTruthy()
  })

  it('允许大的安全整数序号，但不接受超出安全整数范围', () => {
    expect([...parseRecordSelection(String(Number.MAX_SAFE_INTEGER)).numbers]).toEqual([Number.MAX_SAFE_INTEGER])
    expect(parseRecordSelection('9007199254740992').error).toBeTruthy()
  })

  it('范围先检查上限，不展开百万个序号', () => {
    const parsed = parseRecordSelection('1-1000000')
    expect(parsed.error).toContain(String(MAX_RECORD_SELECTION))
    expect(parsed.numbers.size).toBe(0)
  })

  it('去重后的总数最多5000笔，跨多个范围也受约束', () => {
    expect(parseRecordSelection('1-5000,3-4999').numbers.size).toBe(MAX_RECORD_SELECTION)
    expect(parseRecordSelection('1-2500,2501-5001').error).toContain(String(MAX_RECORD_SELECTION))
    expect(parseRecordSelection('1-2500,2501-5001').numbers.size).toBe(0)
  })

  it('限制恶意长文本，避免大量重复项造成无界处理', () => {
    expect(parseRecordSelection('1,'.repeat(50001)).error).toContain('过长')
  })
})
