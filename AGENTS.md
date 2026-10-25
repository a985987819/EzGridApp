# AGENTS.md — 接手必读

网格交易台账：本地优先（IndexedDB，无后端），React + Dexie + SheetJS + animal-island-ui。
规则来源是用户的 Excel 台账口径（62 行基准数据钉死在测试里），改口径前先读本文「关键口径」。

## 命令

```bash
npm run dev        # 127.0.0.1:5173
npm test           # vitest，161 条（domain 纯函数 + 真实 xlsx fixture 回归）
npm run lint       # eslint
npm run build      # tsc --noEmit && vite build；GITHUB_PAGES=true 时启用 /EzGridApp/ 子路径 base
node e2e/smoke.mjs http://127.0.0.1:5173   # 无头 Chrome CDP，210 项断言，需先起 dev
```

Windows 坑：后台起的 vite 在 TaskStop 后会留僵尸进程占 5173/5174，跑 e2e 前先
`netstat -ano | grep 517` 并 `taskkill //PID <pid> //F`。e2e 里点画布前必须
`scrollIntoView` + 藏吸顶层（`[data-sticky="overview"]` visibility:hidden），否则 CDP 坐标落空。
Bash 工具提交输出偶尔乱码是控制台代码页显示问题，`git log` 里实际是好的。

部署：push 到 main → GitHub Actions 自动构建发布到
https://a985987819.github.io/EzGridApp/ 。本机没装 gh CLI，用 GitHub API 查 run 状态
（公开仓库免认证）；取日志/重跑可用 `git credential fill` 里的本机凭据（别打印 token）。
Pages 站点已手动创建过（`build_type: workflow`），工作流的 GITHUB_TOKEN 无权建站点——
站点 404 时先查 `has_pages`，别再从 configure-pages 一路试错。

## 架构与数据流

```
Excel/CSV ──io/parseWorkbook──▶ RawRecord（落 IndexedDB records 表）
                                     │
store/useApp（唯一写库入口，全部动作写 auditLogs）
  buildLedger(scopedRecords, stocks, {executions, plans, extraTargets})
                                     │ 纯派生、每次重算、绝不落库
                                     ▼
   Ledger { lots, sells, targets, orders, groups, byStock, daily, monthly,
            anomalies, checks, totals }
                                     ▼
   pages 只消费 Ledger，不持有任何派生状态
```

- `domain/*` 纯函数、无 IO、无 React——所有口径只允许写在这里。
- `store/useApp.tsx` 是唯一写库层；任何数据变更必须走它的 action（自动写审计）。
- pages 里禁止手改派生对象、禁止绕过 store 直接操作 db。

## 关键口径（改动前必读，出处都在 domain/）

| 主题 | 口径 |
| --- | --- |
| 精度 | 一切价格金额整数「分」（`money.ts`），禁浮点判定；`toCents` 非法输入返回 null 绝不 NaN |
| 行身份 | 主键 `sourceRow`（Excel 行号；手动行从 100000 起）；`importKey` = 内容字段 join（P9 幂等键，**内容一变 key 就变**）；`nanoId` = cyrb53(importKey)，明细/跨页跳转的行级 id，撞哈希按行号序加 -2/-3 |
| E 列双义 | `targetPriceCents` 既是持仓的待卖目标价、也是已成交行的成交价（D1） |
| 待卖 R1 | 批次剩余 × E；手动拆分目标（extraTargets）先占额度，超剩余截断并标 anomaly |
| 待买 R2 | 只认 P 列 `earlyBuyPriceCents`；`rebuyStatus`: pending/repaid；`exposure` = 卖出无买入批次（真空头） |
| 回补价 R3 | 手填 > 关联买入价 > 卖出价−该股间隔（`manual.ts` deriveRebuyPrice） |
| 奖励 R4/R5 | 组池 key = `账户\|股票\|成本分`（v9.20 起带账户，'all' 视图不混池）；gross=全部真实卖出盈利；容量=floor((gross−used)/每手成本)；FIFO 授给最早还能买的单；`doneRewardQty` 已成交不可撤；used 按成交时价组永久归属（P4）。已全部回补的单子不再领新奖励。老库存的成交键没有账户前缀——buildLedger 里按所属行归一化（只改派生副本），别当 bug 修 |
| 回补成交 R6 | 记成交 → **自动生成回补批次**（v9.20 用户决策 B，取代旧 D5「不新增批次」）：虚拟批次不落库、撤销成交即消失；目标价 = 成交价 + 该股间隔，自动出现在待卖清单/价格树；缺间隔配置 → 待补价格异常。id 形如 `lot:exec:*`，sourceRow 用 200000+ 段位避开 Excel/手动行号；明细页看不到该行（它不是 record），挂单/树/概览都可见 |
| 先卖后买挂钩 H | V9.26（2026-10-25 决策 E）：裸卖（无批次卖出）**人工指定**挂到一只或多只**未卖的高位批次**，合计股数 = 卖出量（`hedges` 表 `hedge:<sellRow>`，Dexie v6）。**纯派生**（ledger.ts）：活跃 = 裸卖未回补——被挂份额退出待卖、按（卖价−买价）暂记负盈利挂到批次行（synthetic sell `sell:hedged:*`，`hedgedFromSellRow` 标记，不重复计卖出量/金额/笔数、不进组池）；裸卖自身盈利暂缓（`hedgedHold`，profitCents null）；敞口按差额计（挂住的股已交割）。**记回补成交 → 挂钩自动失效**：批次复原、裸卖恢复按 P 列结算、回补批次照常进待卖；撤销成交又自动恢复挂钩——不写任何解除记录。一直不买回 = 暂记负盈利即真实亏损（计入合计盈利）。候选批次限定：同股票、真实未卖出、有剩余、扣除其它活跃挂钩占用；超挂截断（hedgeOverflow）、挂不满（hedgeMismatch）、挂错行（hedgeInvalid）都标异常。编辑入口在明细抽屉「挂钩高位买入」 |
| 守恒式 R7 | `Σ待卖 − 待补敞口 − 空头回补基础股 = 净持仓`；`净持仓 = Σ买入(含回补批次) − Σ卖出`。空头回补基础股 = 空头单成交里 (qty−rewardQty) 部分——既抵了敞口又以批次进了待卖，扣回防双算 |
| 导入幂等 | v9.20 决策 C：`domain/importPlan.ts` 按行身份（股票+买入日期+买入价+有效份额，D 列派生值折算）匹配——同 key 跳过、身份命中则**更新卖出侧字段**（importKey/nanoId 不变）、身份对不上才新增。审计走 import-update 来源。改这个逻辑先跑 `importPlan.spec.ts` |
| 账户 | 筛选只 scope records；executions 全局表，由 buildLedger 按 `sellExecId ∈ 范围内 sells` 过滤（v9.19） |
| 计划价 P8 | plans 只影响展示/导出，永不参与计算 |
| 软删除 | `deletedAt` 非空的行不参与一切派生；导入幂等按 importKey，同 key 不覆盖 |
| 基准 | `defaults.ts` BASELINE 只对「26年网格记录」fixture 成立，金额 ±1 元容差（E 列三位小数取整）；改任何派生逻辑跑 `io/baseline.spec.ts` 是红线 |
| 价格树 | **逻辑层** `TreeTrunk.tsx`（数据聚合 aggregate → groupLevels、视野/交互/命中/hover 预览/e2e 桥/风格注册切换）+ **样式层** `treeStyleAtlas.ts`（图鉴素雅风：细锥双线干+淡水彩、统一弧线枝、干上泡牌价签、单行衬线注记）、`treeStyleSketch.ts`（手绘抖动风，V9.18~21 存档：木色粗干+树皮排线+树轮+装饰叶+云+沸腾）与 `treeStyleAxis.ts`（数轴风，**V9.25 起默认**：弃树意象，Apple 简约；V9.25.3 丰满化——冷白微渐变底+整步淡网格骨架、发丝轴两端渐隐、渐变枝+光环软投影端点、轴对侧价位 chip、hover 整行色带（TreeFrame.hover 由逻辑层传入）。V9.23：滚轮/捏合缩放**锚定指针**（`zoomToSpan`；桥 `zoomBy` 保持正中缩放旧语义）；图例按钮循环切三风格（数轴→图鉴→手绘），偏好存 localStorage `ezgrid.treeStyle`（不落台账库）。V9.25：**点击传价格区间**（TreePick lo~hi 分）——单档跳 `price=`、聚合组跳 `priceLo/priceHi`（明细页四个价格字段 OR 落区间即命中，与精确 price 同口径）；hover 预览 V9.26.2 已按用户要求移除（点击跳转保留，热区=拾取圆+注记文字）。聚合档数展示：数轴风=**枝上垂直刻线**（一道=一档，封顶 8 道，V9.26.2 取代「·N档」文字）、图鉴风=枝上小点、手绘风=叶。合并粒度由风格 `cardRowPx`（图鉴/数轴 27、手绘 34）按缩放推算——放大时聚合枝自动分散回原档位数；注记 买/卖 价×份额、已成交「已盈利±¥xx」=该价位 soldProfitCents 合计；e2e 桥 `canvas.__tree`：levels/span/center/panX/panXBy/setView/pickAt/zoomBy/projectPrice/**style**（projectPrice 返回所在合并组的 repCents——点击跳的是组内代表档）。命中检测 = 拾取圆（圆心距离最近者胜）+ 枝梢注记文字热区（`bin.note`，数轴风），等距才按 待卖→待买→已成交 |

## ID 前缀约定

`stock:` `lot:<row>` `sell:<row>` `target:<lot|extraId>` `rb:sell:<row>` `exec:<orderId>:<ts>`
`et:<lotId>:<ts>` `plan:<refId>` `batch:<ts>` `acc:*` `hedge:<sellRow>`（V9.26）。备份
schemaVersion 6（含 hedges）。Dexie schema 改动必须递增 `db.ts` 里的 version()（老库
自动升级，不写迁移）。

## 已知取舍 / 已知坑（设计如此，别当 bug 修）

- 回补批次是虚拟批次：明细页没有对应行、不能行内编辑；要改买入日期/价格只能撤销成交重记。
  虚拟批次 sourceRow 从 200000 起，手动行从 100000 起——两者都逼近时先扩段位。
- 导入身份匹配会把「同股+同买入日期+同买入价+同份额」的多笔按次序配对；Excel 里买侧信息
  改了任何一项才会新增并存行（这是有意的：买侧变了就是另一批买入）。
- 超卖（soldQty > 批次量）会标 `oversell` 异常（v9.20 起），守恒式也会红灯。
- 日期列只接受 ≥20000 的序列号（1954 年后）与合法日期文本；价格误入日期列按缺失处理。
- 概览底部「数据只存在本机浏览器」：长期不打开 IndexedDB 可能被浏览器清理，靠每周导出备份兜底。

## 设计决定记录（2026-10-24 用户拍板，接手 agent 不要擅自推翻）

- **A 组池账户维度**：加。键 = `账户|股票|成本分`，'all' 视图下不同账户不共享奖励额度。
- **B 回补建批次**：自动建。回补成交派生虚拟批次（目标价=成交价+间隔）回到待卖清单，
  取代旧 D5「不新增批次」。守恒式相应改为「Σ待卖 − 待补 − 空头回补基础股 = 净持仓」。
- **C 导入幂等**：提交时按行身份匹配更新卖出侧字段（importPlan.ts），不改 importKey 本身
  （nanoId/深链保持稳定）。
- **D 小缺陷批次**：已修——示例文件 fetch 用 `import.meta.env.BASE_URL`（Pages 子路径）、
  日历「今天」用本地时区、记成交文案区分敞口/批次、超卖标异常、日期列序列号阈值 20000。
- **E 先卖后买挂钩**（2026-10-25 拍板，V9.26）：裸卖须**手动指定**挂到未卖的高位批次
  （可多笔、合计=卖出量）；挂着的批次按（卖价−买价）暂记负盈利并退出待卖，裸卖盈利暂缓；
  **记回补成交即自动复原**（批次回原目标继续等卖、这笔卖按回补价正常结算，等效无事发生）；
  一直不买回才视为真实亏损。全部纯派生，不存解除状态。
