export function downloadText(fileName: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob(['\uFEFF' + text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = cell === null || cell === undefined ? '' : String(cell)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(','),
    )
    .join('\r\n')
}

/** V9.64：二进制下载（xlsx 等）；downloadText 只适合文本 */
export function downloadBytes(fileName: string, data: Uint8Array | ArrayBuffer, mime: string): void {
  // new Uint8Array(data) 拷进独立的 ArrayBuffer（TS 的 BlobPart 不收 SharedArrayBuffer 视图）
  const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data)
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
