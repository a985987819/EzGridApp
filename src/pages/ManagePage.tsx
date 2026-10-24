import { useState } from 'react'
import { Tabs } from 'animal-island-ui'
import { ManageImport } from './manage/ManageImport'
import { ManageStocks } from './manage/ManageStocks'
import { ManageBackup } from './manage/ManageBackup'
import { ManageAccounts } from './manage/ManageAccounts'
import { ManageChecks } from './manage/ManageChecks'
import type { TradesQuery } from '../ui/nav'

export function ManagePage({ goTrades }: { goTrades: (q: TradesQuery) => void }) {
  const [tab, setTab] = useState('stocks')
  return (
    <div className="stack">
      <div className="page-title">
        <h2>管理</h2>
        <p>股票 · 导入 · 账户 · 校验 · 备份</p>
      </div>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        aria-label="管理功能"
        items={[
          { key: 'stocks', label: '股票', children: <ManageStocks /> },
          { key: 'import', label: '导入', children: <ManageImport goTrades={goTrades} /> },
          { key: 'accounts', label: '账户', children: <ManageAccounts /> },
          { key: 'checks', label: '校验', children: <ManageChecks /> },
          { key: 'backup', label: '备份', children: <ManageBackup /> },
        ]}
      />
    </div>
  )
}
