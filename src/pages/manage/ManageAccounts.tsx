import { useMemo, useState } from 'react'
import { Button, Card, Input, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../../store/useApp'
import { DEFAULT_ACCOUNT_ID } from '../../domain/types'

export function ManageAccounts() {
  const { accounts, records, activeAccountId, setActiveAccount, addAccount } = useApp()
  const [name, setName] = useState('')

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of records) {
      if (r.deletedAt) continue
      const id = r.accountId ?? DEFAULT_ACCOUNT_ID
      map.set(id, (map.get(id) ?? 0) + 1)
    }
    return map
  }, [records])

  return (
    <div className="stack">
      <Card>
        <p className="hint-block" style={{ margin: 0 }}>
          账户用来把不同年份 / 不同券商的账本分开。切换账户在顶部下拉框，切换后
          <b>概览、明细、挂单、统计全部只看该账户</b>；导入时自动归到当前账户。
        </p>
      </Card>

      {accounts.map((a) => {
        const isActive = activeAccountId === a.id
        return (
          <Card key={a.id} data-account={a.name}>
            <div className="row">
              <strong style={{ fontSize: 15 }}>{a.name}</strong>
              {a.id === DEFAULT_ACCOUNT_ID && <Tag size="small" variant="soft">默认</Tag>}
              {isActive && <Tag size="small" variant="soft" color="app-green">当前</Tag>}
              <div className="spacer" />
              <span className="tiny muted num">{counts.get(a.id) ?? 0} 行</span>
              <Button
                size="small"
                type={isActive ? 'default' : 'primary'}
                onClick={() => void setActiveAccount(a.id)}
              >
                {isActive ? '已选中' : '切到这个账户'}
              </Button>
            </div>
          </Card>
        )
      })}

      <Card>
        <strong style={{ fontSize: 14 }}>新增账户</strong>
        <div className="row nowrap" style={{ marginTop: 8 }}>
          <Input
            className="grow"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 2027 年 / 华泰"
            aria-label="账户名"
          />
          <Button
            type="primary"
            onClick={() => {
              void addAccount(name)
                .then(() => {
                  setName('')
                  notificationOpen({ message: '账户已添加', description: '记得在顶部切过去再导入', type: 'success' })
                })
                .catch((e: unknown) => {
                  notificationOpen({
                    message: '添加失败',
                    description: e instanceof Error ? e.message : String(e),
                    type: 'error',
                  })
                })
            }}
          >
            添加
          </Button>
        </div>
      </Card>
    </div>
  )
}
