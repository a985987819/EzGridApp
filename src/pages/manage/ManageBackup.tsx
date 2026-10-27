import { useRef, useState } from 'react'
import { Button, Card, Collapse, Switch, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../../store/useApp'
import { downloadText, downloadBytes } from '../../ui/csv'
import { openFilePicker } from '../../ui/pickFile'
import { IconDownload, IconUpload } from '../../ui/icons'

import { exportLedgerWorkbook, parseLedgerWorkbook, type LedgerWorkbookPreview } from '../../io/ledgerWorkbook'
import type { LedgerSnapshot } from '../../domain/ledgerSnapshot'
import { LedgerRestorePreview } from '../../components/LedgerRestorePreview'

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
  const [excelPreview, setExcelPreview] = useState<LedgerWorkbookPreview | null>(null)
  const [excelBusy, setExcelBusy] = useState(false)
  const excelRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="stack">
      <Card>
        <div className="stack tight">
          <strong>完整台账 Excel</strong>
          <p className="hint-block">导出全部交易、成交、配置、人工关联与操作历史，以及自动关联和回本链的核对快照。可编辑数据后整库恢复；明细页的 Excel 仅为当前列表。</p>
          <Button block type="primary" disabled={excelBusy} data-action="export-ledger" onClick={() => {
            setExcelBusy(true)
            void (async () => {
              try {
                const snapshot = JSON.parse(await exportBackup()) as LedgerSnapshot
                const data = await exportLedgerWorkbook(snapshot)
                downloadBytes(`网格完整台账-${new Date().toISOString().slice(0, 10)}.xlsx`, data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                notificationOpen({ message: '完整台账 Excel 已导出', type: 'success' })
              } catch (e) { notificationOpen({ message: '导出失败', description: e instanceof Error ? e.message : String(e), type: 'error' }) }
              finally { setExcelBusy(false) }
            })()
          }}><IconDownload /> 导出完整台账 Excel</Button>
          <label htmlFor="ledger-file-input" style={{ display: 'block', position: 'relative', cursor: 'pointer' }} onClick={(e) => {
            if (e.target === excelRef.current || excelBusy) return
            e.preventDefault()
            openFilePicker(excelRef.current)
          }}>
            <input ref={excelRef} id="ledger-file-input" type="file" disabled={excelBusy} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.01, zIndex: 1, cursor: 'pointer' }} onChange={(e) => {
              const file = e.target.files?.[0]
              e.currentTarget.value = ''
              if (!file) return
              setExcelPreview(null)
              setExcelBusy(true)
              void (async () => {
                try {
                  const result = await parseLedgerWorkbook(await file.arrayBuffer())
                  if (!result) throw new Error('这不是完整台账，请到导入页使用普通 Excel/CSV 导入')
                  setExcelPreview(result)
                } catch (err) { notificationOpen({ message: '完整台账校验失败（当前数据未动）', description: err instanceof Error ? err.message : String(err), type: 'error' }) }
                finally { setExcelBusy(false) }
              })()
            }} />
            <div style={{ pointerEvents: 'none' }}><Button block disabled={excelBusy}><IconUpload /> {excelBusy ? '处理中…' : '从完整 Excel 恢复（先预览）'}</Button></div>
          </label>
        </div>
      </Card>
      {excelPreview && <LedgerRestorePreview preview={excelPreview} onClose={() => setExcelPreview(null)} />}
      <Card>
        <div className="sec-head">
          <strong>备份</strong>
          <div className="spacer" />
          <Tag size="small" variant="soft">{records.length} 条记录 · {audits.length} 条审计</Tag>
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
          {/*
           * V9.59：恢复备份原来用「display:none 的 input + 按钮 onClick 里 fileRef.click()」——
           * 程序化 click 在 iOS PWA 独立模式里一直不可靠，点「从 JSON 恢复」毫无反应。
           * 换成导入区验证过的「透明 input 铺满触发区」（V9.52.1）+ 独立模式兜底
           * （opacity 0.01、showPicker/click 兜底，见 ui/pickFile.ts）；accept 补 MIME，
           * 只写扩展名会在部分 WebView 里把文件过滤成灰的（V9.52 的坑）。
           */}
          <label
            htmlFor="restore-file-input"
            style={{ display: 'block', cursor: 'pointer', position: 'relative' }}
            onClick={(e) => {
              if (e.target === fileRef.current) return
              e.preventDefault()
              openFilePicker(fileRef.current)
            }}
          >
            <input
              ref={fileRef}
              id="restore-file-input"
              type="file"
              accept=".json,application/json,text/plain,application/octet-stream"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                opacity: 0.01,
                cursor: 'pointer',
                zIndex: 1,
              }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.currentTarget.value = ''
                if (!f) return
                void f.text().then(async (text) => {
                  try {
                    // S4：恢复是整库覆盖，先把当前库强制导出一份快照，手滑了还有后悔药
                    const snapshot = await exportBackup()
                    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
                    const snapName = `grid-backup-before-restore-${stamp}.json`
                    downloadText(snapName, snapshot, 'application/json;charset=utf-8')
                    await restoreBackup(text)
                    notificationOpen({
                      message: '备份已恢复',
                      description: `恢复前已自动导出当前数据：${snapName}`,
                      type: 'success',
                    })
                  } catch (err) {
                    notificationOpen({
                      message: '恢复失败（当前数据未动，快照已导出到下载目录）',
                      description: err instanceof Error ? err.message : String(err),
                      type: 'error',
                    })
                  }
                })
              }}
            />
            {/* 按钮纯视觉，事件全交给铺满的 input；button 是 labelable 元素，
                必须靠 htmlFor 把 labeled control 钉死在 file input 上 */}
            <div style={{ pointerEvents: 'none' }}>
              <Button block>
                <IconUpload /> 从 JSON 恢复
              </Button>
            </div>
          </label>
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
          从 JSON 恢复会<b>整库覆盖</b>：点恢复时会先把当前数据自动导出一份「恢复前快照」JSON（S4），再写入备份内容。
          快照也算一次备份，会刷新「上次备份」时间（即使随后的恢复失败）。
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
                已实现：回补成交、批次拆多目标、挂单计划价、导入英文表头兼容。
              </p>
            </div>
          }
        />
      </Card>
    </div>
  )
}
