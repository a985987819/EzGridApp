import { useEffect } from 'react'
import { Button, Card } from 'animal-island-ui'
import { CURRENT_RELEASE, checkLatestVersion, updateToLatest, useAppUpdate } from '../../ui/appUpdate'
import { releaseLabel } from '../../ui/release'
import { navigateManage } from '../../ui/nav'
import { IconRefresh } from '../../ui/icons'

const when = (value: number | string | null) => value === null ? '尚未检查' : new Date(value).toLocaleString('zh-CN', { hour12: false })

export function ManageUpdates({ compact = false }: { compact?: boolean }) {
  const update = useAppUpdate()
  const busy = update.phase === 'checking' || update.phase === 'updating'
  const development = update.phase === 'development'
  const current = update.verified && update.latest?.buildId === CURRENT_RELEASE.buildId
  const available = update.verified && update.latest?.buildId !== CURRENT_RELEASE.buildId
  useEffect(() => {
    if (!import.meta.env.DEV) void checkLatestVersion()
  }, [])
  const status = development ? '本地开发版' : update.phase === 'checking' ? '正在检查' : update.phase === 'updating' ? '正在更新' : current ? '已是最新版本' : available ? '有新版可用' : '尚未确认最新'
  return <Card>
    <div className={`release-panel${compact ? ' is-compact' : ''}`} data-testid="app-updates" data-build-id={CURRENT_RELEASE.buildId} data-phase={update.phase}>
      <div className="release-heading"><span className="release-icon"><IconRefresh /></span><strong>版本与更新</strong><span className={`release-status ${current ? 'is-current' : available ? 'is-available' : ''}`} role="status">{status}</span></div>
      {update.result && <p className={`release-result${update.result === 'mismatch' ? ' is-error' : ''}`} data-testid="update-result" role="status">
        {update.result === 'updated' ? '更新成功，已核对当前运行版本。' : update.result === 'refreshed' ? '刷新完成，运行版本已校验。' : '本次尚未切换到目标版本，请重新检查并强制更新。'}
      </p>}
      <div className="release-compare">
        <div><span className="release-label">当前运行版本</span><strong data-testid="current-version" title={releaseLabel(CURRENT_RELEASE)}><span>{CURRENT_RELEASE.version}</span><code>{CURRENT_RELEASE.buildId.slice(0, 8)}</code></strong>{!compact && <small>构建于 {when(CURRENT_RELEASE.builtAt)}</small>}</div>
        <div><span className="release-label">{update.verified ? '线上最新版本' : '上次查到的版本'}</span><strong data-testid="latest-version">{update.latest ? <><span>{update.latest.version}</span><code>{update.latest.buildId.slice(0, 8)}</code></> : '等待联网检查'}</strong>{!compact && update.latest && <small>构建于 {when(update.latest.builtAt)}</small>}</div>
      </div>
      <p className="release-message" aria-live="polite">{development ? '开发环境即时更新；正式发布后可检查线上版本。' : update.message || '联网检查后才能确认是否最新。'}{update.pending && !current && !busy ? ' 新版资源已就绪，等待手动启用。' : ''}</p>
      <p className="release-checked">{update.checkedAt ? `${update.verified ? '本次检查' : '上次成功检查'}：${when(update.checkedAt)}` : '尚无成功检查记录'}</p>
      {compact && <p className="release-note">刷新前先保存编辑内容。已保存台账保留，未保存表单和沙盒会清空。</p>}
      <div className="release-actions">
        <Button disabled={busy || development} onClick={() => void checkLatestVersion()} data-action="check-version">{update.phase === 'checking' ? '检查中…' : '检查最新版本'}</Button>
        <Button type="primary" disabled={busy || development} onClick={() => void updateToLatest()} data-action="apply-update">{update.phase === 'updating' ? '正在准备更新…' : available ? '更新并刷新' : '刷新并校验'}</Button>
      </div>
      {compact ? <button className="release-details" onClick={() => navigateManage({ section: 'updates' })}>查看版本详情与强制更新 →</button> : <>
        <p className="release-note">请先保存正在编辑的内容。更新会刷新本页，已保存台账保留；尚未保存的表单与沙盒会清空。其他打开的页面由你自行刷新。</p>
        <Button block disabled={busy || development} data-action="force-update" onClick={() => void updateToLatest(true)}>强制更新到最新版本</Button>
        <p className="release-note">强制更新会重新从线上核对版本、启用对应资源，并在刷新后验证结果。离线或发布尚未完成时会明确提示，不会显示更新成功。</p>
        <details className="release-technical"><summary>构建详情</summary><dl>
          <dt>当前构建号</dt><dd>{CURRENT_RELEASE.buildId}</dd><dt>代码提交</dt><dd>{CURRENT_RELEASE.commit}</dd><dt>部署路径</dt><dd>{CURRENT_RELEASE.base}</dd>
        </dl><p>版本按发布内容生成的固定构建号比较，每次检查都绕过浏览器缓存。构建时间仅供查看。</p></details>
      </>}
    </div>
  </Card>
}
