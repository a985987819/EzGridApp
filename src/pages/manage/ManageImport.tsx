import { useMemo, useState } from 'react'
import { Button, Card, Tag, notificationOpen } from 'animal-island-ui'
import { useApp } from '../../store/useApp'
import { parseWorkbookFile, parseCsvFile } from '../../io/parseWorkbook'
import { buildLedger } from '../../domain/ledger'
import { compareBaseline } from '../../domain/baseline'
import { buildNanoIdIndex } from '../../ui/nanoid'
import { CheckList } from '../../components/CheckGrid'
import { downloadText, toCsv } from '../../ui/csv'
import { money, price, qty } from '../../ui/format'
import type { TradesQuery } from '../../ui/nav'
import { IconDownload, IconUpload } from '../../ui/icons'

const ANOMALY_LABEL: Record<string, string> = {
  needsPrice: '待补价格',
  needsCost: '待补成本',
  dateMissing: '待补日期',
  negativeProfit: '负盈利',
  oversell: '卖出超量',
}

/** 参与「同 key 内容 diff」的文件来源字段（本地才有的 deletedAt/批次等不参与） */
const DIFF_FIELDS: { key: 'buyDateSerial' | 'buyPriceCents' | 'buyQtyRaw' | 'targetPriceCents' | 'soldQty' | 'sellDateSerial' | 'earlyBuyPriceCents'; label: string }[] = [
  { key: 'buyDateSerial', label: '买入日期' },
  { key: 'buyPriceCents', label: '买入价' },
  { key: 'buyQtyRaw', label: '份额' },
  { key: 'targetPriceCents', label: '目标售价' },
  { key: 'soldQty', label: '卖出数量' },
  { key: 'sellDateSerial', label: '卖出日期' },
  { key: 'earlyBuyPriceCents', label: '回补价' },
]

export function ManageImport({ goTrades }: { goTrades: (q: TradesQuery) => void }) {
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
  } = useApp()
  const [busy, setBusy] = useState(false)
  const [lastFile, setLastFile] = useState('导入文件.xlsx')

  const previewLedger = useMemo(
    () => (preview ? buildLedger(preview.records, stocks, { deriveSellPrice }) : null),
    [preview, stocks, deriveSellPrice],
  )
  // 异常行跳明细用 nanoId 定位（V9.4），与明细页筛选同源
  const nano = useMemo(() => buildNanoIdIndex(records), [records])
  const previewChecks = useMemo(() => (previewLedger ? compareBaseline(previewLedger) : []), [previewLedger])

  // P9 幂等：同 importKey 不覆盖。这里把「key 相同但文件内容改过」的行挑出来，
  // 不然用户在 Excel 里改了错字重导，被静默跳过还以为同步成功了
  const conflicts = useMemo(() => {
    if (!preview) return []
    const localByKey = new Map(records.map((r) => [r.importKey, r]))
    const out: { row: number; fields: string[] }[] = []
    for (const r of preview.records) {
      const local = localByKey.get(r.importKey)
      if (!local) continue
      const fields = DIFF_FIELDS.filter((f) => (local[f.key] ?? null) !== (r[f.key] ?? null)).map((f) => f.label)
      if (fields.length > 0) out.push({ row: r.sourceRow, fields })
    }
    return out
  }, [preview, records])

  async function handleFile(file: File) {
    setBusy(true)
    try {
      const isCsv = /\.csv$/i.test(file.name)
      const p = isCsv ? await parseCsvFile(file) : await parseWorkbookFile(file)
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

  async function onCommit() {
    if (!preview) return
    setBusy(true)
    try {
      const out = await commitImport(preview, lastFile)
      setPreview(null)
      notificationOpen({
        message: '已写入本地',
        description: `新增 ${out.added} 行${out.updated ? `，更新 ${out.updated} 行` : ''}${out.duplicated ? `，无变化 ${out.duplicated} 行` : ''}`,
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
        {/*
         * V9.52 移动端修复：原来用组件库的 Upload（隐藏 input + 程序 click + 只认扩展名的 accept），
         * iOS / 微信 WebView 里点开选择器后文件全被过滤成灰的，等于「无法选择文件」。
         * V9.52.1：label htmlFor + display:none 的 input 在部分手机 WebView 里点击无反应，
         * 改成透明 input 直接铺满整个区域（opacity:0 + absolute inset:0），手指点的就是原生 input，
         * 不依赖 label 转发，也不依赖任何 JS click()。桌面端拖拽保留（事件冒泡到 label）。
         */}
        <label
          htmlFor="import-file-input"
          className="import-drop"
          data-testid="import-picker"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            if (busy) return
            const f = e.dataTransfer?.files?.[0]
            if (f) void handleFile(f)
          }}
          style={{ display: 'block', cursor: 'pointer', position: 'relative' }}
        >
          <input
            id="import-file-input"
            name="import-file"
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/octet-stream"
            disabled={busy}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              opacity: 0,
              cursor: 'pointer',
              // busy 时让整个区域不可点；正常时必须吃满整块区域接住 tap
              pointerEvents: busy ? 'none' : 'auto',
            }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              // 同一个文件连选两次也要触发 change
              e.currentTarget.value = ''
              if (f) void handleFile(f)
            }}
          />
          {/* 内容层不抢事件，tap/drop 都落在铺满的 input 上 */}
          <div className="empty-box" style={{ padding: '10px 0', pointerEvents: 'none' }}>
            <strong>
              <IconUpload /> 选一个 Excel / CSV
            </strong>
            点这里选择文件，或者把文件拖进来
          </div>
        </label>
        <p className="tiny muted" style={{ margin: '6px 0 0' }}>
          支持 .xlsx / .xls / .csv；xlsx 只读第 1 个工作表「交易记录」，csv 整表读入，不改原文件
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="tiny muted">
            本地已有 {records.filter((r) => !r.deletedAt).length} 行
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
            {(() => {
              const buyToday = preview.records.filter((r) => r.buyDateNeedsToday).map((r) => r.sourceRow)
              const sellToday = preview.records.filter((r) => r.sellDateNeedsToday).map((r) => r.sourceRow)
              if (buyToday.length === 0 && sellToday.length === 0) return null
              return (
                <div className="hint-block" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                  <b>日期是 =TODAY() 公式、没存计算结果：</b>
                  {buyToday.length > 0 && <> 买入日期 {buyToday.length} 行（R{buyToday.join('、R')}）</>}
                  {buyToday.length > 0 && sellToday.length > 0 && '；'}
                  {sellToday.length > 0 && <> 卖出日期 {sellToday.length} 行（R{sellToday.join('、R')}）</>}
                  。这类格子打开 Excel 只会显示「当天」，不是真实成交日，
                  所以按缺失入库，在明细里补一下即可。
                </div>
              )
            })()}
            {conflicts.length > 0 && (
              <div className="hint-block" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <b>与本地同 key 但回补价有差异：{conflicts.length} 行</b>
                （{conflicts.slice(0, 6).map((c) => `R${c.row}：${c.fields.join('、')}`).join('；')}
                {conflicts.length > 6 && '…'}）。
                写入时会按行身份更新本地的回补价；其余买入侧信息相同的行也会同步最新卖出状态。
              </div>
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
                <div
                  className="line clickable"
                  key={`${a.kind}-${a.sourceRow}-${i}`}
                  onClick={() => goTrades({ id: nano.rowToId.get(a.sourceRow), stock: a.stockName })}
                >
                  <div className="left">
                    <div className="t1" style={{ fontWeight: 500 }}>
                      {ANOMALY_LABEL[a.kind] ?? a.kind}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}> · Excel 第 {a.sourceRow} 行 · {a.stockName}</span>
                    </div>
                    <div className="t2">{a.detail}</div>
                  </div>
                </div>
              ))}
              </div>
            )}
            <p className="tiny muted" style={{ margin: '8px 0 0' }}>
              点异常行 → 跳到明细页并定位到那一行；若这份文件还没「写入本地」，明细会是空的。
            </p>
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
                  <div className="t2">Excel 第 {o.sourceRow} 行 · {o.stockName}{o.rewardQty ? ` · 奖励 ${o.rewardQty}` : ''}</div>
                </div>
                <div className="right num">{money(o.rebuyPriceCents * (o.baseQty + o.rewardQty))}</div>
              </div>
            ))}
            {previewLedger.targets.slice(0, 8).map((t) => (
              <div className="line" key={t.id}>
                <div className="left">
                  <div className="t1 num">目标 {price(t.priceCents)} × {qty(t.qty)}</div>
                  <div className="t2">Excel 第 {t.lotId.replace('lot:', '')} 行 · {t.stockName}</div>
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
                    if (
                      !window.confirm(
                        `回滚会物理删除「${b.fileName}」这一批 ${b.addedCount} 行（不可恢复，审计日志保留），\n` +
                          `并一起清掉指向这些行的挂钩、拆分档、同价合并、回本链归属与改单计划；\n` +
                          `之后可重新导入同一文件。确定回滚？`,
                      )
                    )
                      return
                    // V9.56：加了「这批还有回补成交 → 先撤销」的拦截，错误必须冒出来，别静默失败
                    void rollbackBatch(b.id)
                      .then((n) => notificationOpen({ message: `已回滚 ${n} 行`, type: 'info' }))
                      .catch((e) =>
                        notificationOpen({
                          message: '无法回滚',
                          description: e instanceof Error ? e.message : String(e),
                          type: 'error',
                        }),
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
