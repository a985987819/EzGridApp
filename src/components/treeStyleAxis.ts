/**
 * 数轴风（V9.24；V9.25.3 视觉升级）：抛弃「树」的意象，Apple 简约数轴。
 *   保留全部数据语义：左待买 / 右待卖 / 已成交（含已盈利）、聚合档数、
 *   枝长与端点大小表份额、点击跳明细（拾取圆 + 注记热区）、
 *   放大自动分散回原档位、轴对侧小字标线代表价位。
 *
 * V9.25.3 丰满化（仍极简）：
 *   底 = 冷白微渐变 + 整步横向淡网格线（图表骨架）；轴 = 发丝线两端渐隐；
 *   枝 = 端到端渐变（accent → 亮 35%）2.5px，端点实心圆 + 白色光环 + 软投影
 *   （地图 Pin 的层次感）；已成交 = 淡灰实心点 + 白环；
 *   轴对侧小字 = 同色系浅底圆角 chip（现代徽章，兼做线条挖穿）。
 *
 * V9.26.2：聚合档数 = 枝上垂直刻线（一道 = 一档，封顶 8 道，取代「·N档」文字）；
 *   hover 预览已按用户要求移除（点击跳转保留）。
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
  tick: '#b6b6bd',
  grid: 'rgba(60, 60, 67, 0.05)',
  text: '#1d1d1f',
  sub: '#6e6e73',
  faint: '#8e8e93',
  buy: '#007aff',
  sell: '#ff3b30',
  sold: '#8e8e93',
}
const UI = '500 11.5px -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif'
const UI_BOLD = '600 11.5px -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif'
const UI_TINY = '500 10px -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif'

/** 两个 6 位 hex 按 t 混色（t=0 取 a，1 取 b）——渐变枝 / chip 底 / 高亮色带用 */
function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * t))
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`
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

    // 每根线的轴对侧小字数值（V9.25）：买线（左）→ 轴右侧标价；卖/已成交线（右）→ 轴左侧标价。
    // 左侧小字与轴刻度数字同区，收集起来给 drawNumbers 避让。
    const marks: { py: number; side: 1 | -1; text: string; color: string }[] = []

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

    // hover 整行色带：已随 hover 预览一并移除（V9.26.2 用户拍板）

    // 轴线（两端渐隐）+ 短刻度（整步 8px / 半步 4px，数字最后另画）
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
      const step = labelStep(span, H)
      const half = step / 2
      ctx.lineWidth = 1
      let count = 0
      for (let m = Math.ceil((y0 + half * 0.01) / half); m * half <= y1 && count < 400; m += 1) {
        const y = m * half
        const major = Math.abs(y / step - Math.round(y / step)) < 1e-6
        const py = sy(y)
        if (py < -4 || py > H + 4) continue
        ctx.strokeStyle = major ? C.tick : C.axis
        ctx.beginPath()
        ctx.moveTo(sx(0), py)
        ctx.lineTo(sx(0) - (major ? 8 : 4), py)
        ctx.stroke()
        count += 1
      }
    }

    const drawSide = (list: BranchBin[], side: 1 | -1) => {
      const kzLen = span / 8
      const notes: NoteSpec[] = []
      for (const bin of list) {
        if (bin.hi < y0 - 2 || bin.lo > y1 + 2) continue // 视口外不画
        const isSold = bin.kind === 'sold'
        const py = sy(bin.y)
        const len = isSold
          ? Math.min(0.8, 0.4 + Math.sqrt(bin.qty) / 60) * kzLen
          : Math.min(1.5, 0.5 + Math.sqrt(bin.qty) / 38) * kzLen
        const x0 = sx(0)
        const x1 = sx(side * len)
        const color = isSold ? C.sold : bin.kind === 'sell' ? C.sell : C.buy
        // 平直短枝：accent → 亮 35% 的端到端渐变（已成交用淡灰扁线）
        if (isSold) {
          ctx.strokeStyle = '#c7c7cc'
          ctx.lineWidth = 1.5
        } else {
          const g = ctx.createLinearGradient(x0, 0, x1, 0)
          g.addColorStop(0, color)
          g.addColorStop(1, mixHex(color, '#ffffff', 0.35))
          ctx.strokeStyle = g
          ctx.lineWidth = 2.5
        }
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(x0, py)
        ctx.lineTo(x1, py)
        ctx.stroke()
        // 聚合档数 = 垂直刻线（V9.26.2）：一道 = 一档（封顶 8 道排在枝外侧半段），
        // 取代「·N档」文字——数量即密度，一眼可读
        if (!isSold && bin.count > 1) {
          const ticks = Math.min(bin.count, 8)
          const ta = x0 + (x1 - x0) * 0.42
          const tb = x0 + (x1 - x0) * 0.92
          ctx.strokeStyle = color
          ctx.lineWidth = 1.5
          for (let i = 0; i < ticks; i += 1) {
            const tx = ticks === 1 ? (ta + tb) / 2 : ta + ((tb - ta) * i) / (ticks - 1)
            ctx.beginPath()
            ctx.moveTo(tx, py - 4.5)
            ctx.lineTo(tx, py + 4.5)
            ctx.stroke()
          }
        }
        // 端点：实心圆 + 白色光环 + 软投影（地图 Pin 的层次）；已成交 = 淡灰实心 + 白环
        const nodeR = isSold ? 3 : Math.max(3, Math.min(5.5, 3 + Math.sqrt(bin.qty) * 0.017))
        if (isSold) {
          ctx.fillStyle = '#ffffff'
          ctx.beginPath()
          ctx.arc(x1, py, nodeR + 1.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = '#c7c7cc'
          ctx.beginPath()
          ctx.arc(x1, py, nodeR, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.save()
          ctx.shadowColor = `${color}4d`
          ctx.shadowBlur = 6
          ctx.shadowOffsetY = 1
          ctx.fillStyle = '#ffffff'
          ctx.beginPath()
          ctx.arc(x1, py, nodeR + 1.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(x1, py, nodeR, 0, Math.PI * 2)
          ctx.fill()
        }

        // 扁平注记：前缀彩色 / 价格加粗深灰 / 份额浅灰；聚合档数 = 尾部「·N档」
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
            segs.push({ text: `×${bin.qty.toLocaleString('zh-CN')}`, color: C.faint })
          }
        } else {
          segs.push({ text: `${bin.kind === 'sell' ? '卖' : '买'} `, color })
          segs.push({ text: `${(bin.repCents / 100).toFixed(2)}`, color: C.text, bold: true })
          segs.push({ text: ` ×${bin.qty.toLocaleString('zh-CN')}`, color: C.sub })
        }
        notes.push({ side, tipX: x1, tipY: py, bin, segs })
        // 轴对侧小字：这根线代表的具体价位（聚合组 = 代表档）
        marks.push({
          py,
          side: side === 1 ? -1 : 1,
          text: (bin.repCents / 100).toFixed(2),
          color,
        })

        // 拾取圆：贴枝中段偏端点，杆细也点得中；点击/投影共用同一圆心
        bin.pick = {
          cx: x0 + (x1 - x0) * 0.6,
          cy: py,
          r: Math.max(15, nodeR + 9),
        }
      }
      return notes
    }

    /** 扁平注记：无框文字 + 底色挖穿（枝线不穿字），同侧纵向避让 */
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
          const x = side > 0 ? Math.min(W - w - 4, n.tipX + 8) : Math.max(4, n.tipX - 8 - w)
          // 推挤错位明显时补一条细引线，指回所属的枝
          if (Math.abs(cy - n.tipY) > 10) {
            ctx.strokeStyle = 'rgba(142, 142, 147, 0.6)'
            ctx.lineWidth = 0.8
            ctx.beginPath()
            ctx.moveTo(side > 0 ? x - 5 : x + w + 5, cy)
            ctx.lineTo(n.tipX, n.tipY)
            ctx.stroke()
          }
          ctx.fillStyle = C.paper
          ctx.fillRect(x - 4, cy - 9, w + 8, 18)
          // 注记文字热区：hover/点击的扩靶（拾取圆之外的第二个命中面）
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

    /** 价签数字：轴左、右对齐；底色挖穿（买侧枝从数字下方穿过）；与轴对侧左侧 chip 互相避让 */
    const drawNumbers = () => {
      const step = labelStep(span, H)
      const leftMarkPys = marks.filter((m) => m.side === -1).map((m) => m.py)
      ctx.font = UI
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (let m = Math.ceil((y0 + 0.1) / step); m * step <= y1 - 0.1; m += 1) {
        const y = m * step
        const py = sy(y)
        if (py < -12 || py > H + 12) continue
        if (leftMarkPys.some((mp) => Math.abs(mp - py) < 9)) continue // 附近有精确价 chip，刻度数字让位
        const text = step < 1 ? y.toFixed(1) : String(Math.round(y))
        const w = ctx.measureText(text).width
        ctx.fillStyle = C.paper
        ctx.fillRect(sx(0) - 12 - w - 4, py - 8, w + 6, 16)
        ctx.fillStyle = C.sub
        ctx.fillText(text, sx(0) - 12, py + 0.5)
      }
    }

    /** 轴对侧小字：同色系浅底圆角 chip（现代徽章，兼做线条挖穿）；同侧纵向避让 */
    const drawMarks = () => {
      ctx.font = UI_TINY
      ctx.textBaseline = 'middle'
      for (const side of [-1, 1] as const) {
        const list = marks.filter((m) => m.side === side).sort((a, b) => a.py - b.py)
        let lastBottom = -Infinity
        for (const m of list) {
          let cy = m.py
          if (cy - 8 < lastBottom + 2) cy = lastBottom + 2 + 8
          lastBottom = cy + 8
          const w = ctx.measureText(m.text).width + 10
          const x = side > 0 ? sx(0) + 7 : sx(0) - 7 - w
          ctx.beginPath()
          ctx.roundRect(x, cy - 8, w, 16, 8)
          ctx.fillStyle = mixHex(C.paper, m.color, 0.09)
          ctx.fill()
          ctx.fillStyle = m.color
          ctx.textAlign = 'center'
          ctx.fillText(m.text, x + w / 2, cy + 0.5)
        }
      }
    }

    drawBg()
    drawGrid()
    drawAxis()
    const soldNotes = drawSide(bins.sold, 1)
    const sellNotes = drawSide(bins.sell, 1)
    const buyNotes = drawSide(bins.buy, -1)
    drawNotes([...soldNotes, ...sellNotes, ...buyNotes])
    drawNumbers()
    drawMarks()
  },
}
