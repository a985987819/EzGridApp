import type { KeyboardEvent } from 'react'

/**
 * V9.65：确认类弹窗（记成交 / 记卖出 / 改单 / 回补 / 沙盒 / 新增）里按 Enter 直接触发主操作——
 * 少一次「移到按钮再点」。只对文本输入生效：按钮、textarea、select 面板的回车行为不受影响。
 * 保存函数自带的在途保护（savingExec 之类）防止连按重复提交。
 */
export function enterSubmit(save: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter') return
    const target = e.target as HTMLElement
    if (target.tagName !== 'INPUT') return
    e.preventDefault()
    save()
  }
}
