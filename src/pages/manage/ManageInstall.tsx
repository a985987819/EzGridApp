import { useState } from 'react'
import { Button, Card } from 'animal-island-ui'
import { requestAppInstall, useAppInstall } from '../../ui/appInstall'
import { installHelpFor } from '../../ui/installHelp'
import { navigateManage } from '../../ui/nav'
import { IconDownload } from '../../ui/icons'

export function ManageInstall() {
  const install = useAppInstall()
  const [helpOpen, setHelpOpen] = useState(false)
  const help = installHelpFor(navigator)
  const siteUrl = new URL(import.meta.env.BASE_URL, location.origin).href
  const message = install.installed ? '已安装或正在应用窗口中使用，可从桌面或应用列表打开。'
    : install.installing ? '请在浏览器的安装窗口中确认。'
      : install.message || (install.canPrompt ? '浏览器已准备好，点击下方按钮确认安装。' : '点击安装应用，打开安装窗口或查看当前浏览器的添加方法。')

  async function installApp() {
    if (install.installed || install.installing) return
    if (!install.canPrompt) { setHelpOpen(true); return }
    const result = await requestAppInstall()
    if (result !== 'accepted') setHelpOpen(true)
  }

  return <Card>
    <section className="install-panel" data-testid="pwa-install" data-installed={install.installed ? '1' : '0'}
      data-can-prompt={install.canPrompt ? '1' : '0'} data-installing={install.installing ? '1' : '0'} data-outcome={install.outcome} aria-labelledby="pwa-install-title">
      <div className="install-heading"><span className="install-icon"><IconDownload /></span>
        <div><h3 id="pwa-install-title">安装应用</h3><p>把网格交易台账放到桌面，随时打开</p></div></div>
      <p className="install-status" data-testid="pwa-install-state" role="status" aria-live="polite" aria-atomic="true">{message}</p>
      <div className="install-actions">
        <Button type="primary" data-emphasis="true" data-action="install-app" disabled={install.installed || install.installing}
          aria-controls="pwa-install-help" onClick={() => void installApp()}>
          {install.installed ? '已安装应用' : install.installing ? '正在打开安装窗口…' : '安装应用'}
        </Button>
        <Button size="small" type="text" onClick={() => navigateManage({ section: 'backup' })}>备份台账</Button>
      </div>
      {!install.installed && <details id="pwa-install-help" className="install-help" data-testid="pwa-install-help" data-platform={help.kind}
        open={helpOpen} onToggle={event => setHelpOpen(event.currentTarget.open)}>
        <summary>查看安装方法</summary>
        <h4>{help.title}</h4>
        <ol>{help.steps.map(step => <li key={step}>{step}</li>)}</ol>
        <p>{help.note}</p>
        {!window.isSecureContext && <p>当前地址无法使用直接安装。请在浏览器中使用本网站的正式 HTTPS 地址。</p>}
        <label className="install-address">网站地址<input readOnly value={siteUrl} aria-label="安装网站地址" onFocus={event => event.currentTarget.select()} /></label>
      </details>}
      <p className="install-note">台账保存在本地。更换浏览器或使用部分独立应用时，数据可能不共用；建议先备份，安装后核对，需要时恢复备份。</p>
    </section>
  </Card>
}
