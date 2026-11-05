/**
 * 本地链派生对照：node audit/2026-11-05/chain-perf.mjs [.tmp/chain-perf.json]
 * 基线为 a819016 的 chain.ts；两边复用当前其余领域代码，隔离链修复/索引的影响。
 * 2次预热、5次交错采样，仅报告median/min/max，不报告p95或浏览器体验。
 * 请在其它构建/测试暂停时运行；临时源码写入系统临时目录，不改工作区源码。
 */
import { createServer } from 'vite'
import { ViteNodeServer } from 'vite-node/server'
import { ViteNodeRunner } from 'vite-node/client'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const domain = path.join(root, 'src/domain')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ezgrid-chain-perf-'))
const baselineRef = 'a819016'
const baselineChain = execFileSync('git', ['show', `${baselineRef}:src/domain/chain.ts`], { cwd: root, encoding: 'utf8' })
const importPath = value => JSON.stringify(value.replaceAll('\\', '/'))
const rewriteImports = (source, chainPath) => source.replace(/from '\.\/([^']+)'/g,
  (_, name) => `from ${importPath(name === 'chain' ? chainPath : path.join(domain, name))}`)
const baselineChainPath = path.join(temporary, 'chain-before.ts')
fs.writeFileSync(baselineChainPath, rewriteImports(baselineChain))
const baselineLedgerPath = path.join(temporary, 'ledger-before.ts')
fs.writeFileSync(baselineLedgerPath, rewriteImports(fs.readFileSync(path.join(domain, 'ledger.ts'), 'utf8'), baselineChainPath))

const json = value => JSON.stringify(value, (_, item) => item instanceof Map ? [...item] : item)
const hash = value => createHash('sha256').update(json(value)).digest('hex')
const server = await createServer({ configFile: false, root, server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'silent' })
try {
  const node = new ViteNodeServer(server)
  const runner = new ViteNodeRunner({ root, base: server.config.base,
    fetchModule: id => node.fetchModule(id), resolveId: (id, importer) => node.resolveId(id, importer) })
  const { buildLedger: before } = await runner.executeFile(baselineLedgerPath)
  const { buildLedger: after } = await runner.executeFile(path.join(domain, 'ledger.ts'))
  const { buildRepairChains: beforeChain } = await runner.executeFile(baselineChainPath)
  const { buildRepairChains: afterChain } = await runner.executeFile(path.join(domain, 'chain.ts'))
  const { dataset } = await runner.executeFile(path.join(root, 'audit/2026-11-04/dataset.ts'))
  const { parseCsvText, parseWorkbook } = await runner.executeFile(path.join(root, 'src/io/parseWorkbook.ts'))
  const { DEFAULT_STOCKS } = await runner.executeFile(path.join(domain, 'defaults.ts'))
  const compare = (snapshot, oldLedger, newLedger) => {
    const baseTLots = new Set(oldLedger.lots.filter(lot => lot.strategyOrigin?.mode === 'baseT').map(lot => lot.id))
    const baseTRows = new Set(snapshot.extraTargets.filter(target => target.strategy?.mode === 'baseT')
      .map(target => target.strategy.sellRow).filter(row => row !== undefined))
    const input = { lots: oldLedger.lots.filter(lot => !baseTLots.has(lot.id)),
      sells: oldLedger.sells.filter(sale => !baseTRows.has(sale.sourceRow) && !baseTRows.has(sale.hedgedFromSellRow) && !baseTLots.has(sale.lotId)),
      executions: snapshot.rebuyExecutions.filter(execution => !baseTRows.has(Number(execution.sellExecId.replace('sell:', '')))),
      links: snapshot.chainLinks, legacyHedgeRows: snapshot.hedges.map(link => link.sellRow) }
    const inputBefore = hash(input)
    const oldChains = beforeChain(input), newChains = afterChain(input)
    const changedFields = Object.keys(newLedger).filter(key => json(oldLedger[key]) !== json(newLedger[key]))
    if (changedFields.some(key => key !== 'repairChains')) throw new Error(`非链投影发生变化：${changedFields.join(',')}`)
    if (hash(input) !== inputBefore) throw new Error('链函数修改了输入')
    return { changedFields, profitSlicesEqual: json(oldChains.profitSlices) === json(newChains.profitSlices),
      realCoverEqual: json(oldChains.realCoverBySell) === json(newChains.realCoverBySell),
      realCoverSlicesEqual: json(oldChains.realCoverSlicesBySell) === json(newChains.realCoverSlicesBySell),
      ledgerHashes: { before: hash(oldLedger), after: hash(newLedger) } }
  }
  const options = snapshot => ({ executions: snapshot.rebuyExecutions, extraTargets: snapshot.extraTargets,
    buyTargets: snapshot.buyTargets, plans: snapshot.plans, hedges: snapshot.hedges, chainLinks: snapshot.chainLinks })
  const samples = []
  for (const [kind, rows] of [['mixed', 1000], ['mixed', 4000], ['mixed-four-stocks', 1000]]) {
    const snapshot = dataset(rows, kind), inputHash = hash(snapshot), opts = options(snapshot)
    const times = { before: [], after: [] }, fingerprints = {}, last = {}
    for (let index = 0; index < 7; index++) {
      const order = index % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]]
      for (const [name, build] of order) {
        const start = performance.now()
        last[name] = build(snapshot.records, snapshot.stocks, opts)
        const duration = performance.now() - start
        if (index >= 2) times[name].push(duration)
        const fingerprint = hash(last[name])
        if (fingerprints[name] && fingerprints[name] !== fingerprint) throw new Error(`输出不稳定：${name}`)
        fingerprints[name] = fingerprint
      }
    }
    const summary = Object.fromEntries(Object.entries(times).map(([name, rawMs]) => {
      const sorted = [...rawMs].sort((a, b) => a - b)
      return [name, { medianMs: sorted[2], minMs: sorted[0], maxMs: sorted[4], rawMs }]
    }))
    if (hash(snapshot) !== inputHash) throw new Error('建账修改了输入')
    const sample = { kind, rows, stocks: snapshot.stocks.length, warmup: 2, samples: 5,
      alternatingOrder: true, ...summary, ...compare(snapshot, last.before, last.after), unchangedInput: true, stableOutput: true }
    samples.push(sample)
    console.log(json(sample))
  }
  const fixtures = []
  for (const file of fs.readdirSync(path.join(root, 'tests/fixtures'))) {
    const bytes = fs.readFileSync(path.join(root, 'tests/fixtures', file))
    const parsed = file.endsWith('.csv') ? await parseCsvText(bytes.toString('utf8')) : await parseWorkbook(bytes)
    const snapshot = { records: parsed.records, stocks: DEFAULT_STOCKS, rebuyExecutions: [], extraTargets: [],
      buyTargets: [], plans: [], hedges: [], chainLinks: [] }
    const result = { file, rows: parsed.records.length,
      ...compare(snapshot, before(snapshot.records, snapshot.stocks), after(snapshot.records, snapshot.stocks)) }
    fixtures.push(result)
    console.log(json(result))
  }
  const result = { capturedAt: new Date().toISOString(), baselineRef, node: process.version, cpu: cpus()[0]?.model,
    candidate: 'working tree', warmup: 2, sampleCount: 5, limit: 'Node合成关系集，小样本median；股票数与行数同时变化，不代表手机性能或p95。链展示/代际归属修复造成的差异单列。', samples, fixtures }
  if (process.argv[2]) {
    const output = path.resolve(root, process.argv[2])
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  }
} finally {
  await server.close()
}
