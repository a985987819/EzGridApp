/**
 * 数轴风（V9.24；V9.25.3 视觉升级；V9.31 格子进度条改版）。
 *
 * V9.31（用户 2026-10-25 拍板）：**枝线换成格子进度条**——
 *   每一档 = 一个 7px 小方格，从轴边起往外排；聚合 N 档就多画 N 个格子，
 *   像进度条变长，缩小视图时用「数格子」代替「数刻线」，不再被注记文字压住。
 *   挂单信息（买/卖 价 × 份额）一律排在格子**外侧**，不再压在数据上；
 *   轴对侧的价位 chip 一并去掉（价已写在注记里，少一层文字）。
 *   已成交保持灰色短枝 + 圆点（用户要求「可保持不变」），注记补上「卖出 N 次」（此价位共卖出几次）。
 *   刻度数字改成**骑在轴上**（10px 淡灰，纸色挖穿轴线），两侧因此各留 18px 通道，
 *   格子和数字互不遮挡。
 *
 * 保留全部数据语义：左待买 / 右待卖 / 已成交（含已盈利）、聚合档数（格子数）、
 * 点击跳明细（拾取圆 + 注记热区）、放大自动分散回原档位、昨收紫虚线、理想可卖到琥珀点线。
 */
import {
  labelStep,
  type BranchBin,
  type TreeFrame,
  type TreeStyle,
  type WorkBins,
} from './treeStyle'

/** Apple 系统色：冷白底 / 发丝灰 / 系统蓝(买) / 系统红(卖) / 系统灰(已成交) */
const C = {
  paper: '#fbfcfd',
  paperLo: '#f5f6f9', // 底部微渐变的落点（深度感）
  axis: '#d1d1d6',
  grid: 'rgba(60, 60, 67, 0.05)',
  text: '#1d1d1f',
  sub: '#6e6e73',
  faint: '#8e8e93',
  buy: '#007aff',
  sell: '#ff3b30',
  sold: '#8e8e93',
  /** 理想可卖到（最高待卖目标价）参考线：琥珀色，与昨收的紫色区分（V9.29） */
  ideal: '#ff9500',
}
const UI = '500 11.5px -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif'
const UI_BOLD = '600 11.5px -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif'
const UI_TINY = '500 10px -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif'

/** 格子：5px 见方、1.5px 间隔、最多 8 个（再多靠格子后面的「+N」标出来） */
const CELL = 5
const CELL_GAP = 1.5
const CELL_MAX = 8
/** 「+N」占位宽（排注记前先预留，保证注记不会压到格子） */
const OVER_MARK_W = 14
/** 轴两侧的通道宽度：刻度数字骑在轴上，格子从这里往外起 */
const AXIS_HALF = 16
/** 注记与格子末端的水平间距 */
const NOTE_GAP = 6

/** 两个 6 位 hex 按 t 混色（t=0 取 a，1 取 b）——格子渐变 / 标签底用 */
function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * t))
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** 注记里的份额：上万就折成「x.xx万」，给格子腾宽度（注记要整段塞在格子外侧） */
function qtyText(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(2)}万` : n.toLocaleString('zh-CN')
}

interface NoteSpec {
  side: 1 | -1
  tipX: number
  tipY: number
  bin: BranchBin
  segs: { text: string; color: string; bold?: boolean }[]
}

export const axisStyle: TreeStyle = {
  id: 'axis',
  cardRowPx: 27,
  boils: false,
  outlineRadiusAt: () => 0.02,

  drawFrame(f: TreeFrame, bins: WorkBins) {
    const { ctx, W, H, span, sx, sy, y0, y1 } = f

    // 底：冷白微渐变（上浅下深一丁点，深度感）
    const drawBg = () => {
      const g = ctx.createLinearGradient(0, 0, 0, H)
      g.addColorStop(0, C.paper)
      g.addColorStop(1, C.paperLo)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    }

    // 淡网格：整步一条横贯线（图表骨架，不抢数据）
    const drawGrid = () => {
      const step = labelStep(span, H)
      ctx.strokeStyle = C.grid
      ctx.lineWidth = 1
      let count = 0
      for (let m = Math.ceil((y0 + 0.1) / step); m * step <= y1 - 0.1 && count < 60; m += 1) {
        const py = sy(m * step)
        if (py < -4 || py > H + 4) continue
        ctx.beginPath()
        ctx.moveTo(8, py)
        ctx.lineTo(W - 8, py)
        ctx.stroke()
        count += 1
      }
    }

    // 轴线：两端渐隐的发丝线（刻度数字稍后骑在轴上画，自带纸色挖穿）
    const drawAxis = () => {
      const g = ctx.createLinearGradient(0, 0, 0, H)
      g.addColorStop(0, 'rgba(209, 209, 214, 0)')
      g.addColorStop(0.06, C.axis)
      g.addColorStop(0.94, C.axis)
      g.addColorStop(1, 'rgba(209, 209, 214, 0)')
      ctx.strokeStyle = g
      ctx.lineWidth = 1.25
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(sx(0), sy(y1))
      ctx.lineTo(sx(0), sy(y0))
      ctx.stroke()
    }

    const drawSide = (list: BranchBin[], side: 1 | -1) => {
      const kzLen = span / 8
      const notes: NoteSpec[] = []
      for (const bin of list) {
        if (bin.hi < y0 - 2 || bin.lo > y1 + 2) continue // 视口外不画
        const isSold = bin.kind === 'sold'
        const py = sy(bin.y)
        const color = isSold ? C.sold : bin.kind === 'sell' ? C.sell : C.buy
        const xa = sx(0)
        let tipX: number

        // 注记内容先定下来：格子能画几个要看注记占多宽（窄屏优先保格子，不许文字压数据）
        const segs: { text: string; color: string; bold?: boolean }[] = []
        if (isSold) {
          if (bin.profitCents !== 0) {
            segs.push({ text: '已盈利 ', color: C.sub })
            segs.push({
              text: `${bin.profitCents > 0 ? '+' : '−'}¥${(Math.abs(bin.profitCents) / 100).toLocaleString('zh-CN')}`,
              color: bin.profitCents > 0 ? C.sell : '#34c759',
              bold: true,
            })
          } else {
            segs.push({ text: '已成交 ', color: C.sub })
            segs.push({ text: `×${qtyText(bin.qty)}`, color: C.faint })
          }
          // V9.31 用户要求：这个价位一共卖出几次
          segs.push({ text: ` · 卖出 ${bin.times} 次`, color: C.faint })
        } else {
          segs.push({ text: `${bin.kind === 'sell' ? '卖' : '买'} `, color })
          segs.push({ text: `${(bin.repCents / 100).toFixed(2)}`, color: C.text, bold: true })
          segs.push({ text: ` ×${qtyText(bin.qty)}`, color: C.sub })
        }
        let noteW = 0
        for (const sg of segs) {
          ctx.font = sg.bold ? UI_BOLD : UI
          noteW += ctx.measureText(sg.text).width
        }

        if (isSold) {
          // 已成交：保持原样（灰色短枝 + 白环圆点），长度仍随份额
          const len = Math.min(0.8, 0.4 + Math.sqrt(bin.qty) / 60) * kzLen
          const x1 = xa + side * Math.max(AXIS_HALF, Math.abs(sx(side * len) - xa))
          ctx.strokeStyle = '#c7c7cc'
          ctx.lineWidth = 1.5
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(xa, py)
          ctx.lineTo(x1, py)
          ctx.stroke()
          const nodeR = 3
          ctx.fillStyle = '#ffffff'
          ctx.beginPath()
          ctx.arc(x1, py, nodeR + 1.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = '#c7c7cc'
          ctx.beginPath()
          ctx.arc(x1, py, nodeR, 0, Math.PI * 2)
          ctx.fill()
          tipX = x1
        } else {
          // 待买/待卖：一格 = 一档，聚合就多几格（进度条变长），由内向外逐格变淡。
          // 格子数受画布宽度约束：注记必须整段排在格子外侧，剩下能塞几格就画几格，
          // 塞不下的档数用「+N」紧跟格子后面标出来——绝不拿文字盖住格子。
          const x0 = xa + side * AXIS_HALF
          // 从格子起点到「注记必须整段放下」的边界，能塞几格就画几格（窄屏优先保格子）
          const space =
            side > 0
              ? W - 8 - noteW - NOTE_GAP - OVER_MARK_W - x0
              : x0 - 8 - noteW - NOTE_GAP - OVER_MARK_W
          const room = Math.max(1, Math.floor((space + CELL_GAP) / (CELL + CELL_GAP)))
          const n = Math.max(1, Math.min(bin.count, CELL_MAX, room))
          const over = bin.count - n
          for (let i = 0; i < n; i += 1) {
            const cx = x0 + side * i * (CELL + CELL_GAP)
            const left = side > 0 ? cx : cx - CELL
            ctx.fillStyle = mixHex(color, '#ffffff', n === 1 ? 0 : (0.34 * i) / (n - 1))
            ctx.beginPath()
            ctx.roundRect(left, py - CELL / 2, CELL, CELL, 2)
            ctx.fill()
          }
          tipX = x0 + side * (n * CELL + (n - 1) * CELL_GAP)
          bin.over = over > 0 ? over : 0
        }
        const barLen = Math.abs(tipX - xa)

        // 超出的档数：紧跟格子末尾标「+N」（绝不拿注记盖格子）
        let tail = 0
        if (!isSold && (bin.over ?? 0) > 0) {
          tail = OVER_MARK_W
          ctx.font = UI_TINY
          ctx.textBaseline = 'middle'
          ctx.textAlign = side > 0 ? 'left' : 'right'
          ctx.fillStyle = C.faint
          ctx.fillText(`+${bin.over}`, tipX + side * 2, py + 0.5)
        }

        // 注记：一律排在格子/短枝**外侧**，不再压住数据
        notes.push({ side, tipX: tipX + side * (NOTE_GAP + tail), tipY: py, bin, segs })

        // 拾取圆：盖住整条格子/短枝，格子在缩小时也点得中；点击/投影共用同一圆心
        bin.pick = {
          cx: xa + side * (barLen / 2 + 2),
          cy: py,
          r: Math.max(15, barLen / 2 + 8),
        }
      }
      return notes
    }

    /** 扁平注记：无框文字 + 底色挖穿，同侧纵向避让；被推挤时补细引线指回格子 */
    const drawNotes = (notes: NoteSpec[]) => {
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      for (const side of [-1, 1] as const) {
        const list = notes.filter((n) => n.side === side).sort((a, b) => a.tipY - b.tipY)
        let lastBottom = -Infinity
        for (const n of list) {
          let w = 0
          for (const sg of n.segs) {
            ctx.font = sg.bold ? UI_BOLD : UI
            w += ctx.measureText(sg.text).width
          }
          w = Math.round(w)
          const h = 16
          let cy = n.tipY
          if (cy - h / 2 < lastBottom + 4) cy = lastBottom + 4 + h / 2
          lastBottom = cy + h / 2
          const x = side > 0 ? Math.min(W - w - 4, n.tipX) : Math.max(4, n.tipX - w)
          // 推挤错位明显时补一条细引线，指回所属的格子
          if (Math.abs(cy - n.tipY) > 10) {
            ctx.strokeStyle = 'rgba(142, 142, 147, 0.55)'
            ctx.lineWidth = 0.8
            ctx.beginPath()
            ctx.moveTo(side > 0 ? x - 5 : x + w + 5, cy)
            ctx.lineTo(n.tipX - side * (NOTE_GAP - 2), n.tipY)
            ctx.stroke()
          }
          ctx.fillStyle = C.paper
          ctx.fillRect(x - 4, cy - 9, w + 8, 18)
          // 注记文字热区：点击/投影的第二命中面（拾取圆之外）
          n.bin.note = { x: x - 4, y: cy - 9, w: w + 8, h: 18 }
          let tx = x
          for (const sg of n.segs) {
            ctx.font = sg.bold ? UI_BOLD : UI
            ctx.fillStyle = sg.color
            ctx.fillText(sg.text, tx, cy + 0.5)
            tx += ctx.measureText(sg.text).width
          }
        }
      }
    }

    /** 刻度数字：骑在轴上（10px 淡灰 + 纸色挖穿），两侧通道留给格子 */
    const drawNumbers = () => {
      const step = labelStep(span, H)
      ctx.font = UI_TINY
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let m = Math.ceil((y0 + 0.1) / step); m * step <= y1 - 0.1; m += 1) {
        const y = m * step
        const py = sy(y)
        if (py < -12 || py > H + 12) continue
        const text = step < 1 ? y.toFixed(1) : String(Math.round(y))
        const w = ctx.measureText(text).width
        ctx.fillStyle = C.paper
        ctx.fillRect(sx(0) - w / 2 - 3, py - 7, w + 6, 14)
        ctx.fillStyle = C.faint
        ctx.fillText(text, sx(0), py + 0.5)
      }
    }

    // 昨收参考线（V9.28）：紫色虚线横贯（标签在右端）
    const drawCloseLine = () => {
      if (f.closeCents == null) return
      const y = f.closeCents / 100
      if (y < y0 || y > y1) return
      const py = sy(y)
      ctx.save()
      ctx.setLineDash([5, 4])
      ctx.strokeStyle = '#af52de'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(8, py)
      ctx.lineTo(W - 8, py)
      ctx.stroke()
      ctx.restore()
    }
    const drawCloseLabel = () => {
      if (f.closeCents == null) return
      const y = f.closeCents / 100
      if (y < y0 || y > y1) return
      const py = sy(y)
      ctx.font = UI_TINY
      ctx.textBaseline = 'middle'
      const text = `昨收 ${(f.closeCents / 100).toFixed(2)}`
      const w = ctx.measureText(text).width + 10
      const top = Math.max(8, py - 8)
      ctx.beginPath()
      ctx.roundRect(W - 8 - w, top, w, 16, 8)
      ctx.fillStyle = mixHex(C.paper, '#af52de', 0.12)
      ctx.fill()
      ctx.fillStyle = '#af52de'
      ctx.textAlign = 'center'
      ctx.fillText(text, W - 8 - w / 2, top + 8)
    }

    // 理想可卖到参考线（V9.29）：琥珀点线横贯（标签在左端）
    const drawIdealLine = () => {
      if (f.idealCents == null) return
      const y = f.idealCents / 100
      if (y < y0 || y > y1) return
      const py = sy(y)
      ctx.save()
      ctx.setLineDash([2, 3])
      ctx.strokeStyle = C.ideal
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(8, py)
      ctx.lineTo(W - 8, py)
      ctx.stroke()
      ctx.restore()
    }
    const drawIdealLabel = () => {
      if (f.idealCents == null) return
      const y = f.idealCents / 100
      if (y < y0 || y > y1) return
      const py = sy(y)
      ctx.font = UI_TINY
      ctx.textBaseline = 'middle'
      const text = `理想可卖到 ${(f.idealCents / 100).toFixed(2)}`
      const w = ctx.measureText(text).width + 10
      const top = Math.min(H - 24, Math.max(6, py - 9))
      ctx.beginPath()
      ctx.roundRect(8, top, w, 16, 8)
      ctx.fillStyle = mixHex(C.paper, C.ideal, 0.12)
      ctx.fill()
      ctx.fillStyle = C.ideal
      ctx.textAlign = 'center'
      ctx.fillText(text, 8 + w / 2, top + 8.5)
    }

    drawBg()
    drawGrid()
    drawAxis()
    drawCloseLine()
    drawIdealLine()
    const soldNotes = drawSide(bins.sold, 1)
    const sellNotes = drawSide(bins.sell, 1)
    const buyNotes = drawSide(bins.buy, -1)
    drawNotes([...soldNotes, ...sellNotes, ...buyNotes])
    drawNumbers() // 最后画：骑在轴上，两侧格子不受影响
    drawCloseLabel()
    drawIdealLabel()
  },
}
