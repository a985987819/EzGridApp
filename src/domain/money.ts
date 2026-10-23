/**
 * 精度内核：所有价格、金额一律整数「分」，数量一律整数「股」。
 * 禁止用浮点数参与任何判定（规范 §7.2）。
 */

export const CENTS_PER_YUAN = 100
/** 每股一手的股数 */
export const HAND = 100

/** 人民币字符串/数字 → 整数分。非法输入返回 null，绝不静默变成 NaN。 */
export function toCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    // 走字符串通道，避免 8.675 * 100 = 867.4999999 这类浮点误差
    return toCents(input.toFixed(6))
  }
  const s = input.trim().replace(/[¥￥,\s]/g, '')
  if (s === '') return null
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  const intPart = Number(m[2])
  const fracRaw = m[3] ?? ''
  if (fracRaw.length <= 2) {
    const frac = Number(fracRaw.padEnd(2, '0'))
    return sign * (intPart * CENTS_PER_YUAN + frac)
  }
  // 超过两位小数：按 ROUND_HALF_UP 舍到分
  const keep = Number(fracRaw.slice(0, 2))
  const next = Number(fracRaw[2])
  const up = next >= 5 ? 1 : 0
  return sign * (intPart * CENTS_PER_YUAN + keep + up)
}

/** 整数分 → 「7.81」字符串 */
export function centsToYuan(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const i = Math.floor(abs / CENTS_PER_YUAN)
  const f = abs % CENTS_PER_YUAN
  return `${sign}${i}.${String(f).padStart(2, '0')}`
}

/** 整数分 → 带千分位的金额 */
export function formatMoney(cents: number): string {
  const s = centsToYuan(cents)
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [i, f] = body.split('.')
  return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`
}

export function formatYuan(cents: number): string {
  return `¥${formatMoney(cents)}`
}

/** 价格 × 数量 = 金额（分），整数乘，安全 */
export function mulCents(priceCents: number, qty: number): number {
  return priceCents * qty
}

/** 四舍五入到整数（用于涨跌停边界，规范 §8.4） */
export function roundHalfUp(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n + 1e-9)
}

/** 整数分往返无损断言用 */
export function isSafeInt(n: number): boolean {
  return Number.isSafeInteger(n)
}
