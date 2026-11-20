/**
 * 文件下载（V9.69）：PWA 独立模式下原来「createObjectURL → a.click() → 立刻 revoke」
 * 会让下载在真正开始前就被取消——界面弹了「已导出」，文件却没落地。
 * 现在锚点先挂进 DOM 再点击，URL 延迟回收（至少留到下载任务启动之后）。
 * JSON 备份不再写入 BOM：带 BOM 的文本 JSON.parse 会直接失败。
 */
function triggerDownload(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  window.setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 60_000)
}

export function downloadText(fileName: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  // CSV 带 BOM 让 Excel 正确识别 UTF-8；JSON/纯文本不加（BOM 会让 JSON.parse 失败）
  const withBom = mime.startsWith('text/csv')
  triggerDownload(fileName, new Blob([withBom ? '\uFEFF' + text : text], { type: mime }))
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
  triggerDownload(fileName, new Blob([bytes], { type: mime }))
}
