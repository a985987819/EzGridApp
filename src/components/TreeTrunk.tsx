/**
 * 3D 价格树干（V9.6）：概览页的纵轴从表格变成一棵手绘插画风立体树。
 *
 * - 纵轴 = 价格轴，1 元 = 1 个世界单位，每 0.1 元一圈树轮（近看 0.1 一圈，拉远自动
 *   稀疏到 0.5 / 1 元并换粗细档）；
 * - 待买（蓝）挂左侧、待卖（红）挂右侧，已卖出（米黄）贴着树干；叶子按「屏幕近似
 *   恒定」的 LOD 缩放——拉远看整条价格轴时，单子密集的价格区域是一团团色块；
 * - 滚轮 / 双指捏合缩放，拖动上下攀爬，树干向上「无限」延展（覆盖 -20 ~ 300 元，
 *   远处用雾隐去）；价格标签是 HTML 覆盖层，任何缩放下都清晰；
 * - 点叶团跳到该价格的明细；three.js 动态导入（与 xlsx 同套路），主包不背 3D 引擎。
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
const CAM_MIN = -12
const CAM_MAX = 288
const SPAN_MIN = 0.5
const SPAN_MAX = 150

/** 手绘风配色（与 styles.css 的插画底色一致） */
const C = {
  bg: '#f7f0dd',
  barkBase: '#9a6b45',
  outline: 0x4a3020,
  ring: 0x6f4530,
  buy: [0x5b8fd9, 0x7fa9e3, 0x4a7cc4] as const,
  sell: [0xd95f57, 0xe4796d, 0xc04f48] as const,
  fallen: [0xd9b56a, 0xcba75c, 0xc39a4e] as const,
  twig: 0x6f4530,
  moss: 0x9db06e,
}

interface BlobLevel extends TreeLevel {
  buySize: number
  sellSize: number
  fallenSize: number
}

const sizeOf = (qtyValue: number, k: number, cap: number) =>
  qtyValue <= 0 ? 0 : Math.min(cap, 0.24 + Math.sqrt(qtyValue) / k)

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

/** 价格 → 描边外表面半径（树轮 / 青苔 / 叶团的锚点都贴它，避免被描边吞掉） */
function outlineRadiusAt(y: number): number {
  return trunkRadiusAt(y) + 0.065
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

      // ---------- 渲染器 / 场景 / 相机 ----------
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      const canvas = renderer.domElement
      canvas.dataset.tree = 'price'
      canvas.style.touchAction = 'none'
      host.appendChild(canvas)

      const scene = new THREE.Scene()
      scene.background = new THREE.Color(C.bg)
      scene.fog = new THREE.Fog(C.bg, 14, 34)

      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 900)
      const camX = 1.6
      const view = { span: 8, camY: 8 }
      const prices = levels.map((l) => l.priceCents / 100)
      const dataLo = prices.length ? Math.min(...prices) : 8
      const dataHi = prices.length ? Math.max(...prices) : 12
      const resetView = () => {
        view.camY = (dataLo + dataHi) / 2
        view.span = Math.max(4, Math.min(SPAN_MAX, (dataHi - dataLo) * 1.6 + 2))
      }
      resetView()

      const applyCamera = () => {
        const dist = view.span / (2 * Math.tan((camera.fov * Math.PI) / 360)) + trunkRadiusAt(view.camY) + 0.6
        camera.position.set(camX, view.camY, dist)
        camera.lookAt(0, view.camY, 0)
        const fog = scene.fog as import('three').Fog
        fog.near = dist * 0.6
        fog.far = dist * 1.7
      }

      scene.add(new THREE.HemisphereLight(0xfff4dd, 0x8a6a4a, 1.35))
      const sun = new THREE.DirectionalLight(0xffffff, 1.5)
      sun.position.set(-6, 10, 8)
      scene.add(sun)

      // ---------- 赛璐璐明暗 + 手绘树皮纹理 ----------
      const gradData = new Uint8Array([90, 150, 205, 255])
      const gradientMap = new THREE.DataTexture(gradData, 4, 1, THREE.RedFormat)
      gradientMap.minFilter = THREE.NearestFilter
      gradientMap.magFilter = THREE.NearestFilter
      gradientMap.needsUpdate = true

      const makeBarkTexture = () => {
        const cv = document.createElement('canvas')
        cv.width = 256
        cv.height = 512
        const g = cv.getContext('2d')!
        g.fillStyle = C.barkBase
        g.fillRect(0, 0, 256, 512)
        let seed = 7
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
        for (let i = 0; i < 110; i += 1) {
          const x = rnd() * 256
          const dark = rnd() > 0.5
          g.strokeStyle = dark ? 'rgba(111,69,48,0.34)' : 'rgba(196,150,104,0.30)'
          g.lineWidth = 2 + rnd() * 6
          g.beginPath()
          let px = x
          g.moveTo(px, -20)
          for (let yy = 0; yy <= 532; yy += 40) {
            px += (rnd() - 0.5) * 14
            g.quadraticCurveTo(px + (rnd() - 0.5) * 10, yy - 20, px, yy)
          }
          g.stroke()
        }
        for (let i = 0; i < 14; i += 1) {
          g.fillStyle = 'rgba(111,69,48,0.28)'
          g.beginPath()
          g.ellipse(rnd() * 256, rnd() * 512, 5 + rnd() * 9, 2.5 + rnd() * 4, 0, 0, Math.PI * 2)
          g.fill()
        }
        const tex = new THREE.CanvasTexture(cv)
        tex.wrapS = THREE.RepeatWrapping
        tex.wrapT = THREE.RepeatWrapping
        tex.repeat.set(3, 34)
        tex.anisotropy = 4
        return tex
      }
      const barkTex = makeBarkTexture()
      const barkMat = new THREE.MeshToonMaterial({ map: barkTex, gradientMap })
      const outlineMat = new THREE.MeshBasicMaterial({ color: C.outline, side: THREE.BackSide })

      // ---------- 树干 + 描边 + 根 + 地面 + 青苔 ----------
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
      const trunk = new THREE.Mesh(trunkGeo, barkMat)
      trunk.position.y = (TRUNK_MIN + TRUNK_MAX) / 2
      scene.add(trunk)
      const outlineGeo = new THREE.CylinderGeometry(
        trunkRadiusAt(TRUNK_MAX) + 0.065,
        trunkRadiusAt(TRUNK_MIN) + 0.065,
        TRUNK_MAX - TRUNK_MIN + 0.4,
        28,
        40,
      )
      const outline = new THREE.Mesh(outlineGeo, outlineMat)
      outline.position.copy(trunk.position)
      scene.add(outline)

      const rootGeo = new THREE.ConeGeometry(0.34, 2.6, 10)
      for (let i = 0; i < 6; i += 1) {
        const root = new THREE.Mesh(rootGeo, barkMat)
        const ang = (i / 6) * Math.PI * 2 + 0.4
        root.position.set(Math.cos(ang) * 0.55, -1.6 + (i % 2) * 0.3, Math.sin(ang) * 0.55)
        root.rotation.z = Math.cos(ang) * 0.9
        root.rotation.x = -Math.sin(ang) * 0.9
        scene.add(root)
      }
      const groundGeo = new THREE.CircleGeometry(40, 40)
      const groundMat = new THREE.MeshBasicMaterial({ color: 0xe4e2bd })
      const ground = new THREE.Mesh(groundGeo, groundMat)
      ground.rotation.x = -Math.PI / 2
      ground.position.y = -2.6
      scene.add(ground)

      const mossGeo = new THREE.IcosahedronGeometry(0.06, 0)
      const mossMat = new THREE.MeshToonMaterial({ color: C.moss, gradientMap })
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
      const makeRingSet = (tube: number, opacity: number) => {
        const geo = new THREE.TorusGeometry(1, tube, 6, 44)
        const mat = new THREE.MeshBasicMaterial({ color: C.ring, transparent: true, opacity })
        const mesh = new THREE.InstancedMesh(geo, mat, 420)
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        mesh.visible = false
        scene.add(mesh)
        return { geo, mat, mesh }
      }
      const ringSets = [makeRingSet(0.018, 0.38), makeRingSet(0.06, 0.34), makeRingSet(0.17, 0.3)]
      const majorSets = [makeRingSet(0.03, 0.55), makeRingSet(0.09, 0.5), makeRingSet(0.26, 0.45)]

      // ---------- 数据叶子：买蓝（左）/ 卖红（右）/ 已卖米黄（贴干） ----------
      const blobGeo = new THREE.IcosahedronGeometry(1, 1)
      const twigGeo = new THREE.CylinderGeometry(0.03, 0.045, 1, 6)
      const dummy = new THREE.Matrix4()
      const zeroM = new THREE.Matrix4().makeScale(0, 0, 0)
      const quat = new THREE.Quaternion()
      const up = new THREE.Vector3(0, 1, 0)
      const dir = new THREE.Vector3()

      interface BlobWork {
        levels: BlobLevel[]
        buyMesh: import('three').InstancedMesh | null
        sellMesh: import('three').InstancedMesh | null
        fallenMesh: import('three').InstancedMesh | null
        twigMesh: import('three').InstancedMesh | null
      }
      const work: BlobWork = { levels: [], buyMesh: null, sellMesh: null, fallenMesh: null, twigMesh: null }
      const disposeBlobMeshes = () => {
        for (const key of ['buyMesh', 'sellMesh', 'fallenMesh', 'twigMesh'] as const) {
          const mesh = work[key]
          if (mesh) {
            scene.remove(mesh)
            mesh.dispose()
            work[key] = null
          }
        }
      }

      // 叶团基础尺寸（世界单位，近景口径）
      const buildBlobs = () => {
        disposeBlobMeshes()
        work.levels = levels.map((l) => ({
          ...l,
          buySize: sizeOf(l.buyQty, 34, 0.8),
          sellSize: sizeOf(l.sellQty, 34, 0.8),
          fallenSize: sizeOf(l.soldQty, 70, 0.36),
        }))
        const n = work.levels.length
        if (n === 0) return

        const mkLeaves = (colors: readonly number[]) => {
          const mat = new THREE.MeshToonMaterial({ gradientMap })
          const mesh = new THREE.InstancedMesh(blobGeo, mat, n * 3)
          for (let i = 0; i < n * 3; i += 1) {
            mesh.setColorAt(i, new THREE.Color(colors[i % colors.length]))
          }
          mesh.instanceColor!.needsUpdate = true
          scene.add(mesh)
          return mesh
        }
        work.buyMesh = mkLeaves(C.buy)
        work.sellMesh = mkLeaves(C.sell)
        work.fallenMesh = mkLeaves(C.fallen)
        const twigMat = new THREE.MeshToonMaterial({ color: C.twig, gradientMap })
        work.twigMesh = new THREE.InstancedMesh(twigGeo, twigMat, n * 2)
        scene.add(work.twigMesh)
        for (let i = 0; i < n * 3; i += 1) {
          work.buyMesh.setMatrixAt(i, zeroM)
          work.sellMesh.setMatrixAt(i, zeroM)
          work.fallenMesh.setMatrixAt(i, zeroM)
        }
        for (let i = 0; i < n * 2; i += 1) work.twigMesh.setMatrixAt(i, zeroM)
      }
      buildBlobs()

      // 每帧按 LOD 系数重排叶团：拉远时叶子按「屏幕近似恒定」放大（封顶 4 倍），
      // 左缘始终离描边 0.42，绝不吞掉树干；密度在拉远时自然聚成色块
      let lastK = 0
      const layoutBlobs = () => {
        const n = work.levels.length
        if (n === 0 || !work.buyMesh || !work.twigMesh) return
        const k = Math.min(4, Math.max(1, view.span / 9))
        if (Math.abs(k - lastK) < lastK * 0.02) return
        lastK = k

        let seed = 23
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
        const placeSide = (
          mesh: import('three').InstancedMesh | null,
          side: 1 | -1,
          sizeAt: (l: BlobLevel) => number,
          twigBase: number,
        ) => {
          if (!mesh) return
          work.levels.forEach((l, i) => {
            const s = sizeAt(l) * k
            if (s <= 0) return
            const y = l.priceCents / 100
            const r = outlineRadiusAt(y)
            const cx = side * (r + 0.42 + s)
            const cy = y + side * 0.06 * s
            dir.set(cx - side * r, cy - y, 0).normalize()
            quat.setFromUnitVectors(up, dir)
            dummy.makeRotationFromQuaternion(quat)
            dummy.scale(new THREE.Vector3(1, Math.hypot(cx - side * r, cy - y) || 0.001, 1))
            dummy.setPosition(side * r * 0.98, y, 0)
            work.twigMesh!.setMatrixAt(twigBase + i, dummy)

            const main = new THREE.Matrix4().makeScale(s, s * 0.62, s)
            main.setPosition(cx, cy, 0)
            mesh.setMatrixAt(i * 3, main)
            for (let j = 1; j <= 2; j += 1) {
              const ss = s * (0.42 + rnd() * 0.22)
              const mm = new THREE.Matrix4().makeScale(ss, ss * 0.6, ss)
              mm.setPosition(
                cx + side * s * (0.5 + rnd() * 0.35),
                cy + (rnd() - 0.4) * s * 0.85,
                (rnd() - 0.5) * s * 0.8,
              )
              mesh.setMatrixAt(i * 3 + j, mm)
            }
          })
          mesh.instanceMatrix.needsUpdate = true
        }
        placeSide(work.buyMesh, -1, (l) => l.buySize, 0)
        placeSide(work.sellMesh, 1, (l) => l.sellSize, n)

        const fallen = work.fallenMesh
        if (!fallen) return
        work.levels.forEach((l, i) => {
          const s = l.fallenSize * Math.min(k, 2.2)
          if (s <= 0) return
          const y = l.priceCents / 100
          const r = outlineRadiusAt(y)
          const mm = new THREE.Matrix4().makeScale(s, s * 0.5, s)
          mm.setPosition(r + 0.1 + s * 0.4, y + 0.12, 0.12)
          fallen.setMatrixAt(i * 3, mm)
          const mm2 = new THREE.Matrix4().makeScale(s * 0.6, s * 0.32, s * 0.6)
          mm2.setPosition(r + 0.2 + s * 0.8, y - 0.1, -0.1)
          fallen.setMatrixAt(i * 3 + 1, mm2)
        })
        fallen.instanceMatrix.needsUpdate = true
        work.twigMesh.instanceMatrix.needsUpdate = true
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
      const labelStep = (span: number) => (span < 6 ? 0.5 : span < 40 ? 1 : span < 130 ? 5 : 10)

      const projV = new THREE.Vector3()
      const updateLabels = () => {
        const rect = canvas.getBoundingClientRect()
        const half = view.span / 2
        const y0 = Math.max(TRUNK_MIN + 0.1, view.camY - half)
        const y1 = Math.min(TRUNK_MAX - 0.1, view.camY + half)
        const step = labelStep(view.span)
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

      // ---------- 交互：滚轮 / 捏合缩放，拖动攀爬，点叶跳明细 ----------
      const pointers = new Map<number, { x: number; y: number }>()
      let pinchDist0 = 1
      let spanAtPinch = 0
      let pinchMidY = 0
      let dragMoved = 0

      const clampView = () => {
        view.span = Math.min(SPAN_MAX, Math.max(SPAN_MIN, view.span))
        view.camY = Math.min(CAM_MAX, Math.max(CAM_MIN, view.camY))
      }
      const panBy = (dyPx: number) => {
        view.camY += dyPx * (view.span / (canvas.clientHeight || 1))
        clampView()
      }
      const zoomBy = (factor: number) => {
        view.span /= factor
        clampView()
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
          panBy(-(e.clientY - prev.y))
        } else if (pointers.size >= 2) {
          const [a, b] = [...pointers.values()]
          const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
          view.span = spanAtPinch * (pinchDist0 / d)
          clampView()
          const midY = (a.y + b.y) / 2
          panBy(pinchMidY - midY)
          pinchMidY = midY
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
        const rect = canvas.getBoundingClientRect()
        ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
        raycaster.setFromCamera(ndc, camera)
        const meshes = [work.buyMesh, work.sellMesh].filter(Boolean) as import('three').InstancedMesh[]
        for (const hit of raycaster.intersectObjects(meshes, false)) {
          const level = work.levels[Math.floor((hit.instanceId ?? -1) / 3)]
          if (level && (level.buyQty > 0 || level.sellQty > 0)) {
            pickRef.current(level.priceCents)
            return
          }
        }
      }

      canvas.addEventListener('wheel', onWheel, { passive: false })
      canvas.addEventListener('pointerdown', onDown)
      canvas.addEventListener('pointermove', onMove)
      canvas.addEventListener('pointerup', onUp)
      canvas.addEventListener('pointercancel', onUp)

      // ---------- 尺寸 / e2e 桥 ----------
      const resize = () => {
        const w = host.clientWidth || 320
        const h = host.clientHeight || 380
        renderer.setSize(w, h, false)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      const ro = new ResizeObserver(resize)
      ro.observe(host)
      resize()
      applyCamera()
      layoutBlobs()
      updateLabels()

      ;(canvas as HTMLCanvasElement & { __tree?: unknown }).__tree = {
        levels: () => levels.map((l) => ({ cents: l.priceCents, buy: l.buyQty, sell: l.sellQty, sold: l.soldQty })),
        span: () => view.span,
        center: () => view.camY,
        zoomBy,
        projectPrice: (cents: number, side: 1 | -1 = 1) => {
          // 投影到叶团位置（描边外表面外 0.85）——e2e 用它定位点击点
          const y = cents / 100
          projV.set(side * (outlineRadiusAt(y) + 0.85), y, 0).project(camera)
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
      const tick = () => {
        raf = requestAnimationFrame(tick)
        if (document.hidden) return
        applyCamera()
        layoutBlobs()
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

        renderer.render(scene, camera)
      }
      tick()

      cleanup = () => {
        cancelAnimationFrame(raf)
        ro.disconnect()
        canvas.removeEventListener('wheel', onWheel)
        canvas.removeEventListener('pointerdown', onDown)
        canvas.removeEventListener('pointermove', onMove)
        canvas.removeEventListener('pointerup', onUp)
        canvas.removeEventListener('pointercancel', onUp)
        delete (canvas as HTMLCanvasElement & { __tree?: unknown }).__tree
        labelHost.remove()
        disposeBlobMeshes()
        barkTex.dispose()
        gradientMap.dispose()
        trunkGeo.dispose()
        outlineGeo.dispose()
        outlineMat.dispose()
        barkMat.dispose()
        for (const set of [...ringSets, ...majorSets]) {
          set.geo.dispose()
          set.mat.dispose()
        }
        groundGeo.dispose()
        groundMat.dispose()
        rootGeo.dispose()
        mossGeo.dispose()
        mossMat.dispose()
        blobGeo.dispose()
        twigGeo.dispose()
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
        <span className="dot buy">待买（回补价）</span>
        <span className="dot sell">待卖（目标价）</span>
        <span className="dot fallen">已卖出</span>
        <span className="hint">滚轮 / 双指缩放 · 拖动攀爬 · 点叶看明细</span>
      </div>
    </div>
  )
}
