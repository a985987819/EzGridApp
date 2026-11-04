import guide from '../../docs/操作指南.md?raw'
import boundaries from '../../docs/操作边界与核对.md?raw'
import manual from '../../docs/使用手册.md?raw'
import kinds from '../../docs/detail-kinds.md?raw'
import scenarios from '../../docs/网格交易场景与核对.md?raw'
import workbook from '../../docs/完整台账Excel.md?raw'
import sellFirst from '../../docs/先卖后买与回本链需求.md?raw'
import audit from '../../docs/项目逻辑审计与优化建议.md?raw'
import evidence from '../../docs/审计证据与复现.md?raw'
import motion from '../../docs/界面动效与滚动.md?raw'
import history from '../../docs/审计修复记录-2026-10-27.md?raw'
import booking from '../../docs/成交记录与核对.md?raw'
import bookingPlan from '../../docs/记账流程与防重改进建议.md?raw'
import updates from '../../docs/版本检查与更新.md?raw'
import valuation from '../../docs/估值温度带.md?raw'
import moneyPlan from '../../docs/规划用钱.md?raw'
import perfPlan from '../../docs/优化建议-动效性能加载更新-2026-11.md?raw'
import splitPlan from '../../docs/拆档与先卖后买双模式规划.md?raw'
import roadmap from '../../docs/云端同步与持续优化路线图.md?raw'
import m00 from '../../docs/M00现状与性能基线-2026-11-04.md?raw'
import { buildManageHash, type ManageQuery } from '../ui/nav'

export interface GuideDocument {
  id: string
  title: string
  file: string
  summary: string
  kind: 'guide' | 'rules' | 'audit' | 'history' | 'plan'
  body: string
}
export const documents: readonly GuideDocument[] = [
  { id: 'guide', title: '操作指南', file: '操作指南.md', summary: '按情况查处理步骤、算例和注意事项', kind: 'guide', body: guide },
  { id: 'boundaries', title: '操作边界与核对', file: '操作边界与核对.md', summary: '本次复核、当前处理办法与修复状态', kind: 'guide', body: boundaries },
  { id: 'manual', title: '使用手册', file: '使用手册.md', summary: '交易的一生、日常操作和数字口径', kind: 'guide', body: manual },
  { id: 'booking', title: '成交记录与核对', file: '成交记录与核对.md', summary: '一次记账、防重提示、来源分配和凭据核对', kind: 'guide', body: booking },
  { id: 'updates', title: '版本检查与更新', file: '版本检查与更新.md', summary: '固定版本比较、手动刷新与强制更新结果', kind: 'guide', body: updates },
  { id: 'valuation', title: '估值温度带', file: '估值温度带.md', summary: '股价/PE/PB 近 5 年百分位、数据刷新与判读', kind: 'guide', body: valuation },
  { id: 'money-plan', title: '规划用钱', file: '规划用钱.md', summary: '可用资金、整手可买、值博率口径与排序', kind: 'guide', body: moneyPlan },
  { id: 'optimization-roadmap', title: '云端同步与持续优化路线图', file: '云端同步与持续优化路线图.md', summary: '临时PIN绑定、手动同步、性能与易用性任务、逐轮AI执行与验收', kind: 'plan', body: roadmap },
  { id: 'm00-baseline', title: 'M00现状与性能基线', file: 'M00现状与性能基线-2026-11-04.md', summary: '2026-11-04实测、业务反例、恢复阻断与下一轮交接', kind: 'audit', body: m00 },
  { id: 'perf-plan', title: '性能优化建议与执行记录', file: '优化建议-动效性能加载更新-2026-11.md', summary: '字体子集、页面拆包、价格树与更新机制的优化方案与实测', kind: 'plan', body: perfPlan },
  { id: 'split-plan', title: '拆档与先卖后买双模式', file: '拆档与先卖后买双模式规划.md', summary: '原单不改、连续排档、低位回本与底仓做T的操作与边界', kind: 'rules', body: splitPlan },
  { id: 'booking-plan', title: '记账流程改进方案', file: '记账流程与防重改进建议.md', summary: '初版规划与后续方向，当前功能以成交记录与核对为准', kind: 'history', body: bookingPlan },
  { id: 'kinds', title: '明细类型图鉴', file: 'detail-kinds.md', summary: '持仓、先卖后买、回补和链的类型速查', kind: 'rules', body: kinds },
  { id: 'scenarios', title: '网格交易场景与核对', file: '网格交易场景与核对.md', summary: '108 个场景、五个算例和核对公式', kind: 'rules', body: scenarios },
  { id: 'workbook', title: '完整台账 Excel', file: '完整台账Excel.md', summary: '全量导出、字段单位、编辑与恢复预览', kind: 'rules', body: workbook },
  { id: 'sell-first', title: '先卖后买与回本链', file: '先卖后买与回本链需求.md', summary: '覆盖、高位关联、回本及真实 CSV 基准', kind: 'rules', body: sellFirst },
  { id: 'audit', title: '项目逻辑审计', file: '项目逻辑审计与优化建议.md', summary: '2026-10-28 审计快照，当前状态见操作边界', kind: 'audit', body: audit },
  { id: 'evidence', title: '审计证据与复现', file: '审计证据与复现.md', summary: '审计环境、验证方法与结论范围', kind: 'audit', body: evidence },
  { id: 'motion', title: '界面动效与滚动', file: '界面动效与滚动.md', summary: '页面过渡、保滚动和减少动态效果', kind: 'history', body: motion },
  { id: 'history', title: '历史修复记录', file: '审计修复记录-2026-10-27.md', summary: '2026-10-27 的版本追溯，不作现行操作依据', kind: 'history', body: history },
]

export function plainText(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*#>]/g, '').replace(/\s+/g, ' ').trim()
}

export function headingId(text: string): string {
  const issue = text.match(/^([A-Z]\d{2})\b/)
  return issue ? issue[1].toLowerCase() : plainText(text).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-')
}

export interface GuideTopic {
  id: string
  title: string
  category: string
  body: string
}

/** 指南以 Markdown 为唯一正文来源，移动端索引只读取二/三级标题。 */
export function extractTopics(markdown: string): GuideTopic[] {
  let category = ''
  let current: GuideTopic | undefined
  const topics: GuideTopic[] = []
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) { category = line.slice(3).trim(); current = undefined }
    else if (line.startsWith('### ')) {
      const heading = line.slice(4).trim()
      const id = heading.match(/^(\d{2}|[A-Z]\d{2})\b/)?.[1] ?? String(topics.length + 1).padStart(2, '0')
      current = { id, title: heading.replace(/^(?:\d{2}|[A-Z]\d{2})\s+/, ''), category, body: '' }
      topics.push(current)
    } else if (current) current.body += line + '\n'
  }
  return topics.map(topic => ({ ...topic, body: topic.body.trim() }))
}

export const topics = extractTopics(guide)
export const issues = extractTopics(boundaries)
export const categories = [...new Set(topics.map(t => t.category))]

export interface GuideScenario {
  id: string
  title: string
  category: string
  expected: string
  evidence: string
}

export function extractScenarios(markdown: string): GuideScenario[] {
  const rows: GuideScenario[] = []
  let category = ''
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('### ')) category = line.slice(4).replace(/^[A-L]\.\s*/, '').replace(/（\d+–\d+）$/, '').trim()
    if (!/^\|\s*\d{3}\s*\|/.test(line)) continue
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim().replace(/\\\|/g, '|'))
    if (cells.length === 4) rows.push({ id: cells[0], title: cells[1], category, expected: cells[2], evidence: cells[3] })
  }
  return rows
}
export const scenarioRows = extractScenarios(scenarios)

export function guideLink(query: Omit<ManageQuery, 'section'> = {}): string {
  return buildManageHash({ section: 'guide', ...query })
}

/** 文档相对链接在应用内打开，外部链接保持外部；源码路径不伪装成站内页面。 */
export function resolveDocumentLink(href: string, documentId?: string): string | null {
  if (/^https?:\/\//.test(href)) return href
  const [path, anchor] = href.split('#')
  const file = decodeURIComponent(path).split('/').pop()
  const doc = file ? documents.find(d => d.file === file) : documents.find(d => d.id === documentId)
  if (!doc) return null
  return guideLink({ doc: doc.id, ...(anchor ? { anchor: headingId(decodeURIComponent(anchor)) } : {}) })
}

export function documentHeadings(body: string): { title: string; id: string }[] {
  let fenced = false
  return body.split(/\r?\n/).flatMap(line => {
    if (line.startsWith('```')) { fenced = !fenced; return [] }
    if (fenced || !/^#{2,3} /.test(line)) return []
    const title = plainText(line.replace(/^#+\s*/, ''))
    return [{ title, id: headingId(title) }]
  })
}
