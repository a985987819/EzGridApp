// 从用户提供的截图生成桌面图标。运行 node scripts/gen-pwa-icons.mjs，无额外依赖。
import { inflateSync, deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const source = readFileSync(join(root, 'assets/pwa-icon-source.png'))
if (!source.subarray(0, 8).equals(signature)) throw new Error('图标原图必须是 PNG')
const width = source.readUInt32BE(16), height = source.readUInt32BE(20)
const channels = source[25] === 6 ? 4 : source[25] === 2 ? 3 : 0
if (source[24] !== 8 || !channels || source[28] !== 0) throw new Error('原图需为8位 RGB/RGBA、非交错 PNG')
const chunks = []
for (let p = 8; p < source.length;) {
  const length = source.readUInt32BE(p)
  if (source.toString('ascii', p + 4, p + 8) === 'IDAT') chunks.push(source.subarray(p + 8, p + 8 + length))
  p += length + 12
}
const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels
const pixels = Buffer.alloc(width * height * channels)
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)]
  if (filter > 4) throw new Error('未知 PNG filter')
  for (let x = 0; x < stride; x++) {
    const i = y * stride + x
    const a = x >= channels ? pixels[i - channels] : 0, b = y ? pixels[i - stride] : 0
    const c = y && x >= channels ? pixels[i - stride - channels] : 0
    pixels[i] = (raw[y * (stride + 1) + 1 + x] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]) & 255
  }
}
function crc32(bytes) {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4)
  head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}
function draw(size, scale = 1, opaque = false) {
  const rgba = Buffer.alloc(size * size * 4), edge = Math.max(width, height)
  const factor = size * scale / edge, left = (size - width * factor) / 2, top = (size - height * factor) / 2
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4
    let color = [242, 245, 248, 0]
    if (x >= left && y >= top && x < size - left && y < size - top) {
      const sx = Math.max(0, Math.min(width - 1, (x + 0.5 - left) / factor - 0.5))
      const sy = Math.max(0, Math.min(height - 1, (y + 0.5 - top) / factor - 0.5))
      const x0 = Math.floor(sx), y0 = Math.floor(sy), dx = sx - x0, dy = sy - y0
      const samples = [[x0, y0, (1 - dx) * (1 - dy)], [Math.min(x0 + 1, width - 1), y0, dx * (1 - dy)],
        [x0, Math.min(y0 + 1, height - 1), (1 - dx) * dy], [Math.min(x0 + 1, width - 1), Math.min(y0 + 1, height - 1), dx * dy]]
      // 预乘 alpha 插值，透明边缘不产生黑边。
      const alpha = samples.reduce((s, [px, py, w]) => s + (channels === 4 ? pixels[(py * width + px) * channels + 3] / 255 : 1) * w, 0)
      color = [0, 1, 2].map(c => alpha ? samples.reduce((s, [px, py, w]) => {
        const j = (py * width + px) * channels
        return s + pixels[j + c] * (channels === 4 ? pixels[j + 3] / 255 : 1) * w
      }, 0) / alpha : 0)
      color.push(alpha * 255)
    }
    const alpha = color[3] / 255
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(opaque ? color[c] * alpha + [242, 245, 248][c] * (1 - alpha) : color[c])
    rgba[i + 3] = opaque ? 255 : Math.round(color[3])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  const lines = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(lines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(lines, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
for (const [name, size, scale, opaque] of [
  ['pwa-192.png', 192, 1, false], ['pwa-512.png', 512, 1, false],
  ['pwa-maskable-512.png', 512, 0.70, true], ['apple-touch-icon.png', 180, 1, true], ['favicon.png', 32, 1, false],
]) {
  writeFileSync(join(root, 'public', name), draw(size, scale, opaque))
  console.log(`public/${name} (${size}×${size})`)
}
