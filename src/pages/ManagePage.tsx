import { useState } from 'react'
import { Card } from 'animal-island-ui'
import { ManageImport } from './manage/ManageImport'
import { ManageStocks } from './manage/ManageStocks'
import { ManageBackup } from './manage/ManageBackup'
import { ManageChecks } from './manage/ManageChecks'
import { IconChart, IconChevron, IconDownload, IconGrid, IconUpload } from '../ui/icons'
import type { TradesQuery } from '../ui/nav'
import { transitionView } from '../ui/transitions'

type Section = 'stocks' | 'import' | 'checks' | 'backup'

const SECTIONS: { key: Section; label: string; desc: string; Icon: typeof IconGrid }[] = [
  { key: 'stocks', label: '股票设置', desc: '网格间隔 · 涨跌幅规则 · 启用开关', Icon: IconGrid },
  { key: 'import', label: '导入数据', desc: 'Excel / CSV 批量写入本地台账', Icon: IconUpload },
  { key: 'checks', label: '校验', desc: '基准快照 · 数量守恒', Icon: IconChart },
  { key: 'backup', label: '备份', desc: '完整 Excel / JSON 备份与恢复', Icon: IconDownload },
]

export function ManagePage({ goTrades }: { goTrades: (q: TradesQuery) => void }) {
  const [section, setSection] = useState<Section | null>(null)
  const current = SECTIONS.find((s) => s.key === section)

  if (!current) {
    return (
      <div className="stack">
        <div className="page-title">
          <h2>管理</h2>
          <p>股票 · 导入 · 校验 · 备份</p>
        </div>
        <Card>
          <div className="manage-menu" data-testid="manage-menu">
            {SECTIONS.map(({ key, label, desc, Icon }) => (
              <button
                key={key}
                type="button"
                className="manage-item"
                data-manage-entry={key}
                onClick={() => transitionView(() => setSection(key))}
              >
                <span className="manage-ico"><Icon /></span>
                <span className="manage-main">
                  <span className="manage-label">{label}</span>
                  <span className="manage-desc">{desc}</span>
                </span>
                <IconChevron width={16} height={16} className="manage-arrow" />
              </button>
            ))}
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="manage-bar">
        <button
          type="button"
          className="manage-back"
          data-testid="manage-back"
          onClick={() => transitionView(() => setSection(null), 'back')}
        >
          <IconChevron width={14} height={14} style={{ transform: 'rotate(180deg)' }} />
          管理
        </button>
        <strong>{current.label}</strong>
      </div>
      {current.key === 'stocks' ? (
        <ManageStocks />
      ) : current.key === 'import' ? (
        <ManageImport goTrades={goTrades} />
      ) : current.key === 'checks' ? (
        <ManageChecks />
      ) : (
        <ManageBackup />
      )}
    </div>
  )
}
