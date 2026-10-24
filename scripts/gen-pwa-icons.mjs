// 生成 PWA 图标（192/512 + 掩蔽安全边距）：纯 Node 手写 PNG（zlib 存储，无依赖）
// 画面：米色圆角底 · 棕色树干 · 左蓝右红两根枝 · 绿色叶点 —— 呼应概览价格树
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n += 1) {
    c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 场景绘制：全部用「点到形状的距离」算，任意分辨率一致 */
function draw(size) {
  const px = Buffer.alloc(size * size * 4)
  const S = size / 512 // 归一化到 512 设计稿
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    const na = a / 255
    px[i] = Math.round(px[i] * (1 - na) + r * na)
    px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na)
    px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na)
    px[i + 3] = Math.max(px[i + 3], Math.round(a))
  }
  // 圆角矩形底（圆角 96，留 12px 透明边；maskable 直接铺满也安全）
  const R = 96 * S
  const inset = 12 * S
  const inRounded = (x, y) => {
    const x0 = inset
    const y0 = inset
    const x1 = size - inset
    const y1 = size - inset
    if (x < x0 || y < y0 || x > x1 || y > y1) return false
    const cx = Math.max(x0 + R, Math.min(x, x1 - R))
    const cy = Math.max(y0 + R, Math.min(y, y1 - R))
    return Math.hypot(x - cx, y - cy) <= R || (x >= x0 + R && x <= x1 - R) || (y >= y0 + R && y <= y1 - R)
  }
  // 粗树干（中轴稍偏左让右侧枝透气）
  const trunkX = 236 * S
  const trunkW = 62 * S
  // 枝：从干上某高度向斜上伸出（蓝左红右）
  const branch = (bx0, by0, dir, len, w, color) => {
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const t = ((x - bx0) * dir + (y - by0) * -0.55) / (dir * dir + 0.3025)
        if (t < 0 || t > len) continue
        const d = Math.abs((x - bx0) * -0.55 - (y - by0) * dir) / Math.sqrt(dir * dir + 0.3025)
        if (d <= w * (1 - (0.35 * t) / len) + 0.7) set(x, y, color[0], color[1], color[2])
      }
  }
  const leaves = [
    [150, 190, 26],
    [186, 168, 20],
    [352, 176, 26],
    [388, 202, 20],
    [210, 150, 17],
    [330, 146, 17],
  ]
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      if (inRounded(x, y)) set(x, y, 246, 239, 220) // 纸色
      if (Math.abs(x - trunkX) <= trunkW / 2 && y > 210 * S && y < 452 * S) {
        const taper = trunkW / 2 * (1 - ((y - 210 * S) / (242 * S)) * 0.3)
        if (Math.abs(x - trunkX) <= taper) set(x, y, 117, 73, 44) // 树干
      }
      // 根部张开的小三角
      if (y >= 430 * S && y < 452 * S) {
        const spread = ((y - 430 * S) / (22 * S)) * 26 * S
        if (Math.abs(x - trunkX) <= trunkW / 2 + spread) set(x, y, 117, 73, 44)
      }
    }
  branch(trunkX - trunkW / 2, 306 * S, -1, 150 * S, 20 * S, [74, 124, 196]) // 左蓝（待买）
  branch(trunkX + trunkW / 2, 292 * S, 1, 165 * S, 20 * S, [192, 79, 72]) // 右红（待卖）
  for (const [lx, ly, lr] of leaves)
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1)
        if (Math.hypot(x - lx * S, y - ly * S) <= lr * S) set(x, y, 95, 154, 74)
  return px
}

mkdirSync(join(root, 'public'), { recursive: true })
for (const size of [192, 512]) {
  writeFileSync(join(root, `public/pwa-${size}.png`), encodePng(size, draw(size)))
  console.log(`public/pwa-${size}.png 写好了`)
}
