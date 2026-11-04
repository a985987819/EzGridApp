import { describe, expect, it } from 'vitest'
import { documentHeadings, documents, extractScenarios, extractTopics, headingId, issues, resolveDocumentLink, scenarioRows, topics } from './content'

describe('管理页操作指南索引', () => {
  it('完整收录43个操作问题、108个场景和26个当前边界，身份不重复', () => {
    expect(topics).toHaveLength(43)
    expect(scenarioRows).toHaveLength(108)
    expect(issues).toHaveLength(26)
    for (const rows of [topics, scenarioRows, issues]) expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
    expect(topics.find(t => t.id === '20')?.body).toContain('链仍亏 500')
    expect(scenarioRows.find(t => t.id === '058')?.expected).toContain('分别存在')
    expect(issues.find(t => t.id === 'C01')?.body).toContain('待修复')
  })

  it('问题正文不会跨二级分类串到下一条，场景支持转义分隔符', () => {
    const entries = extractTopics('## 买入\n### 01 怎么买\n第一步\n## 卖出\n不属于前文\n### 02 怎么卖\n第二步')
    expect(entries[0]).toEqual({ id: '01', title: '怎么买', category: '买入', body: '第一步' })
    expect(entries[1].category).toBe('卖出')
    expect(extractScenarios('### A. 测试（001–002）\n| 001 | A\\|B | 应有结果 | 待验 |')[0])
      .toEqual({ id: '001', title: 'A|B', category: '测试', expected: '应有结果', evidence: '待验' })
  })

  it('文档链接留在应用内并保留问题锚点，源码链接不冒充页面', () => {
    expect(resolveDocumentLink('操作边界与核对.md#c01')).toBe('#/manage?section=guide&doc=boundaries&anchor=c01')
    expect(resolveDocumentLink('./完整台账Excel.md')).toBe('#/manage?section=guide&doc=workbook')
    expect(resolveDocumentLink('../src/domain/chain.ts')).toBeNull()
    expect(resolveDocumentLink('https://example.com')).toBe('https://example.com')
    expect(headingId('C01 自动归属库存')).toBe('c01')
    expect(documents.find(d => d.id === 'scenarios')?.body).toContain('五个完整算例')
  })

  it('持续优化路线图可分享、目录身份唯一且明确区分规划与实现', () => {
    const roadmap = documents.find(d => d.id === 'optimization-roadmap')!
    expect(roadmap.kind).toBe('plan')
    expect(resolveDocumentLink('./云端同步与持续优化路线图.md')).toBe('#/manage?section=guide&doc=optimization-roadmap')
    const headings = documentHeadings(roadmap.body)
    expect(new Set(headings.map(h => h.id)).size).toBe(headings.length)
    expect(headings.some(h => h.title.includes('下一轮入口'))).toBe(true)
    expect(roadmap.body).toContain('云同步、设备绑定尚未实现')
    expect(roadmap.body).toContain('手动上传、手动下载，核对后恢复')
  })
})
