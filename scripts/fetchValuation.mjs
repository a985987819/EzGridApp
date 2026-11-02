/**
 * 估值温度带快照生成：抓取东方财富近 5 年日频（收盘价 / PE-TTM / PB-MRQ），
 * 产出 src/domain/valuationData.json（随 PWA 预缓存、离线可用）。
 *
 * 运行：npm run refresh-valuation
 * 何时重跑：想要更新百分位窗口、个股除权除息后（前复权整条序列会被重定基，
 * 不刷新的话「昨收 vs 快照收盘」的缩放估算会失真）。
 *
 * 口径（docs/估值温度带.md）：
 * - 收盘价用前复权（今日收盘 = 真实价，历史经过复权消除分红送转跳空），存整数分。
 * - PE/PB 取 datacenter 每日估值（PE_TTM / PB_MRQ），**保留负值**——亏损期是「失效」
 *   而不是「缺失」，domain 层据此区分；接口没覆盖到的日期存 null。
 * - 股票键 = 应用内股票名（defaults.ts DEFAULT_STOCKS），不是交易所简称（安道麦A ≠ 安道麦）。
 */

const STOCKS = [
  { name: '柳工', secid: '0.000528', code: '000528' },
  { name: '三一重工', secid: '1.600031', code: '600031' },
  { name: '奥佳华', secid: '0.002614', code: '002614' },
  { name: '安道麦', secid: '0.000553', code: '000553' },
]

const WINDOW_YEARS = 5

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (EzGridApp valuation snapshot)' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} ← ${url.slice(0, 80)}`)
  return res.json()
}

async function fetchKline(secid, beg) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53&klt=101&fqt=1&beg=${beg}&end=20500101`
  const json = await fetchJson(url)
  const lines = json?.data?.klines
  if (!Array.isArray(lines) || lines.length === 0) throw new Error(`kline 空: ${secid}`)
  // f51=日期, f53=收盘（前复权）
  return lines.map((line) => {
    const [date, close] = line.split(',')
    return { date, close: Number(close) }
  })
}

async function fetchValue(code) {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET` +
    `&columns=TRADE_DATE,PE_TTM,PB_MRQ&filter=(SECURITY_CODE%3D%22${code}%22)` +
    `&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=3000&pageNumber=1`
  const json = await fetchJson(url)
  const rows = json?.result?.data
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`估值空: ${code}`)
  const map = new Map()
  for (const row of rows) {
    const date = String(row.TRADE_DATE).slice(0, 10)
    const pe = row.PE_TTM == null ? null : Number(row.PE_TTM)
    const pb = row.PB_MRQ == null ? null : Number(row.PB_MRQ)
    map.set(date, {
      pe: pe != null && Number.isFinite(pe) ? Math.round(pe * 100) / 100 : null,
      pb: pb != null && Number.isFinite(pb) ? Math.round(pb * 100) / 100 : null,
    })
  }
  return map
}

const begDate = isoDaysAgo(WINDOW_YEARS * 365 + 10)
const stocks = {}
let asOf = ''

for (const { name, secid, code } of STOCKS) {
  const [kline, values] = await Promise.all([fetchKline(secid, begDate.replaceAll('-', '')), fetchValue(code)])
  const days = kline
    .filter((k) => k.date >= begDate && Number.isFinite(k.close) && k.close > 0)
    .map((k) => {
      const v = values.get(k.date)
      return [k.date, Math.round(k.close * 100), v?.pe ?? null, v?.pb ?? null]
    })
  if (days.length === 0) throw new Error(`${name} 过滤后没有交易日`)
  const last = days[days.length - 1]
  const lossDays = days.filter((d) => d[2] != null && d[2] <= 0).length
  stocks[name] = { code, days }
  if (last[0] > asOf) asOf = last[0]
  console.log(
    `${name}(${code}) ${days.length} 天 ${days[0][0]} → ${last[0]} | 收盘 ${(last[1] / 100).toFixed(2)}` +
      ` | PE ${last[2] ?? '—'} PB ${last[3] ?? '—'} | 亏损期 ${lossDays} 天`,
  )
}

const out = { asOf, source: 'eastmoney', stocks }
const { writeFileSync } = await import('node:fs')
const target = new URL('../src/domain/valuationData.json', import.meta.url)
writeFileSync(target, JSON.stringify(out))
console.log(`\n已写入 ${target.pathname}（asOf ${asOf}）`)
