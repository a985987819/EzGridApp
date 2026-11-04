export interface InstallHelp {
  kind: 'ios' | 'android' | 'mac-safari' | 'desktop' | 'embedded'
  title: string
  steps: readonly string[]
  note: string
}

/** 只选择操作指引；能否直接安装始终以浏览器实际提供的安装事件为准。 */
export function installHelpFor(browser: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): InstallHelp {
  const { userAgent: ua, platform, maxTouchPoints } = browser
  if (/MicroMessenger|\bQQ\/|Weibo|\bwv\b|FBAN|FBAV|Instagram/i.test(ua)) return {
    kind: 'embedded', title: '先在浏览器中打开',
    steps: ['打开当前页面右上角菜单，选择在浏览器中打开。', 'iPhone/iPad 可使用 Safari；安卓或电脑可使用 Chrome、Edge 等浏览器。', '重新打开本网站，进入管理页点击安装应用，或使用浏览器菜单添加到桌面。'],
    note: '内置浏览器可能不提供安装入口；下方网站地址可复制到外部浏览器。',
  }
  if (/iPad|iPhone|iPod/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1)) return {
    kind: 'ios', title: 'iPhone / iPad 添加到主屏幕',
    steps: ['打开浏览器的分享菜单；Safari 部分布局需先点页面菜单，再点分享。', '选择添加到主屏幕；若没有此项，可在编辑操作中添加。', '若出现作为网页 App 打开选项，请开启，再点添加。'],
    note: '此设备通常需通过分享菜单添加；也可在 Safari 中打开本网站后按上述步骤操作。',
  }
  if (/Android/i.test(ua)) return {
    kind: 'android', title: '安卓浏览器安装',
    steps: ['打开浏览器右上角菜单。', '寻找安装应用、安装并创建快捷方式或添加到主屏幕。', '选择安装或添加，按系统提示确认。'],
    note: '菜单名称因浏览器而异；找不到时，可换用 Chrome 或 Edge 打开本网站。',
  }
  if (/Macintosh|Mac OS X/i.test(ua) && /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR/i.test(ua)) return {
    kind: 'mac-safari', title: 'Mac Safari 添加到程序坞',
    steps: ['使用 macOS 14 或更新版本的 Safari 打开本网站。', '在文件菜单或分享菜单中选择添加到程序坞。', '确认名称并点添加，随后可从程序坞打开。'],
    note: '较早的系统可使用 Chrome 或 Edge 的安装菜单。',
  }
  return {
    kind: 'desktop', title: '电脑浏览器安装',
    steps: ['Chrome：打开右上角菜单，在投放、保存和分享中寻找将网页安装为应用。', 'Edge：打开右上角菜单，在更多工具 → 应用中选择安装此网站或安装应用。', '也可使用地址栏中的安装图标；菜单没有安装选项时，可使用新版 Chrome 或 Edge。'],
    note: '如果已经安装，可从桌面、开始菜单或浏览器应用列表打开。',
  }
}
