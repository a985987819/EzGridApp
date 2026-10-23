import { useMemo, useState } from 'react'
import { Button, Card, Tag, Upload, notificationOpen } from 'animal-island-ui'
import { useApp } from '../../store/useApp'
import { parseWorkbookFile } from '../../io/parseWorkbook'
import { buildLedger } from '../../domain/ledger'
import { compareBaseline } from '../../domain/baseline'
import { CheckList } from '../../components/CheckGrid'
import { downloadText, toCsv } from '../../ui/csv'
import { money, price, qty } from '../../ui/format'
import { IconDownload, IconUpload } from '../../ui/icons'

const ANOMALY_LABEL: Record<string, string> = {
  needsPrice: '待补价格',
  needsCost: '待补成本',
  dateMissing: '待补日期',
  negativeProfit: '负盈利',
}

export function ManageImport() {
  const {
    stocks,
    records,
    preview,
    setPreview,
    commitImport,
    deriveSellPrice,
    setDeriveSellPrice,
    batches,
    rollbackBatch,
    activeAccountId,
    accounts,
  } = useApp()
  const [busy, setBusy] = useState(false)
  const [lastFile, setLastFile] = useState('导入文件.xlsx')

  const previewLedger = useMemo(
    () => (preview ? buildLedger(preview.records, stocks, { deriveSellPrice }) : null),
    [preview, stocks, deriveSellPrice],
  )
  const previewChecks = useMemo(() => (previewLedger ? compareBaseline(previewLedger) : []), [previewLedger])

  async function handleFile(file: File) {
    setBusy(true)
    try {
      const p = await parseWorkbookFile(file)
      setPreview(p)
      setLastFile(file.name)
      notificationOpen({ message: '解析完成', description: `有效 ${p.records.length} 行`, type: 'success' })
    } catch (e) {
      setPreview(null)
      notificationOpen({ message: '解析失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function loadDemo() {
    setBusy(true)
    try {
      const res = await fetch(encodeURI('/demo/26年网格记录.xlsx'))
      if (!res.ok) throw new Error(`示例文件读取失败（HTTP ${res.status}）`)
      const blob = await res.blob()
      await handleFile(new File([blob], '26年网格记录.xlsx'))
    } catch (e) {
      notificationOpen({ message: '示例加载失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function onCommit() {
    if (!preview) return
    setBusy(true)
    try {
      const out = await commitImport(preview, lastFile)
      setPreview(null)
      notificationOpen({
        message: '已写入本地',
        description: `新增 ${out.added} 行${out.duplicated ? `，跳过重复 ${out.duplicated} 行` : ''}`,
        type: 'success',
      })
    } catch (e) {
      notificationOpen({ message: '写入失败', description: e instanceof Error ? e.message : String(e), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  function exportAnomalies() {
    if (!previewLedger) return
    const rows: (string | number)[][] = [['类型', 'Excel行号', '股票', '说明']]
    for (const a of previewLedger.anomalies) rows.push([ANOMALY_LABEL[a.kind] ?? a.kind, a.sourceRow, a.stockName, a.detail])
    downloadText('异常清单.csv', toCsv(rows), 'text/csv;charset=utf-8')
  }

  return (
    <div className="stack">
      <Card>
        <Upload
          accept=".xlsx,.xls"
          maxCount={1}
          drag
          disabled={busy}
          showUploadList={false}
          tip="支持 .xlsx / .xls，只读第 1 个工作表「交易记录」，不改原文件"
          beforeUpload={(file) => {
            void handleFile(file)
            return false
          }}
        >
          <div className="empty-box" style={{ padding: '10px 0' }}>
            <strong>
              <IconUpload /> 选一个 Excel
            </strong>
            或者把文件拖进来
          </div>
        </Upload>
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="small" onClick={() => void loadDemo()} loading={busy}>
            载入内置示例
          </Button>
          <div className="spacer" />
          <span className="tiny muted">
            本地已有 {records.filter((r) => !r.deletedAt).length} 行 · 写入账户：
            {activeAccountId === 'all'
              ? '默认账户'
              : accounts.find((a) => a.id === activeAccountId)?.name ?? '默认账户'}
          </span>
        </div>
        <label className="row" style={{ gap: 8, marginTop: 10, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={deriveSellPrice}
            onChange={(e) => setDeriveSellPrice(e.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          <span className="muted">已成交行也按「买入价+间隔」推定成交价</span>
        </label>
        <p className="hint-block" style={{ margin: '6px 0 0' }}>
          默认不推定，对齐文档 §03：R44 留「待补价格」，全表盈利 ¥9,830。勾上则 R44 按 19.88 计入，变 ¥10,152。
        </p>
      </Card>

      {preview && previewLedger && (
        <>
          <Card>
            <div className="sec-head">
              <strong>dry-run 报告</strong>
              <Tag size="small" variant="soft">{preview.sheetName}</Tag>
              <div className="spacer" />
              <span className="sec-sub">
                {preview.records.length} 行 · 跳过 {preview.skippedRows.length}
              </span>
            </div>
            <div className="row" style={{ gap: 6, marginBottom: 10 }}>
              <Tag size="small" variant="soft" color="app-blue">买 {qty(previewLedger.totals.buyQty)} 股</Tag>
              <Tag size="small" variant="soft" color="app-orange">
                卖 {previewLedger.totals.sellCount} 笔 / {qty(previewLedger.totals.sellQty)} 股
              </Tag>
              <Tag size="small" variant="soft" color="app-green">盈利 {money(previewLedger.totals.profitCents)}</Tag>
              <Tag size="small" variant="soft" color="app-teal">
                待卖 {previewLedger.totals.targetCount} 条 / {qty(previewLedger.totals.targetQty)} 股
              </Tag>
              <Tag size="small" variant="soft" color="purple">
                待买 {previewLedger.totals.rebuyCount} 条 / {qty(previewLedger.totals.rebuyQty)} 股
              </Tag>
            </div>
            {preview.missingColumns.length > 0 && (
              <p className="tiny" style={{ color: 'var(--up)' }}>缺少列：{preview.missingColumns.join('、')}</p>
            )}
            <CheckList checks={previewChecks} />
            <div className="row" style={{ marginTop: 12 }}>
              <Button type="primary" block loading={busy} onClick={() => void onCommit()}>
                写入本地
              </Button>
              <Button onClick={() => setPreview(null)}>放弃</Button>
            </div>
          </Card>

          <Card>
            <div className="sec-head">
              <strong>异常清单</strong>
              <div className="spacer" />
              <span className="sec-sub">{previewLedger.anomalies.length} 条</span>
              <Button size="small" type="text" onClick={exportAnomalies}>
                <IconDownload /> CSV
              </Button>
            </div>
            {previewLedger.anomalies.length === 0 ? (
              <div className="empty-box">没有异常</div>
            ) : (
              <div className="data-block">
              {previewLedger.anomalies.map((a, i) => (
                <div className="line" key={`${a.kind}-${a.sourceRow}-${i}`}>
                  <div className="left">
                    <div className="t1" style={{ fontWeight: 500 }}>
                      {ANOMALY_LABEL[a.kind] ?? a.kind}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}> · 行 {a.sourceRow} · {a.stockName}</span>
                    </div>
                    <div className="t2">{a.detail}</div>
                  </div>
                </div>
              ))}
              </div>
            )}
          </Card>

          <Card>
            <div className="sec-head">
              <strong>清单预演</strong>
              <div className="spacer" />
              <span className="sec-sub">前 8 条待卖</span>
            </div>
            <div className="row divider-bottom" style={{ gap: 6, marginTop: 0 }}>
              <Tag size="small" variant="soft" color="purple">待买 {previewLedger.orders.length}</Tag>
              <Tag size="small" variant="soft" color="app-teal">待卖 {previewLedger.targets.length}</Tag>
            </div>
            <div className="data-block">
            {previewLedger.orders.map((o) => (
              <div className="line" key={o.id}>
                <div className="left">
                  <div className="t1 num">回补 {price(o.rebuyPriceCents)} × {qty(o.baseQty + o.rewardQty)}</div>
                  <div className="t2">行{o.sourceRow} · {o.stockName}{o.rewardQty ? ` · 奖励 ${o.rewardQty}` : ''}</div>
                </div>
                <div className="right num">{money(o.rebuyPriceCents * (o.baseQty + o.rewardQty))}</div>
              </div>
            ))}
            {previewLedger.targets.slice(0, 8).map((t) => (
              <div className="line" key={t.id}>
                <div className="left">
                  <div className="t1 num">目标 {price(t.priceCents)} × {qty(t.qty)}</div>
                  <div className="t2">批次 {t.lotId.replace('lot:', '')} · {t.stockName}</div>
                </div>
                <div className="right num">{money(t.amountCents)}</div>
              </div>
            ))}
            </div>
            {previewLedger.targets.length > 8 && (
              <p className="tiny muted" style={{ margin: '6px 0 0' }}>
                还有 {previewLedger.targets.length - 8} 条待卖，写入后到「挂单」页看全部
              </p>
            )}
          </Card>
        </>
      )}

      <Card>
        <div className="sec-head">
          <strong>导入批次</strong>
          <div className="spacer" />
          <span className="sec-sub">{batches.length} 批</span>
        </div>
        {batches.length === 0 ? (
          <div className="empty-box">还没有导入过</div>
        ) : (
          <div className="data-block">
          {batches.map((b) => (
            <div className="line" key={b.id}>
              <div className="left">
                <div className="t1" style={{ fontWeight: 500 }}>{b.fileName}</div>
                <div className="t2">
                  {new Date(b.importedAt).toLocaleString('zh-CN', { hour12: false })} · 解析 {b.recordCount} 行 · 新增 {b.addedCount}
                </div>
              </div>
              <div className="right">
                <Button
                  size="small"
                  danger
                  onClick={() => {
                    if (!window.confirm(`回滚「${b.fileName}」这一批（${b.addedCount} 行）？`)) return
                    void rollbackBatch(b.id).then((n) =>
                      notificationOpen({ message: `已回滚 ${n} 行`, type: 'info' }),
                    )
                  }}
                >
                  回滚
                </Button>
              </div>
            </div>
          ))}
          </div>
        )}
      </Card>
    </div>
  )
}
