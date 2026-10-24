/**
 * 3D 价格树（V9.6→V9.9）：概览页的纵轴是一棵手绘插画风立体树。
 *
 * 渲染 = 两遍管线（风格化与场景内容解耦，任意模型/相机运动都有一致手绘感）：
 *   pass 1  数据缓冲：所有网格用同一个 GBufferMaterial 输出
 *           RGBA 半浮点 (r=半球明暗 shade, gba=墨色) + FloatType 深度纹理，
 *           无任何风格化；RT 用 NearestFilter、无 mipmap。
 *   pass 2  全屏后处理（独立 scene + 正交相机）逐像素作画：
 *           ① 手抖采样（值噪声偏移，颜色/深度同一偏移防轮廓错位）
 *           ② 轮廓 = 逆深度 Laplacian + 法线突变补边
 *           ③ 阴影线 = 深度重建世界坐标/法线，条纹钉在表面上；三方向排线
 *           ④ 纸面 = 双层值噪声纸纹 + 淡蓝横线
 *           ⑤ 合成 paper → mix(墨色, hatch*0.72) → mix(轮廓墨*0.92, edge*ew)
 *
 * V9.9 数据表现：
 *   待买/待卖 = 树枝（左蓝 / 右红，长度随数量）；已卖出 = 落叶，铺在树干
 *   后方更远的深度层（近处枝、远处叶，天然分层）。缩小（拉远）时相邻档的
 *   枝按间距合并成一根，枝上画「合并档数」片叶子表达该区间挂单密度；
 *   放大到档位可分辨时恢复每档一枝。
 *
 * 性能：按需渲染——场景无逐帧动画，只有交互/改尺寸时置脏重绘一帧；
 *   枝叶布局只在合并档位（gap 档）变化时重排，矩阵全部复用临时对象。
 *
 * V9.12 轴刻度与下限：
 *   价签步长按「最小屏幕间距」从 1-2-5 档里取——任何缩放级别下相邻数字
 *   至少隔 LABEL_MIN_GAP 像素，数据是 8~12 每毛一档也不会挤；轴全程线性
 *   等比例，数据稀疏就空着，不压缩。视野下沿压在 0：股价永远为正，
 *   到 0 就不能再往下拉。
 *
 * 交互：滚轮 / 双指捏合缩放、拖动攀爬（内容跟随手指，和地图/列表同向）、
 *   点枝跳明细；价格标签为 HTML 覆盖层。three.js 动态导入，主包不背 3D 引擎。
 */
import { useEffect, useMemo, useRef } from 'react'
import { useApp } from '../store/useApp'
import type { SellTarget } from '../domain/types'

export interface TreeLevel {
  priceCents: number
  buyQty: number
  sellQty: number
  soldQty: number
  soldCount: number
}

const TRUNK_MIN = -20
const TRUNK_MAX = 300
const CAM_MAX = 288
const SPAN_MIN = 0.5
const SPAN_MAX = 150
/** 相邻两枝最少要占的屏幕行数（按 460px 高估）：行距不足就合并 */
const ROWS_PER_SCREEN = 22
/** 已完成落叶的实例上限（超出按比例抽样） */
const FALLEN_CAP = 480
/** 价签最小屏幕间距（px）：任何缩放下相邻两个数字至少隔这么远 */
const LABEL_MIN_GAP = 80
/** 价签步长档位（1-2-5 序列；0.1 档对应 A 股最小报价单位） */
const LABEL_LADDER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]

/** 墨色盘：每个物体一种墨（pass1 写进 gba，pass2 取出排线/填色/勾边） */
const INK = {
  trunk: '#75492c',
  buy: '#4a7cc4',
  sell: '#c04f48',
  fallen: '#c39a4e',
  moss: '#7f9455',
  ring: '#a08056',
  ground: '#e9e6c8',
  cloud: '#fdfbf2',
  mountain: '#d9dcc0',
}

function aggregate(
  stockName: string,
  sells: { stockName: string; priceCents: number | null; qty: number }[],
  targets: SellTarget[],
  orders: { stockName: string; rebuyPriceCents: number; remainingQty: number }[],
): TreeLevel[] {
  const map = new Map<number, TreeLevel>()
  const get = (p: number) => {
    let l = map.get(p)
    if (!l) {
      l = { priceCents: p, buyQty: 0, sellQty: 0, soldQty: 0, soldCount: 0 }
      map.set(p, l)
    }
    return l
  }
  for (const o of orders) {
    if (o.stockName !== stockName || o.remainingQty <= 0) continue
    get(o.rebuyPriceCents).buyQty += o.remainingQty
  }
  for (const t of targets) {
    if (t.stockName !== stockName) continue
    get(t.priceCents).sellQty += t.qty
  }
  for (const s of sells) {
    if (s.stockName !== stockName || s.priceCents === null) continue
    const l = get(s.priceCents)
    l.soldQty += s.qty
    l.soldCount += 1
  }
  return [...map.values()].sort((a, b) => a.priceCents - b.priceCents)
}

/** 价格 → 树干半径（上细下粗，与树干几何体 0.55→0.36 的锥度一致） */
function trunkRadiusAt(y: number): number {
  const t = Math.min(1, Math.max(0, (y - TRUNK_MIN) / (TRUNK_MAX - TRUNK_MIN)))
  return 0.55 - 0.19 * t
}

/** 价格 → 树干外表面半径（树轮 / 青苔 / 枝叶的锚点） */
function outlineRadiusAt(y: number): number {
  return trunkRadiusAt(y) + 0.03
}

// ---------------- shader 源码 ----------------

const GBUFFER_VERT = /* glsl */ `
out vec3 vN;
void main() {
  vec3 n = normal;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  #ifdef USE_INSTANCING
    wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    n = mat3(instanceMatrix) * normal;
  #endif
  vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const GBUFFER_FRAG = /* glsl */ `
precision highp float;
in vec3 vN;
uniform vec3 uInk;
uniform float uFill; // 1 = 纯色填充（云 / 山 / 地面），pass2 整片涂纯色
out vec4 outColor;
void main() {
  float shade = dot(normalize(vN), normalize(vec3(0.45, 0.8, 0.55))) * 0.5 + 0.5;
  if (uFill > 0.5) shade = -1.0;
  outColor = vec4(shade, uInk);
}
`

const POST_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const POST_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
uniform mat4 uInvProj;
uniform mat4 uInvView;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u2 = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
/** 窗口深度 → 线性距离 */
float linDepth(vec2 uv) {
  float d = texture(tDepth, uv).x;
  float viewZ = (uNear * uFar) / ((uFar - uNear) * d - uFar);
  return -viewZ;
}
vec3 viewPosAt(vec2 uv, float depth01) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth01 * 2.0 - 1.0, 1.0);
  vec4 vp = uInvProj * clip;
  return vp.xyz / vp.w;
}
/** 排线：p 为表面锚定坐标，dir 条纹方向 */
float stripes(vec2 p, vec2 dir, float spacing, float width) {
  float t = dot(p, vec2(-dir.y, dir.x));
  float f = abs(fract(t / spacing) - 0.5) * spacing;
  float soft = width * 0.6;
  return 1.0 - smoothstep(width * 0.5 - soft, width * 0.5 + soft, f);
}

void main() {
  vec2 px = 1.0 / uRes;
  // ① 手抖采样：整幅笔触同步微抖；颜色与深度用同一偏移（错位会轮廓错边）
  vec2 wob = (vec2(vnoise(vUv * uRes.y * 0.09 + 3.1), vnoise(vUv * uRes.y * 0.09 + 7.7)) - 0.5)
    * 2.0 * 1.4 * px;
  vec2 suv = vUv + wob;
  float o = 1.6;

  vec4 g = texture(tColor, suv);
  float shade = g.r;
  vec3 ink = g.gba;
  float dz = linDepth(suv);
  bool isBg = dz >= uFar * 0.995;

  // ② 轮廓：逆深度 Laplacian（平面内二阶差分恒 0 → 只在真实不连续处响应）
  float zl = linDepth(suv - vec2(o * px.x, 0.0));
  float zr = linDepth(suv + vec2(o * px.x, 0.0));
  float zu = linDepth(suv + vec2(0.0, o * px.y));
  float zd = linDepth(suv - vec2(0.0, o * px.y));
  float iw = 1.0 / max(dz, 1e-4);
  float lap = abs(1.0 / max(zl, 1e-4) + 1.0 / max(zr, 1e-4) - 2.0 * iw)
    + abs(1.0 / max(zu, 1e-4) + 1.0 / max(zd, 1e-4) - 2.0 * iw);
  float edge = smoothstep(0.07, 0.30, lap / (iw + 1e-7));

  // 由深度重建视空间坐标 → 面法线（导数），法线突变补一条贴面物体的轮廓
  vec3 vp = viewPosAt(suv, texture(tDepth, suv).x);
  vec3 vpL = viewPosAt(suv - vec2(o * px.x, 0.0), texture(tDepth, suv - vec2(o * px.x, 0.0)).x);
  vec3 vpU = viewPosAt(suv + vec2(0.0, o * px.y), texture(tDepth, suv + vec2(0.0, o * px.y)).x);
  vec3 nV = normalize(cross(dFdx(vp), dFdy(vp)));
  vec3 nL = normalize(cross(dFdx(vpL), dFdy(vpL)));
  vec3 nU = normalize(cross(dFdx(vpU), dFdy(vpU)));
  float nEdge = max(length(nV - nL), length(nV - nU));
  edge = max(edge, smoothstep(0.55, 0.85, nEdge));

  // 轮廓墨色取最近深度物体的墨
  vec4 gL = texture(tColor, suv - vec2(o * px.x, 0.0));
  vec4 gR = texture(tColor, suv + vec2(o * px.x, 0.0));
  vec4 gU = texture(tColor, suv + vec2(0.0, o * px.y));
  vec4 gD = texture(tColor, suv - vec2(0.0, o * px.y));
  float best = dz;
  vec3 nearestInk = ink;
  if (zl < best) { best = zl; nearestInk = gL.gba; }
  if (zr < best) { best = zr; nearestInk = gR.gba; }
  if (zu < best) { best = zu; nearestInk = gU.gba; }
  if (zd < best) { best = zd; nearestInk = gD.gba; }

  // ③ 阴影线：世界坐标 / 法线，法线最朝外的轴决定投影面 → 条纹钉在表面上
  vec3 wPos = (uInvView * vec4(vp, 1.0)).xyz;
  vec3 wN = normalize(mat3(uInvView) * nV);
  vec3 a = abs(wN);
  vec2 p2;
  if (a.x >= a.y && a.x >= a.z) p2 = wPos.yz;
  else if (a.y >= a.z) p2 = wPos.xz;
  else p2 = wPos.xy;
  float dist = length(vp.xyz);
  // 间距 2 的幂分级（对数域线性混合，避免分档边界抖动出噪点）
  float lf = log2(0.016 * dist / 0.5);
  float i0 = floor(lf);
  float sp = 0.5 * exp2(i0 + smoothstep(0.75, 1.0, lf - i0));
  float w = sp * 0.17;
  // 树干以竖描为主（参考图笔触），亮面留稀疏线、暗面逐层加密，最暗处涂黑
  float h1 = stripes(p2, vec2(0.0, 1.0), sp, w) * (1.0 - smoothstep(0.88, 0.99, shade));
  float h2 = stripes(p2, normalize(vec2(1.0, 1.0)), sp, w) * (1.0 - smoothstep(0.42, 0.58, shade));
  float h3 = stripes(p2, normalize(vec2(1.0, -1.0)), sp, w) * (1.0 - smoothstep(0.2, 0.3, shade));
  float hatch = clamp(h1 + h2 + h3 + (1.0 - smoothstep(0.06, 0.14, shade)), 0.0, 1.0);

  // ④ 纸面：双层值噪声纸纹 + 淡蓝横线
  vec3 paper = vec3(0.965, 0.937, 0.863);
  paper *= 0.965 + 0.05 * vnoise(vUv * uRes.y * 0.55) + 0.028 * vnoise(vUv * uRes.y * 3.1);
  float ruleT = mod(gl_FragCoord.y, uRes.y / 13.5);
  float rule = 1.0 - smoothstep(0.0, 1.4, ruleT);
  paper = mix(paper, vec3(0.58, 0.70, 0.92), rule * 0.16);

  // ⑤ 合成：paper → 墨色排线 → 轮廓
  vec3 col = paper;
  if (!isBg) {
    if (shade < -0.5) {
      col = ink; // fill：整片纯色（云 / 山 / 地面）
    } else {
      // 6% 墨色打底给物体一个体色，排线叠在上面
      col = mix(paper, ink, hatch * 0.72 + 0.06);
    }
  }
  float ew = 0.75 + 0.35 * vnoise(vUv * uRes.y * 0.42);
  col = mix(col, nearestInk * 0.92, edge * ew);
  outColor = vec4(col, 1.0);
}
`

/** 一根合并后的枝：一段价格区间内的所有同侧挂单档 */
interface BranchBin {
  lo: number // 区间下沿（元）
  hi: number
  y: number // 数量加权摆放高度
  repCents: number // 数量最大的档（点击/跳明细用它）
  qty: number
  count: number // 合并档数 = 枝上叶数
  pick?: { x: number; y: number; z: number } // 拾取球心（world），投影/点击共用
}

export function TreeTrunk({ stockName, onPick }: { stockName: string; onPick: (priceCents: number) => void }) {
  const { ledger } = useApp()
  const levels = useMemo(
    () => aggregate(stockName, ledger.sells, ledger.targets, ledger.orders),
    [stockName, ledger],
  )
  const hostRef = useRef<HTMLDivElement | null>(null)
  // onPick 是父组件的内联箭头，引用每次渲染都变——走 ref，避免整棵树反复重建
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let cleanup = () => {}

    void (async () => {
      const THREE = await import('three')
      if (disposed) return

      // ---------- 渲染器 / 两遍管线的 RT ----------
      const renderer = new THREE.WebGLRenderer({ antialias: false })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      const canvas = renderer.domElement
      canvas.dataset.tree = 'price'
      canvas.style.touchAction = 'none'
      host.appendChild(canvas)

      const scene = new THREE.Scene()
      const postScene = new THREE.Scene()
      const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 900)
      const camX = 1.6
      const view = { span: 8, camY: 8 }
      const prices = levels.map((l) => l.priceCents / 100)
      const dataLo = prices.length ? Math.min(...prices) : 8
      const dataHi = prices.length ? Math.max(...prices) : 12
      /** 视野钳位：span 限档；下沿（camY − span/2）不许低于 0——股价永远为正 */
      const clampView = () => {
        view.span = Math.min(SPAN_MAX, Math.max(SPAN_MIN, view.span))
        view.camY = Math.min(CAM_MAX, Math.max(view.span / 2, view.camY))
      }
      const resetView = () => {
        view.camY = (dataLo + dataHi) / 2
        view.span = Math.max(4, Math.min(SPAN_MAX, (dataHi - dataLo) * 1.6 + 2))
        clampView()
      }
      resetView()

      const applyCamera = () => {
        const dist = view.span / (2 * Math.tan((camera.fov * Math.PI) / 360)) + trunkRadiusAt(view.camY) + 0.6
        camera.position.set(camX, view.camY, dist)
        camera.lookAt(0, view.camY, 0)
        camera.updateMatrixWorld()
      }

      const inkOf = (hex: string, fill = false) =>
        new THREE.ShaderMaterial({
          vertexShader: GBUFFER_VERT,
          fragmentShader: GBUFFER_FRAG,
          glslVersion: THREE.GLSL3,
          uniforms: { uInk: { value: new THREE.Color(hex) }, uFill: { value: fill ? 1 : 0 } },
        })

      // ---------- 树干 + 根 ----------
      const trunkGeo = new THREE.CylinderGeometry(0.36, 0.55, TRUNK_MAX - TRUNK_MIN, 28, 90)
      {
        const pos = trunkGeo.attributes.position
        for (let i = 0; i < pos.count; i += 1) {
          const y = pos.getY(i)
          const ang = Math.atan2(pos.getZ(i), pos.getX(i))
          const lump = 0.028 * Math.sin(ang * 5 + y * 0.35) + 0.02 * Math.sin(ang * 9 - y * 0.8)
          const rr = Math.hypot(pos.getX(i), pos.getZ(i))
          if (rr > 0.01) {
            const k = (rr + lump) / rr
            pos.setX(i, pos.getX(i) * k)
            pos.setZ(i, pos.getZ(i) * k)
          }
        }
        trunkGeo.computeVertexNormals()
      }
      const trunkMat = inkOf(INK.trunk)
      const trunk = new THREE.Mesh(trunkGeo, trunkMat)
      trunk.position.y = (TRUNK_MIN + TRUNK_MAX) / 2
      scene.add(trunk)

      const rootGeo = new THREE.ConeGeometry(0.34, 2.6, 10)
      for (let i = 0; i < 6; i += 1) {
        const root = new THREE.Mesh(rootGeo, trunkMat)
        const ang = (i / 6) * Math.PI * 2 + 0.4
        root.position.set(Math.cos(ang) * 0.55, -1.6 + (i % 2) * 0.3, Math.sin(ang) * 0.55)
        root.rotation.z = Math.cos(ang) * 0.9
        root.rotation.x = -Math.sin(ang) * 0.9
        scene.add(root)
      }

      // ---------- 地面（纯色填充）----------
      const groundGeo = new THREE.CircleGeometry(40, 40)
      const groundMat = inkOf(INK.ground, true)
      const ground = new THREE.Mesh(groundGeo, groundMat)
      ground.rotation.x = -Math.PI / 2
      ground.position.y = -2.6
      scene.add(ground)

      // ---------- 远山（纯色填充，钉在地平线上）----------
      const mountMat = inkOf(INK.mountain, true)
      for (const [mx, mz, mr, mh] of [
        [-14, -18, 9, 4.2],
        [2, -22, 12, 5.4],
        [16, -19, 8, 3.6],
      ] as const) {
        const m = new THREE.Mesh(new THREE.ConeGeometry(mr, mh, 4), mountMat)
        m.position.set(mx, -2.6 + mh / 2, mz)
        m.rotation.y = mx
        scene.add(m)
      }

      // ---------- 云（纯色填充，沿轴散布，呼应「向上无限」）----------
      const cloudMat = inkOf(INK.cloud, true)
      const cloudBallGeo = new THREE.SphereGeometry(1, 18, 12)
      for (const [cy, cx0, cz, s] of [
        [16, -4.4, -4, 1.0],
        [44, 4.8, -5, 0.85],
        [92, -5.2, -4, 1.1],
        [150, 4.4, -6, 0.95],
        [215, -4.6, -5, 1.05],
      ] as const) {
        for (const [dx, dy, r] of [
          [0, 0, 0.62],
          [0.55, -0.08, 0.44],
          [-0.52, -0.1, 0.4],
          [0.12, 0.26, 0.4],
        ] as const) {
          const ball = new THREE.Mesh(cloudBallGeo, cloudMat)
          ball.position.set(cx0 + dx * s, cy + dy * s, cz)
          ball.scale.set(r * s * 1.25, r * s * 0.8, r * s)
          scene.add(ball)
        }
      }

      // ---------- 青苔 ----------
      const mossGeo = new THREE.IcosahedronGeometry(0.06, 0)
      const mossMat = inkOf(INK.moss)
      const moss = new THREE.InstancedMesh(mossGeo, mossMat, 160)
      {
        const m = new THREE.Matrix4()
        let seed = 11
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
        for (let i = 0; i < 160; i += 1) {
          const y = TRUNK_MIN + 4 + rnd() * (TRUNK_MAX - TRUNK_MIN - 8)
          const ang = rnd() * Math.PI * 2
          const r = outlineRadiusAt(y) + 0.015
          const s = 0.6 + rnd() * 1.3
          m.makeScale(s, s * 0.7, s)
          m.setPosition(Math.cos(ang) * r, y, Math.sin(ang) * r)
          moss.setMatrixAt(i, m)
        }
        moss.instanceMatrix.needsUpdate = true
      }
      scene.add(moss)

      // ---------- 树轮刻度：三档粗细，按缩放换挡（0.1 一圈只在近景出现） ----------
      const makeRingSet = (tube: number) => {
        const geo = new THREE.TorusGeometry(1, tube, 6, 44)
        const mesh = new THREE.InstancedMesh(geo, inkOf(INK.ring), 420)
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        mesh.visible = false
        scene.add(mesh)
        return { geo, mesh }
      }
      const ringSets = [makeRingSet(0.012), makeRingSet(0.05), makeRingSet(0.15)]
      const majorSets = [makeRingSet(0.024), makeRingSet(0.08), makeRingSet(0.24)]

      // ---------- 数据枝叶：买枝（左·蓝）/ 卖枝（右·红）/ 落叶（已卖·后景） ----------
      const branchGeo = new THREE.CylinderGeometry(0.032, 0.05, 1, 6) // 两段拼出一根弯枝
      const leafGeo = new THREE.SphereGeometry(1, 8, 6)
      const pickGeo = new THREE.IcosahedronGeometry(1, 1)
      const buyMat = inkOf(INK.buy)
      const sellMat = inkOf(INK.sell)
      const fallenMat = inkOf(INK.fallen)
      const pickMat = inkOf(INK.trunk)
      pickMat.visible = false // 只参与拾取，不进 pass1

      const dummy = new THREE.Matrix4()
      const quat = new THREE.Quaternion()
      const up = new THREE.Vector3(0, 1, 0)
      const dir1 = new THREE.Vector3()
      const dir2 = new THREE.Vector3()
      const posV = new THREE.Vector3()
      const sclV = new THREE.Vector3()
      const projV = new THREE.Vector3()

      const buyList = levels.filter((l) => l.buyQty > 0)
      const sellList = levels.filter((l) => l.sellQty > 0)
      const mkMesh = (geo: import('three').BufferGeometry, mat: import('three').ShaderMaterial, cap: number) => {
        if (cap <= 0) return null
        const mesh = new THREE.InstancedMesh(geo, mat, cap)
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        mesh.frustumCulled = false // 实例矩阵随视图重排，包围球不可靠
        scene.add(mesh)
        return mesh
      }
      const buyBranchMesh = mkMesh(branchGeo, buyMat, buyList.length * 2)
      const sellBranchMesh = mkMesh(branchGeo, sellMat, sellList.length * 2)
      const buyLeafMesh = mkMesh(leafGeo, buyMat, buyList.length)
      const sellLeafMesh = mkMesh(leafGeo, sellMat, sellList.length)
      const pickMesh = mkMesh(pickGeo, pickMat, buyList.length + sellList.length)
      const totalFallen = levels.reduce((s, l) => s + l.soldCount, 0)
      const fallenMesh = mkMesh(leafGeo, fallenMat, Math.min(totalFallen, FALLEN_CAP))

      interface BranchWork {
        bins: { buy: BranchBin[]; sell: BranchBin[] }
        picks: BranchBin[] // pickMesh 实例顺序对应：先卖后买
        lastGate: string
      }
      const work: BranchWork = { bins: { buy: [], sell: [] }, picks: [], lastGate: '' }

      /** 已完成落叶：铺在树干后方更远的深度层（近枝远叶），每笔已卖一片 */
      const buildFallen = () => {
        if (!fallenMesh) return
        let seed = 23
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
        const stride = totalFallen > FALLEN_CAP ? totalFallen / FALLEN_CAP : 1
        let acc = 0
        let fi = 0
        for (const l of levels) {
          for (let j = 0; j < l.soldCount; j += 1) {
            acc += 1
            if (acc < stride) continue
            acc -= stride
            if (fi >= FALLEN_CAP) break
            const y = l.priceCents / 100 - 0.05 - rnd() * 0.2
            const x = (fi % 2 === 0 ? 1 : -1) * (0.55 + rnd() * 1.15)
            const z = -(0.85 + rnd() * 0.55)
            const s = 0.085 + Math.min(0.05, Math.sqrt(l.soldQty / Math.max(1, l.soldCount)) / 140)
            quat.setFromAxisAngle(up, rnd() * Math.PI * 2)
            sclV.set(s * 1.7, s * 0.34, s)
            posV.set(x, y, z)
            dummy.compose(posV, quat, sclV)
            fallenMesh.setMatrixAt(fi, dummy)
            fi += 1
          }
          if (fi >= FALLEN_CAP) break
        }
        fallenMesh.count = fi
        fallenMesh.instanceMatrix.needsUpdate = true
      }
      buildFallen()

      /** 按档间距把同侧档位串成合并组（链式：相邻间距 < gap 就并） */
      const groupLevels = (
        list: TreeLevel[],
        qtyOf: (l: TreeLevel) => number,
        gap: number,
      ): BranchBin[] => {
        const bins: BranchBin[] = []
        let i = 0
        while (i < list.length) {
          let j = i
          let qty = 0
          let wy = 0
          let repQty = -1
          let repCents = list[i].priceCents
          while (j < list.length && (j === i || list[j].priceCents / 100 - list[j - 1].priceCents / 100 < gap)) {
            const l = list[j]
            const q = qtyOf(l)
            qty += q
            wy += (l.priceCents / 100) * q
            if (q > repQty) {
              repQty = q
              repCents = l.priceCents
            }
            j += 1
          }
          bins.push({
            lo: list[i].priceCents / 100,
            hi: list[j - 1].priceCents / 100,
            y: qty > 0 ? wy / qty : (list[i].priceCents + list[j - 1].priceCents) / 200,
            repCents,
            qty,
            count: j - i,
          })
          i = j
        }
        return bins
      }

      /** 一段枝：从锚点沿 dir 伸出长度 len，粗细倍率 t */
      const placeSeg = (
        mesh: import('three').InstancedMesh | null,
        idx: number,
        ax: number,
        ay: number,
        dir: import('three').Vector3,
        len: number,
        t: number,
      ) => {
        if (!mesh) return
        quat.setFromUnitVectors(up, dir)
        posV.set(ax + dir.x * len * 0.5, ay + dir.y * len * 0.5, dir.z * len * 0.5)
        sclV.set(t, len, t)
        dummy.compose(posV, quat, sclV)
        mesh.setMatrixAt(idx, dummy)
      }

      /**
       * 重排枝叶。只在「合并档位（gap，√2 步进量化）+ 远景放大档」变化时做，
       * 平移不触发；矩阵复用共享临时对象，无逐帧分配。
       */
      const layoutBranches = () => {
        // 行距不足 ROWS_PER_SCREEN 行就并档；gap 按 2^(n/2) 量化，缩放中不抖
        const gapRaw = view.span / ROWS_PER_SCREEN
        const gap = Math.max(0.02, Math.pow(2, Math.ceil(Math.log2(Math.max(1e-4, gapRaw)) * 2) / 2))
        // 拉远时枝整体放大一档，避免远景细枝缩成看不见的线
        const kz = 1 + Math.min(1.1, Math.max(0, view.span - 12) / 90)
        const gate = `${gap}|${Math.round(kz * 5)}`
        if (gate === work.lastGate) return
        work.lastGate = gate

        const doSide = (
          side: -1 | 1,
          list: TreeLevel[],
          qtyOf: (l: TreeLevel) => number,
          branchMesh: import('three').InstancedMesh | null,
          leafMesh: import('three').InstancedMesh | null,
        ) => {
          const bins = groupLevels(list, qtyOf, gap)
          let bi = 0
          let li = 0
          const sideBins: BranchBin[] = []
          for (const bin of bins) {
            let seed = Math.round(bin.lo * 7919) + (side > 0 ? 31 : 57)
            const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
            const y = bin.y
            const r = outlineRadiusAt(y)
            const ax = side * r * 0.96
            const len = Math.min(1.5, (0.5 + Math.sqrt(bin.qty) / 38) * kz)
            const thick = (1 + Math.min(1.1, Math.sqrt(bin.qty) / 650)) * Math.min(1.5, kz * 0.85)
            const tilt = 0.1 + rnd() * 0.16
            dir1.set(side * 0.98, tilt, 0.04).normalize()
            dir2.set(side * 0.9, tilt + 0.18 + rnd() * 0.1, 0.09).normalize()
            const len1 = len * 0.62
            const len2 = len * 0.5
            placeSeg(branchMesh, bi * 2, ax, y, dir1, len1, thick)
            placeSeg(branchMesh, bi * 2 + 1, ax + dir1.x * len1, y + dir1.y * len1, dir2, len2, thick * 0.66)
            bi += 1

            // 合并档 ≥ 2 才画叶：叶数 = 合并档数，沿枝铺开
            if (bin.count > 1 && leafMesh) {
              const total = len1 + len2
              const ls = Math.max(0.55, Math.min(1.1, 1.15 - bin.count * 0.045)) * Math.min(1.6, kz * 0.9)
              for (let m = 0; m < bin.count && li < list.length; m += 1) {
                const s = ((m + 0.5) / bin.count) * total * 0.94 + total * 0.04
                const px = s < len1 ? ax + dir1.x * s : ax + dir1.x * len1 + dir2.x * (s - len1)
                const py = s < len1 ? y + dir1.y * s : y + dir1.y * len1 + dir2.y * (s - len1)
                quat.setFromAxisAngle(up, rnd() * Math.PI * 2)
                posV.set(px, py + (m % 2 === 0 ? 1 : -1) * 0.045 * ls, dir1.z * s)
                sclV.set(0.16 * ls, 0.03 * ls, 0.078 * ls)
                dummy.compose(posV, quat, sclV)
                leafMesh.setMatrixAt(li, dummy)
                li += 1
              }
            }

            // 拾取球：贴在枝中段，杆细也能点中；球心存进 bin，投影/点击共用
            bin.pick = { x: ax + dir1.x * len1 * 0.85, y: y + dir1.y * len1 * 0.85, z: dir1.z * len1 * 0.85 }
            if (pickMesh) {
              const pickR = Math.min(0.46, 0.3 + 0.02 * bin.count) * Math.min(1.6, kz)
              posV.set(bin.pick.x, bin.pick.y, bin.pick.z)
              sclV.setScalar(pickR)
              quat.identity()
              dummy.compose(posV, quat, sclV)
              pickMesh.setMatrixAt(work.picks.push(bin) - 1, dummy)
            }
            sideBins.push(bin)
          }
          if (branchMesh) {
            branchMesh.count = bi * 2
            branchMesh.instanceMatrix.needsUpdate = true
          }
          if (leafMesh) {
            leafMesh.count = li
            leafMesh.instanceMatrix.needsUpdate = true
          }
          return sideBins
        }

        work.picks.length = 0
        // 先卖后买，保证 e2e 默认 side=1 的档位在拾取层里
        work.bins.sell = doSide(1, sellList, (l) => l.sellQty, sellBranchMesh, sellLeafMesh)
        work.bins.buy = doSide(-1, buyList, (l) => l.buyQty, buyBranchMesh, buyLeafMesh)
        if (pickMesh) {
          pickMesh.count = work.picks.length
          pickMesh.instanceMatrix.needsUpdate = true
        }
      }

      // ---------- 价格标签：HTML 覆盖层（任何缩放下都清晰，钉在画布左缘） ----------
      const LABEL_CAP = 40
      const labelHost = document.createElement('div')
      labelHost.className = 'tree-labels'
      const labelPool: { el: HTMLDivElement; text: string }[] = []
      for (let i = 0; i < LABEL_CAP; i += 1) {
        const el = document.createElement('div')
        el.className = 'tree-label'
        el.style.display = 'none'
        labelHost.appendChild(el)
        labelPool.push({ el, text: '' })
      }
      host.appendChild(labelHost)
      /**
       * 价签步长：让相邻数字在屏幕上至少隔 LABEL_MIN_GAP 像素，从 1-2-5 档里
       * 取最小的满足档。任何缩放级别间隔都等比例、够宽——数据 8~12 毛毛都有
       * 也不会挤；看得宽就让它稀疏，不压缩轴向。
       */
      const labelStep = (span: number, heightPx: number) => {
        const raw = (LABEL_MIN_GAP * span) / Math.max(1, heightPx)
        return LABEL_LADDER.find((s) => s >= raw) ?? LABEL_LADDER[LABEL_LADDER.length - 1]
      }

      const updateLabels = () => {
        const rect = canvas.getBoundingClientRect()
        const half = view.span / 2
        const y0 = Math.max(TRUNK_MIN + 0.1, view.camY - half)
        const y1 = Math.min(TRUNK_MAX - 0.1, view.camY + half)
        const step = labelStep(view.span, rect.height || canvas.clientHeight || 1)
        let li = 0
        for (let y = Math.ceil(y0 / step) * step; y <= y1 && li < LABEL_CAP; y += step) {
          projV.set(0, y, 0).project(camera)
          if (projV.z > 1 || projV.z < -1) continue
          const relTop = ((1 - projV.y) / 2) * rect.height
          if (relTop < -20 || relTop > rect.height + 20) continue
          const entry = labelPool[li]
          const text = step < 1 ? y.toFixed(1) : String(Math.round(y))
          if (entry.text !== text) {
            entry.el.textContent = text
            entry.text = text
          }
          entry.el.style.display = 'block'
          entry.el.style.transform = `translateY(${relTop.toFixed(1)}px)`
          li += 1
        }
        for (; li < LABEL_CAP; li += 1) labelPool[li].el.style.display = 'none'
      }

      // ---------- 交互：滚轮 / 捏合缩放，拖动攀爬（内容跟手），点枝跳明细 ----------
      const pointers = new Map<number, { x: number; y: number }>()
      let pinchDist0 = 1
      let spanAtPinch = 0
      let pinchMidY = 0
      let dragMoved = 0
      let dirty = true
      const markDirty = () => {
        dirty = true
      }

      // 手指往下拖 → 树往下走 → 镜头上移看更高价（和地图 / 列表同向，不再反向）
      const panBy = (dyPx: number) => {
        view.camY += dyPx * (view.span / (canvas.clientHeight || 1))
        clampView()
        markDirty()
      }
      const zoomBy = (factor: number) => {
        view.span /= factor
        clampView()
        markDirty()
      }

      const onWheel = (e: WheelEvent) => {
        e.preventDefault()
        zoomBy(Math.pow(1.0014, -e.deltaY))
      }
      const onDown = (e: PointerEvent) => {
        canvas.setPointerCapture(e.pointerId)
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        dragMoved = 0
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()]
          pinchDist0 = Math.hypot(a.x - b.x, a.y - b.y) || 1
          spanAtPinch = view.span
          pinchMidY = (a.y + b.y) / 2
        }
      }
      const onMove = (e: PointerEvent) => {
        const prev = pointers.get(e.pointerId)
        if (!prev) return
        dragMoved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y)
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (pointers.size === 1) {
          panBy(e.clientY - prev.y)
        } else if (pointers.size >= 2) {
          const [a, b] = [...pointers.values()]
          const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
          view.span = spanAtPinch * (pinchDist0 / d)
          clampView()
          const midY = (a.y + b.y) / 2
          panBy(midY - pinchMidY)
          pinchMidY = midY
          markDirty()
        }
      }
      const onUp = (e: PointerEvent) => {
        const wasSingle = pointers.size === 1
        pointers.delete(e.pointerId)
        canvas.releasePointerCapture?.(e.pointerId)
        if (wasSingle && dragMoved < 7) raycastPick(e)
      }

      const raycaster = new THREE.Raycaster()
      const ndc = new THREE.Vector2()
      const raycastPick = (e: PointerEvent) => {
        if (!pickMesh) return
        const rect = canvas.getBoundingClientRect()
        ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
        raycaster.setFromCamera(ndc, camera)
        for (const hit of raycaster.intersectObject(pickMesh, false)) {
          const bin = work.picks[hit.instanceId ?? -1]
          if (bin) {
            pickRef.current(bin.repCents)
            return
          }
        }
      }

      canvas.addEventListener('wheel', onWheel, { passive: false })
      canvas.addEventListener('pointerdown', onDown)
      canvas.addEventListener('pointermove', onMove)
      canvas.addEventListener('pointerup', onUp)
      canvas.addEventListener('pointercancel', onUp)

      // ---------- 尺寸 / RT / 后处理 ----------
      const sizeV = new THREE.Vector2()
      const getBufSize = () => {
        renderer.getDrawingBufferSize(sizeV)
        return { w: Math.max(2, Math.round(sizeV.x)), h: Math.max(2, Math.round(sizeV.y)) }
      }
      const { w: bw0, h: bh0 } = getBufSize()
      const depthTex = new THREE.DepthTexture(bw0, bh0)
      depthTex.type = THREE.FloatType
      const rt = new THREE.WebGLRenderTarget(bw0, bh0, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        depthBuffer: true,
        depthTexture: depthTex,
      })
      const postUniforms = {
        tColor: { value: rt.texture },
        tDepth: { value: depthTex },
        uRes: { value: new THREE.Vector2(bw0, bh0) },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uInvProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
      }
      const postMat = new THREE.ShaderMaterial({
        vertexShader: POST_VERT,
        fragmentShader: POST_FRAG,
        glslVersion: THREE.GLSL3,
        uniforms: postUniforms,
        depthTest: false,
        depthWrite: false,
      })
      const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat)
      postScene.add(postQuad)

      const resize = () => {
        const w = host.clientWidth || 320
        const h = host.clientHeight || 380
        renderer.setSize(w, h, false)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        const { w: bw, h: bh } = getBufSize()
        rt.setSize(bw, bh)
        postUniforms.uRes.value.set(bw, bh)
        markDirty()
      }
      const ro = new ResizeObserver(resize)
      ro.observe(host)
      const onVisible = () => {
        if (!document.hidden) markDirty()
      }
      document.addEventListener('visibilitychange', onVisible)
      resize()
      applyCamera()
      layoutBranches()
      updateLabels()

      ;(canvas as HTMLCanvasElement & { __tree?: unknown }).__tree = {
        levels: () => levels.map((l) => ({ cents: l.priceCents, buy: l.buyQty, sell: l.sellQty, sold: l.soldQty })),
        span: () => view.span,
        center: () => view.camY,
        zoomBy,
        projectPrice: (cents: number, side: 1 | -1 = 1) => {
          // 投影到该档所在合并枝的拾取球心——e2e 用它定位点击点
          const y = cents / 100
          const bins = side > 0 ? work.bins.sell : work.bins.buy
          const bin = bins.find((b) => y >= b.lo - 1e-6 && y <= b.hi + 1e-6)
          if (bin?.pick) {
            // layoutBranches 存好的拾取球心，投影/点击同一位置
            projV.set(bin.pick.x, bin.pick.y, bin.pick.z).project(camera)
          } else {
            projV.set(side * (outlineRadiusAt(y) + 0.9), y, 0).project(camera)
          }
          if (projV.z > 1 || projV.z < -1) return null
          const rect = canvas.getBoundingClientRect()
          return {
            x: Math.round(rect.left + ((projV.x + 1) / 2) * rect.width),
            y: Math.round(rect.top + ((1 - projV.y) / 2) * rect.height),
          }
        },
      }

      let raf = 0
      const mat4 = new THREE.Matrix4()
      const renderFrame = () => {
        applyCamera()
        layoutBranches()
        updateLabels()
        // 树轮换挡：近景 0.1 一圈（细），中景 0.5，远景 1 元（粗）
        const tier = view.span < 8 ? 0 : view.span < 60 ? 1 : 2
        const minorStep = view.span < 8 ? 0.1 : view.span < 60 ? 0.5 : 1
        const half = view.span / 2
        const y0 = Math.max(TRUNK_MIN + 0.1, view.camY - half)
        const y1 = Math.min(TRUNK_MAX - 0.1, view.camY + half)
        ringSets.forEach((set, i) => {
          set.mesh.visible = i === tier
        })
        majorSets.forEach((set, i) => {
          set.mesh.visible = i === tier
        })
        const activeRings = ringSets[tier].mesh
        const activeMajors = majorSets[tier].mesh
        let ri = 0
        for (let y = Math.ceil(y0 / minorStep) * minorStep; y <= y1 && ri < 420; y += minorStep) {
          const r = outlineRadiusAt(y) + 0.02
          mat4.makeScale(r, r, r)
          mat4.setPosition(0, y, 0)
          activeRings.setMatrixAt(ri++, mat4)
        }
        activeRings.count = ri
        activeRings.instanceMatrix.needsUpdate = true
        let mi = 0
        for (let y = Math.ceil(y0); y <= y1 && mi < 420; y += 1) {
          const r = outlineRadiusAt(y) + 0.035
          mat4.makeScale(r, r, r)
          mat4.setPosition(0, y, 0)
          activeMajors.setMatrixAt(mi++, mat4)
        }
        activeMajors.count = mi
        activeMajors.instanceMatrix.needsUpdate = true

        // pass 1：数据缓冲 → pass 2：全屏后处理上屏
        postUniforms.uInvProj.value.copy(camera.projectionMatrixInverse)
        postUniforms.uInvView.value.copy(camera.matrixWorld)
        renderer.setRenderTarget(rt)
        renderer.render(scene, camera)
        renderer.setRenderTarget(null)
        renderer.render(postScene, postCam)
      }
      // 按需渲染：无逐帧动画，只有交互 / 改尺寸 / 回前台才置脏画一帧
      const tick = () => {
        raf = requestAnimationFrame(tick)
        if (document.hidden || !dirty) return
        dirty = false
        renderFrame()
      }
      tick()

      cleanup = () => {
        cancelAnimationFrame(raf)
        ro.disconnect()
        document.removeEventListener('visibilitychange', onVisible)
        canvas.removeEventListener('wheel', onWheel)
        canvas.removeEventListener('pointerdown', onDown)
        canvas.removeEventListener('pointermove', onMove)
        canvas.removeEventListener('pointerup', onUp)
        canvas.removeEventListener('pointercancel', onUp)
        delete (canvas as HTMLCanvasElement & { __tree?: unknown }).__tree
        labelHost.remove()
        rt.dispose()
        depthTex.dispose()
        postQuad.geometry.dispose()
        postMat.dispose()
        trunkGeo.dispose()
        trunkMat.dispose()
        groundGeo.dispose()
        groundMat.dispose()
        rootGeo.dispose()
        mountMat.dispose()
        cloudMat.dispose()
        cloudBallGeo.dispose()
        mossGeo.dispose()
        mossMat.dispose()
        branchGeo.dispose()
        leafGeo.dispose()
        pickGeo.dispose()
        buyMat.dispose()
        sellMat.dispose()
        fallenMat.dispose()
        pickMat.dispose()
        for (const mesh of [buyBranchMesh, sellBranchMesh, buyLeafMesh, sellLeafMesh, pickMesh, fallenMesh]) {
          if (mesh) {
            scene.remove(mesh)
            mesh.dispose()
          }
        }
        for (const set of [...ringSets, ...majorSets]) {
          set.geo.dispose()
          ;(set.mesh.material as import('three').ShaderMaterial).dispose()
        }
        renderer.dispose()
        canvas.remove()
      }
    })()

    return () => {
      disposed = true
      cleanup()
    }
    // onPick 走 pickRef；stockName 变化时 levels 会一起变
  }, [levels, stockName])

  return (
    <div className="tree-wrap">
      <div ref={hostRef} className="tree-host" />
      <div className="tree-legend">
        <span className="dot buy">待买枝 · 左</span>
        <span className="dot sell">待卖枝 · 右</span>
        <span className="dot fallen">落叶 · 已卖（后景）</span>
        <span className="hint">滚轮缩放 · 拖动攀爬 · 点枝看明细</span>
      </div>
    </div>
  )
}
