import { useRef } from 'react'
import { Button, Card, Collapse, Switch, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../../store/useApp'
import { downloadText } from '../../ui/csv'
import { IconDownload, IconUpload } from '../../ui/icons'

export function ManageBackup() {
  const {
    exportBackup,
    restoreBackup,
    resetAll,
    records,
    audits,
    basename,
    deriveSellPrice,
    setDeriveSellPrice,
    lastBackupAt,
    systemFont,
    setSystemFont,
  } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="stack">
      <Card>
        <div className="row" style={{ marginBottom: 8 }}>
          <strong style={{ fontSize: 14 }}>备份</strong>
          <div className="spacer" />
          <Tag size="small" variant="soft">{records.length} 行 · {audits.length} 条审计</Tag>
        </div>
        <div className="stack tight">
          <Button
            block
            type="primary"
            onClick={() => {
              void exportBackup().then((json) => {
                const stamp = new Date().toISOString().slice(0, 10)
                downloadText(`grid-backup-${stamp}.json`, json, 'application/json;charset=utf-8')
                notificationOpen({ message: '备份已导出', type: 'success' })
              })
            }}
          >
            <IconDownload /> 导出全量 JSON
          </Button>
          <Button block onClick={() => fileRef.current?.click()}>
            <IconUpload /> 从 JSON 恢复
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              void f.text().then(async (text) => {
                try {
                  await restoreBackup(text)
                  notificationOpen({ message: '备份已恢复', type: 'success' })
                } catch (err) {
                  notificationOpen({
                    message: '恢复失败',
                    description: err instanceof Error ? err.message : String(err),
                    type: 'error',
                  })
                }
              })
            }}
          />
          <Button
            block
            danger
            onClick={() => {
              if (!window.confirm('清空本地交易记录与审计？股票配置保留。建议先导出备份。')) return
              void resetAll().then(() => notificationOpen({ message: '已清空', type: 'info' }))
            }}
          >
            清空交易记录
          </Button>
        </div>
        <p className="hint-block" style={{ margin: '10px 0 0' }}>
          当前数据源：{basename}。数据只存在本机 IndexedDB，长期不打开会被浏览器清理，<b>建议每周导出一次</b>。
          <br />
          上次备份：
          <b>
            {lastBackupAt
              ? `${new Date(lastBackupAt).toLocaleString('zh-CN', { hour12: false })}（${Math.floor((Date.now() - lastBackupAt) / 86400000)} 天前）`
              : '还没备份过'}
          </b>
        </p>
      </Card>

      <Card>
        <div className="row">
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: 14 }}>已成交行的成交价推定</strong>
            <p className="hint-block" style={{ margin: '4px 0 0' }}>
              关（默认）：R44 目标售价留空 → 待补价格，全表盈利 <b>¥9,830</b>。
              开：R44 按 18.81 + 1.07 计入 → <b>¥10,152</b>。
            </p>
          </div>
          <Switch checked={deriveSellPrice} onChange={setDeriveSellPrice} aria-label="成交价推定" />
        </div>
      </Card>

      <Card>
        <div className="row">
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: 14 }}>使用系统字体</strong>
            <p className="hint-block" style={{ margin: '4px 0 0' }}>
              组件库自带三档中文字体（各约 1.1MB）。打开后改用系统字体，浏览器不再下载这些字体文件，
              手机上首屏更轻；代价是少一点岛民手写感。
            </p>
          </div>
          <Switch checked={systemFont} onChange={(v) => void setSystemFont(v)} aria-label="使用系统字体" />
        </div>
      </Card>

      <Card>
        <Collapse
          question="版本说明（V7）"
          answer={
            <div className="hint-block">
              <p style={{ marginTop: 0 }}>
                已实现：整数分精度内核、只读导入、R1/R2/R4/R5 清单与奖励、三条守恒断言、基准快照、
                概览三格 + 价格网格、明细行内编辑 + 变更审计 + 软删除、挂单清单、月度统计、备份恢复。
              </p>
              <p style={{ marginBottom: 0 }}>
                已实现：回补成交、批次拆多目标、挂单计划价、多账户、导入英文表头兼容。
              </p>
            </div>
          }
        />
      </Card>
    </div>
  )
}
