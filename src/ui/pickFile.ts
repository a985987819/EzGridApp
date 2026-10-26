/**
 * V9.59：iOS PWA 独立模式下唤起文件选择器的兜底。
 *
 * 背景：浏览器标签页里「透明 input 铺满触发区」（V9.52.1）工作正常；但独立模式
 * （添加到主屏幕的 WKWebView）有两层坑——全透明 input 的原生激活偶尔不吃 tap，
 * 而程序化 `input.click()` 在独立模式里历史上一直不可靠。所以兜底顺序是
 * `showPicker()`（Safari 16+ 的正规 API，独立模式可用）→ 退回 `click()`。
 *
 * **必须在用户手势（tap 的 click 事件）里调用**，否则浏览器直接拒绝。
 */
export function openFilePicker(input: HTMLInputElement | null | undefined): void {
  if (!input) return
  const el = input as HTMLInputElement & { showPicker?: () => void }
  if (typeof el.showPicker === 'function') {
    try {
      el.showPicker()
      return
    } catch {
      // showPicker 需要用户手势等条件，不满足就退回 click
    }
  }
  el.click()
}
