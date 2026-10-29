import { describe, it, expect } from 'vitest'
import { parseRelease, releaseLabel } from './release'

const version = { schema: 1, app: 'ezgrid', buildId: '0123456789abcdef', version: '0.9.0', commit: 'abc', builtAt: '2026-10-29T09:00:00Z', base: '/EzGridApp/' }
describe('固定版本比较协议', () => {
  it('当前与线上按完整构建号比较，同一内容重复构建不会因时间不同误报更新', () => {
    const current = parseRelease(version, '/EzGridApp/')
    const again = parseRelease({ ...version, builtAt: '2026-10-30T09:00:00Z' }, '/EzGridApp/')
    expect(current.buildId).toBe(again.buildId)
    expect(releaseLabel(current)).toBe('0.9.0 · 01234567')
    expect(parseRelease({ ...version, buildId: '0123456789abcdee' }, '/EzGridApp/').buildId).not.toBe(current.buildId)
  })
  it('拒绝HTML、错误站点、路径、格式或缺字段，不将失败检查当作最新', () => {
    for (const value of ['<html>404</html>', null, {}, { ...version, app: 'other' }, { ...version, base: '/' }, { ...version, builtAt: 'bad' }, { ...version, buildId: '' }, { ...version, schema: 99 }]) expect(() => parseRelease(value, '/EzGridApp/')).toThrow()
  })
})
