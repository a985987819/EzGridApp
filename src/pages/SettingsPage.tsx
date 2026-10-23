import { useRef, useState } from 'react'
import { useApp } from '../store/useApp'
import { downloadText } from '../ui/csv'

export function SettingsPage() {
  const { exportBackup, restoreBackup, resetAll, records, basename, deriveSellPrice, setDeriveSellPrice } = useApp()
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function onExport() {
    const json = await exportBackup()
    const stamp = new Date().toISOString().slice(0, 10)
    downloadText(`grid-backup-${stamp}.json`, json, 'application/json;charset=utf-8')
    setMsg('备份已导出')
  }

  async function onRestore(f: File | null) {
    if (!f) return
    setError(null)
    try {
      await restoreBackup(await f.text())
      setMsg('备份已恢复')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>备份与设置</h2>
          <p>数据存在浏览器 IndexedDB（Dexie）；长期不打开会被 Safari 清理，建议每周导出一次</p>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>备份</h3>
          <span className="hint">当前 {records.length} 行 · {basename}</span>
        </header>
        <div className="body">
          <div className="row">
            <button className="btn primary" onClick={() => void onExport()}>导出全量 JSON</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>从 JSON 恢复</button>
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={(e) => void onRestore(e.target.files?.[0] ?? null)}
            />
            <div className="spacer" />
            <button
              className="btn ghost"
              onClick={() => {
                if (window.confirm('清空本地的交易记录（股票配置保留）？建议先导出备份。')) void resetAll()
              }}
            >
              清空交易记录
            </button>
          </div>
          {msg && <p className="tag ok" style={{ marginTop: 10 }}>{msg}</p>}
          {error && <p className="err">{error}</p>}
        </div>
      </div>

      <div className="card">
        <header>
          <h3>计算口径</h3>
        </header>
        <div className="body">
          <label className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
            <input
              type="checkbox"
              checked={deriveSellPrice}
              onChange={(e) => setDeriveSellPrice(e.target.checked)}
              style={{ marginTop: 4 }}
            />
            <span className="note">
              <b>已成交行的成交价允许由公式推定。</b>
              关闭（默认）：R44 目标售价留空 → 进「待补价格」，全表盈利 ¥9,830。
              打开：R44 按 18.81 + 1.07 = 19.88 计入，全表盈利 ¥10,152。
            </span>
          </label>
        </div>
      </div>

      <div className="card">
        <header>
          <h3>版本说明（V1）</h3>
        </header>
        <div className="body note">
          <p style={{ marginTop: 0 }}>
            已实现：整数分精度内核、导入解析（只读第 1 表）、R1/R2/R4/R5 清单与奖励、三条守恒断言、基准快照校验、
            概览三格 + 价格网格、明细筛选、挂单清单、月度统计、备份恢复。
          </p>
          <p style={{ marginBottom: 0 }}>
            尚未实现：行内编辑与 AuditLog、多目标（一个批次拆多个卖出目标）、回补成交录入、Playwright E2E，
            以及 12 条细节里的部分条目。详见 README 的「V1 边界」。
          </p>
        </div>
      </div>
    </>
  )
}
