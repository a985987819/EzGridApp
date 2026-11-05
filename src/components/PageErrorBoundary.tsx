import { Component, type ReactNode } from 'react'
import { Button } from 'animal-island-ui'

interface Props {
  children: ReactNode
  resetKey: string
  onRetry: () => void
  onBackup: () => Promise<void>
}

interface State {
  failed: boolean
  resetKey: string
  backingUp: boolean
  backupMessage: string
}

/** Keep navigation and a direct backup path available when a page cannot render. */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey, backingUp: false, backupMessage: '' }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : {
      failed: false, resetKey: props.resetKey, backingUp: false, backupMessage: '',
    }
  }

  private backup = async () => {
    if (this.state.backingUp) return
    const resetKey = this.props.resetKey
    this.setState({ backingUp: true, backupMessage: '' })
    try {
      await this.props.onBackup()
      if (resetKey === this.props.resetKey) this.setState({ backupMessage: '备份文件已生成，请核对浏览器下载记录。' })
    } catch {
      if (resetKey === this.props.resetKey) this.setState({ backupMessage: '备份未完成。请重试，或到管理 → 备份查看。' })
    } finally {
      if (resetKey === this.props.resetKey) this.setState({ backingUp: false })
    }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <section className="empty-box" data-testid="page-error" role="alert" aria-labelledby="page-error-title" style={{ color: 'var(--animal-text-color, #594b3d)' }}>
      <div className="stack" style={{ maxWidth: 480, margin: '0 auto', textAlign: 'left' }}>
        <h1 id="page-error-title" style={{ margin: 0, fontSize: 20 }}>页面暂时无法打开</h1>
        <p style={{ margin: 0 }}>请检查网络后重试。若刚更新过应用，可到「版本与更新」核对当前版本。已保存的台账仍保留在本机。</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Button type="primary" data-action="retry-page" onClick={this.props.onRetry}>重试当前页面</Button>
          <Button loading={this.state.backingUp} data-action="error-backup" onClick={() => void this.backup()}>备份台账</Button>
        </div>
        {this.state.backupMessage && <p role="status" style={{ margin: 0 }}>{this.state.backupMessage}</p>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
          <a href="#/manage?section=updates">版本与更新</a>
          <a href="#/manage">返回管理</a>
        </div>
      </div>
    </section>
  }
}
