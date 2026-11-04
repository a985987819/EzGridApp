/** 明细按「第 N 笔」选择；序号由 recordNo 派生，不是 Excel 行号。 */
export const MAX_RECORD_SELECTION = 5000

export interface RecordSelection {
  numbers: Set<number>
  /** 有错误时 numbers 为空；调用方应显示错误并停止匹配，不能当成未筛选。 */
  error: string | null
}

const invalid = (error: string): RecordSelection => ({ numbers: new Set(), error })

/**
 * 接受 2、5、8-10 / 第2笔 / 全角数字；列表项之间是「或」。
 * 先校验范围长度再展开，并限制总选择数量，避免很大的范围卡住页面。
 */
export function parseRecordSelection(input: string): RecordSelection {
  const text = input.normalize('NFKC').trim()
  if (!text) return { numbers: new Set(), error: null }
  if (text.length > 100000) return invalid('序号输入过长，请缩小选择范围')
  const tokens = text
    .replace(/\s*([-~至到])\s*/g, '$1')
    .replace(/第\s+(?=\d)/g, '第')
    .replace(/(\d)\s+笔/g, '$1笔')
    .split(/[,、;\s]+/)
    .filter(Boolean)
  if (tokens.length === 0) return invalid('请输入序号，例如 2、5、8-10')

  const numbers = new Set<number>()
  for (const token of tokens) {
    const match = /^(?:第)?(\d+)(?:笔)?(?:[-~至到](?:第)?(\d+)(?:笔)?)?$/.exec(token)
    if (!match) return invalid('序号格式有误，请输入 2、5 或 8-10')
    const first = Number(match[1])
    const last = match[2] === undefined ? first : Number(match[2])
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < 1)
      return invalid('序号须为有效的正整数')
    if (last < first) return invalid('序号范围须从小到大，例如 8-10')
    if (last - first + 1 > MAX_RECORD_SELECTION)
      return invalid(`一次最多选择 ${MAX_RECORD_SELECTION} 笔，请缩小序号范围`)
    for (let value = first; value <= last; value += 1) {
      numbers.add(value)
      if (numbers.size > MAX_RECORD_SELECTION)
        return invalid(`一次最多选择 ${MAX_RECORD_SELECTION} 笔，请缩小序号范围`)
    }
  }
  return { numbers, error: null }
}
