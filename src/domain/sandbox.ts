/**
 * 沙盒模式（V9.39）：手动加进来的「待买 / 待卖」先只活在预览里，不写明细。
 *
 * 两种模拟条目：
 *   - buy  模拟待卖 = 先买入一批（买入价 + 目标价）→ 预览里生成 lot + 待卖目标；
 *   - sell 模拟待买 = 先卖后买（卖出价 + 回补价）→ 预览里生成裸卖 + 待买订单，
 *     还可以像真实裸卖一样挂到未卖的高位批次上，预演已实现盈利 / 理想可卖到的变化。
 *
 * 预览 ledger = 真实 records + sandboxRecords；真实 hedges + 模拟 hedges。
 * sourceRow 从 300000 起，只用于派生展示，绝不落库（手动行 100000、回补批次 200000）。
 */
import { isoToSerial } from './edit'
import { centsToYuan } from './money'
import type { ManualInput } from './manual'
import type { HedgeLink, RawRecord } from './types'

export const SANDBOX_ROW_BASE = 300000

export type SandboxKind = 'buy' | 'sell'

export interface SandboxItem {
  id: string
  /** 稳定序号：预览行号 = SANDBOX_ROW_BASE + seq */
  seq: number
  /** buy = 模拟待卖（买入批次）；sell = 模拟待买（先卖后买） */
  kind: SandboxKind
  stockName: string
  /** YYYY-MM-DD（默认今天） */
  date: string
  /** 买入价 / 卖出成交价（分） */
  priceCents: number
  qty: number
  /** buy 的目标售价（分）；sell 不用 */
  targetPriceCents: number | null
  /** sell 的回补价 P（分）；buy 不用 */
  rebuyPriceCents: number | null
}

export interface SandboxState {
  active: boolean
  items: SandboxItem[]
  /** 模拟挂钩：sellRow 指向模拟行，items 可指向真实批次或模拟批次（纯预览） */
  hedges: HedgeLink[]
}

export const EMPTY_SANDBOX: SandboxState = { active: false, items: [], hedges: [] }

export type SandboxDraft = Omit<SandboxItem, 'id' | 'seq'>

export function sandboxRowOf(item: Pick<SandboxItem, 'seq'>): number {
  return SANDBOX_ROW_BASE + item.seq
}

export function isSandboxRow(row: number): boolean {
  return row >= SANDBOX_ROW_BASE
}

export function sandboxItemAtRow(items: SandboxItem[], row: number): SandboxItem | null {
  return items.find((i) => sandboxRowOf(i) === row) ?? null
}

export function nextSandboxSeq(items: SandboxItem[]): number {
  return items.reduce((a, i) => Math.max(a, i.seq), 0) + 1
}

export function makeSandboxItem(draft: SandboxDraft, seq: number): SandboxItem {
  return { ...draft, id: `sandbox:${seq}:${Date.now()}`, seq }
}

/** 模拟条目 → 预览用 RawRecord（不落库，sourceRow 走 300000 段） */
export function sandboxRecords(items: SandboxItem[]): RawRecord[] {
  return items.map((item) => {
    const base: RawRecord = {
      sourceRow: sandboxRowOf(item),
      stockName: item.stockName,
      buyDateSerial: null,
      buyPriceCents: null,
      buyQtyRaw: null,
      qtyNeedsDerive: false,
      targetPriceCents: null,
      targetNeedsDerive: false,
      soldQty: null,
      sellDateSerial: null,
      earlyBuyPriceCents: null,
      rawProfitCents: null,
      importKey: `sandbox:${item.id}`,
      origin: 'manual',
      batchId: null,
    }
    const serial = isoToSerial(item.date)

    if (item.kind === 'buy') {
      return {
        ...base,
        buyDateSerial: serial,
        buyPriceCents: item.priceCents,
        buyQtyRaw: item.qty,
        targetPriceCents: item.targetPriceCents,
        // 目标价没填 → 交给 ledger 按「买入价 + 该股间隔」派生
        targetNeedsDerive: item.targetPriceCents === null,
      }
    }

    return {
      ...base,
      // 裸卖：E 列 = 卖出成交价，P 列 = 回补价
      targetPriceCents: item.priceCents,
      soldQty: item.qty,
      sellDateSerial: serial,
      earlyBuyPriceCents: item.rebuyPriceCents,
      rebuyPriceSource: item.rebuyPriceCents !== null ? 'custom' : undefined,
    }
  })
}

/** 记为成交时复用「新增一笔」同一条口径 */
export function sandboxSellInput(item: SandboxItem): ManualInput {
  return {
    kind: 'sell',
    stockName: item.stockName,
    date: item.date,
    price: centsToYuan(item.priceCents),
    qty: String(item.qty),
    rebuyPrice: item.rebuyPriceCents !== null ? centsToYuan(item.rebuyPriceCents) : undefined,
  }
}

export function sandboxBuyInput(item: SandboxItem): ManualInput {
  return {
    kind: 'buy',
    stockName: item.stockName,
    date: item.date,
    price: centsToYuan(item.priceCents),
    qty: String(item.qty),
    targetPrice: item.targetPriceCents !== null ? centsToYuan(item.targetPriceCents) : undefined,
  }
}
