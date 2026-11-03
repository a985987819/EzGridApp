/**
 * 字体语料子集化：把库内 1.1MB 级的 Noto Sans SC 中文整字体（400/700）裁成
 * 「应用实际用到的字」的子集，产物入库（同 valuationData 快照哲学——构建零依赖、
 * 产物稳定）。运行 npm run subset-fonts 重新生成。
 *
 * 语料 = src/**\/*.{ts,tsx,css} + docs/*.md + index.html 里出现的全部字符
 * （UI 文案、全部操作指南正文、日期数字等）+ 可打印 ASCII 兜底。
 * 语料之外的字（用户新输入的生僻字）由字体栈后面的系统字体兜底渲染
 * （--animal-font-family: Nunito, "Noto Sans SC", PingFang SC / 微软雅黑…），
 * 另有管理页「使用系统字体」开关可整体切走。
 *
 * 什么时候要重跑：新增/修改了含新汉字的文案或文档之后（忘了也不致命——
 * 新字回退系统字体，只是那一两个字符观感不同）。
 */
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'src', 'assets', 'fonts')
// 库内原字体的内容 hash 后缀（升级库后如果这里 404，重跑 ls dist/files 对一下）
const SOURCE = (weight) =>
  join(ROOT, 'node_modules', 'animal-island-ui', 'dist', 'files',
    `noto-sans-sc-chinese-simplified-${weight}-normal.${{ 400: 'e25467c8', 700: '6e0a7691' }[weight]}.woff2`)

function* walk(dir, exts) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p, exts)
    else if (exts.has(extname(p))) yield p
  }
}

const corpus = new Set()
// 可打印 ASCII 全量兜底（数字/字母/符号最便宜）
for (let c = 0x20; c <= 0x7e; c++) corpus.add(String.fromCharCode(c))
// 全角空格与常用中文标点（语料里未必集齐）
for (const ch of '　，。、；：？！「」『』（）《》〈〉【】…—·～￥％＋－×÷°℃㎡「」‘’“”') corpus.add(ch)

const files = [
  ...walk(join(ROOT, 'src'), new Set(['.ts', '.tsx', '.css'])),
  ...walk(join(ROOT, 'docs'), new Set(['.md'])),
  join(ROOT, 'index.html'),
]
let sourceBytes = 0
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  sourceBytes += text.length
  for (const ch of text) {
    const code = ch.codePointAt(0)
    // 只收非控制字符；字体文件里出现源码字符也没关系（子集按码点去重）
    if (code >= 0x20 && code !== 0x7f) corpus.add(ch)
  }
}
const text = [...corpus].join('')
console.log(`语料：${files.length} 个文件 / ${sourceBytes} 字符 → 去重 ${corpus.size} 个字符`)

mkdirSync(OUT_DIR, { recursive: true })
for (const weight of [400, 700]) {
  const original = readFileSync(SOURCE(weight))
  const subset = await subsetFont(original, text, { targetFormat: 'woff2' })
  const out = join(OUT_DIR, `noto-sans-sc-${weight}-subset.woff2`)
  writeFileSync(out, subset)
  const kb = (n) => `${(n / 1024).toFixed(0)}KB`
  console.log(`  ${weight} 字重：${kb(original.length)} → ${kb(subset.length)}（−${Math.round((1 - subset.length / original.length) * 100)}%）→ ${out}`)
}
