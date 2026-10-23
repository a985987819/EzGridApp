import { useMemo, useRef, useState } from 'react'
import { useApp } from '../store/useApp'
import { parseWorkbook, parseWorkbookFile } from '../io/parseWorkbook'
import { buildLedger } from '../domain/ledger'
import { compareBaseline } from '../domain/baseline'
import { CheckGrid } from '../components/CheckGrid'
import { downloadText, toCsv } from '../ui/csv'
import { money, price, qty } from '../ui/format'

const ANOMALY_LABEL: Record<string, string> = {
  needsPrice: '待补价格',
  dateMissing: '待补日期',
  negativeProfit: '负盈利',
}

export function ImportPage({ goOverview }: { goOverview: () => void }) {
  const { stocks, records, preview, setPreview, commitImport, deriveSellPrice, setDeriveSellPrice, batches, rollbackBatch } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const previewLedger = useMemo(
    () => (preview ? buildLedger(preview.records, stocks, { deriveSellPrice }) : null),
    [preview, stocks, deriveSellPrice],
  )
  const previewChecks = useMemo(
    () => (previewLedger ? compareBaseline(previewLedger) : []),
    [previewLedger],
  )

  async function onFile(f: File | null) {
    if (!f) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const p = await parseWorkbookFile(f)
      setPreview(p)
      ;(window as unknown as { __lastFile?: string }).__lastFile = f.name
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function loadDemo() {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await fetch(encodeURI('/demo/26年网格记录.xlsx'))
      if (!res.ok) throw new Error(`示例文件读取失败（HTTP ${res.status}）`)
      const p = parseWorkbook(new Uint8Array(await res.arrayBuffer()))
      setPreview(p)
      ;(window as unknown as { __lastFile?: string }).__lastFile = '26年网格记录.xlsx'
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onCommit() {
    if (!preview) return
    setBusy(true)
    try {
      const name = (window as unknown as { __lastFile?: string }).__lastFile ?? '导入文件.xlsx'
      const out = await commitImport(preview, name)
      setDone(`新增 ${out.added} 行，跳过重复 ${out.duplicated} 行`)
      setPreview(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function exportAnomalies() {
    if (!previewLedger) return
    const rows: (string | number)[][] = [['类型', 'Excel行号', '股票', '说明']]
    for (const a of previewLedger.anomalies) {
      rows.push([ANOMALY_LABEL[a.kind] ?? a.kind, a.sourceRow, a.stockName, a.detail])
    }
    downloadText('异常清单.csv', toCsv(rows), 'text/csv;charset=utf-8')
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>导入</h2>
          <p>只读第 1 个工作表「交易记录」；先出 dry-run 报告，点「写入本地」才落库（S2 门槛）</p>
        </div>
        <span className="tag">{records.length} 行已在本地</span>
      </div>

      <div className="card">
        <header>
          <h3>选择文件</h3>
          <span className="hint">支持 .xlsx / .xls；不会修改原文件</span>
        </header>
        <div className="body">
          <div className="row">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />
            <button className="btn ghost sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              重新选择
            </button>
            <button className="btn sm" onClick={() => void loadDemo()} disabled={busy}>
              载入内置示例
            </button>
            <div className="spacer" />
            <label className="row" style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              <input
                type="checkbox"
                checked={deriveSellPrice}
                onChange={(e) => setDeriveSellPrice(e.target.checked)}
              />
              已成交行也按「买入价+间隔」推定成交价
            </label>
          </div>
          {busy && <p className="note">解析中…</p>}
          {error && <p className="err">解析失败：{error}</p>}
          {done && <p className="tag ok" style={{ marginTop: 8 }}>{done}</p>}
          <p className="note" style={{ marginBottom: 0, marginTop: 10 }}>
            默认不推定成交价，与文档 §03 口径一致：R44 的目标售价保持「待补」，全表盈利 ¥9,830。
            勾上后 R44 按 18.81+1.07 计入，全表盈利变 ¥10,152。
          </p>
        </div>
      </div>

      {batches.length > 0 && (
        <div className="card">
          <header>
            <h3>导入批次</h3>
            <span className="hint">回滚只会移除这一批新增的行，之前手动改过的行也会一起被移除</span>
          </header>
          <div className="body tight">
            <table className="grid">
              <thead>
                <tr>
                  <th className="l">文件</th>
                  <th className="l">工作表</th>
                  <th>时间</th>
                  <th>解析行</th>
                  <th>新增</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td className="l">{b.fileName}</td>
                    <td className="l muted">{b.sheetName}</td>
                    <td className="num">{new Date(b.importedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td className="num">{b.recordCount}</td>
                    <td className="num">{b.addedCount}</td>
                    <td>
                      <button
                        className="btn sm ghost"
                        onClick={() => {
                          if (!window.confirm(`回滚「${b.fileName}」这一批（${b.addedCount} 行）？`)) return
                          void rollbackBatch(b.id).then((n) => setDone(`已回滚 ${n} 行`))
                        }}
                      >
                        回滚
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview && previewLedger && (
        <>
          <div className="card">
            <header>
              <h3>dry-run 报告</h3>
              <span className="hint">
                {preview.sheetName} · {preview.records.length} 行有效 · 跳过 {preview.skippedRows.length} 行
              </span>
            </header>
            <div className="body">
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="tag">买入 {qty(previewLedger.totals.buyQty)} 股 / {money(previewLedger.totals.buyAmountCents)}</span>
                <span className="tag">卖出 {previewLedger.totals.sellCount} 笔 / {money(previewLedger.totals.sellAmountCents)}</span>
                <span className="tag">盈利 {money(previewLedger.totals.profitCents)}</span>
                <span className="tag">待卖 {previewLedger.totals.targetCount} 条 / {qty(previewLedger.totals.targetQty)} 股</span>
                <span className="tag">待买 {previewLedger.totals.rebuyCount} 条 / {qty(previewLedger.totals.rebuyQty)} 股</span>
                <span className="tag">净持仓 {qty(previewLedger.totals.netQty)} 股</span>
              </div>
              {preview.missingColumns.length > 0 && (
                <p className="err">缺少列：{preview.missingColumns.join('、')}</p>
              )}
              <CheckGrid checks={previewChecks} />
              <div className="row" style={{ marginTop: 16 }}>
                <button className="btn primary" onClick={() => void onCommit()} disabled={busy}>
                  写入本地
                </button>
                <button className="btn" onClick={() => setPreview(null)} disabled={busy}>
                  放弃这次导入
                </button>
                <div className="spacer" />
                <button className="btn ghost" onClick={exportAnomalies}>
                  导出异常清单 CSV
                </button>
                <button className="btn ghost" onClick={goOverview}>
                  看概览
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <header>
              <h3>异常清单</h3>
              <span className="hint">{previewLedger.anomalies.length} 条</span>
            </header>
            <div className="body tight anomaly-list">
              {previewLedger.anomalies.length === 0 ? (
                <div className="empty">没有异常，干净。</div>
              ) : (
                <table className="grid">
                  <thead>
                    <tr>
                      <th className="l">类型</th>
                      <th>Excel 行</th>
                      <th className="l">股票</th>
                      <th className="l">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewLedger.anomalies.map((a, i) => (
                      <tr key={`${a.kind}-${a.sourceRow}-${i}`}>
                        <td className="l">
                          <span className={a.kind === 'needsPrice' ? 'tag bad' : 'tag warn'}>
                            {ANOMALY_LABEL[a.kind] ?? a.kind}
                          </span>
                        </td>
                        <td className="num">{a.sourceRow}</td>
                        <td className="l">{a.stockName}</td>
                        <td className="l muted" style={{ whiteSpace: 'normal' }}>{a.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="card">
            <header>
              <h3>待买 / 待卖预演</h3>
              <span className="hint">按 P 列生成待买、按 E 列生成待卖</span>
            </header>
            <div className="body split">
              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>待买 {previewLedger.orders.length} 条</h4>
                <table className="grid">
                  <thead>
                    <tr>
                      <th>行</th>
                      <th className="l">股票</th>
                      <th>回补价</th>
                      <th>基础</th>
                      <th>奖励</th>
                      <th>金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewLedger.orders.map((o) => (
                      <tr key={o.id}>
                        <td className="num">{o.sourceRow}</td>
                        <td className="l">{o.stockName}</td>
                        <td className="num">{price(o.rebuyPriceCents)}</td>
                        <td className="num">{qty(o.baseQty)}</td>
                        <td className="num">{qty(o.rewardQty)}</td>
                        <td className="num">{money(o.rebuyPriceCents * (o.baseQty + o.rewardQty))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>待卖 {previewLedger.targets.length} 条（前 12）</h4>
                <table className="grid">
                  <thead>
                    <tr>
                      <th>行</th>
                      <th className="l">股票</th>
                      <th>目标价</th>
                      <th>股数</th>
                      <th>金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewLedger.targets.slice(0, 12).map((t) => (
                      <tr key={t.id}>
                        <td className="num">{t.lotId.replace('lot:', '')}</td>
                        <td className="l">{t.stockName}</td>
                        <td className="num">{price(t.priceCents)}</td>
                        <td className="num">{qty(t.qty)}</td>
                        <td className="num">{money(t.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
