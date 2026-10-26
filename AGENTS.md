# AGENTS.md — 接手必读

网格交易台账：本地优先（IndexedDB，无后端），React + Dexie + SheetJS + animal-island-ui。
规则来源是用户的 Excel 台账口径（62 行基准数据钉死在测试里），改口径前先读本文「关键口径」。

## 命令

```bash
npm run dev        # 127.0.0.1:5173
npm test           # vitest，237 条（domain 纯函数 + 真实 xlsx fixture 回归）
npm run lint       # eslint
npm run build      # tsc --noEmit && vite build；GITHUB_PAGES=true 时启用 /EzGridApp/ 子路径 base
node e2e/smoke.mjs http://127.0.0.1:5173   # 无头 Chrome CDP，458 项断言，需先起 dev
                   # 数据种子 = tests/fixtures 经 CDP DOM.setFileInputFiles 塞进上传框（站点不带示例数据）
```

Windows 坑：后台起的 vite 在 TaskStop 后会留僵尸进程占 5173/5174，跑 e2e 前先
`netstat -ano | grep 517` 并 `taskkill //PID <pid> //F`。e2e 里点画布前必须
`scrollIntoView` 再取坐标；概览 V9.41 起已无吸顶块（明细/挂单的 `[data-sticky]` 仍在）。
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
  buildLedger(records, stocks, {executions, plans, extraTargets})
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
| 记录序号 V9.43 | 界面统一叫「第 N 笔」，Excel 行号退成**追溯信息**（只出现在明细抽屉的「Excel 第 N 行」标签、导出 CSV 的「Excel行号」列、导入预览）。序号是**纯派生**（`domain/recordNo.ts`，不落库、不改主键）：按录入时间排序——导入批次取 `batchId = batch:<ts>`、手动行取 `importKey = manual:...:<ts>`，同批/同毫秒按 `sourceRow` 二次排序；老备份没有 `batchId` 的行视为最早。软删除的行仍占号（不重排）；后导入的批次整体追加在已录入数据之后（即使 Excel 行号更小）。`useApp` 暴露 `recordNo: RecordNoIndex`（`of(row)` / `total`），明细卡、抽屉标题、挂单待买/待卖、概览、统计日历、挂钩面板、回本链统一用它；明细排序首项改「录入顺序」，导出第一列「序号」。虚拟行标签：200000 段「回补批次」、300000 段「模拟批次」 |
| E 列双义 | `targetPriceCents` 既是持仓的待卖目标价、也是已成交行的成交价（D1） |
| 待卖 R1 | 批次剩余 × E；手动拆分目标（extraTargets）先占额度，超剩余截断并标 anomaly |
| 待买 R2 | 只认 P 列 `earlyBuyPriceCents`；`rebuyStatus`: pending/repaid；`exposure` = 卖出无买入批次（真空头）。**V9.47.1 例外（用户口径）**：先卖后买**允许卖出日期早于买入日期**，闭环只看份额——`sellDate ≤ buyDate` 且本行有买入批次时，`ownLotCoverQty = min(批次量, 卖出量)` 那截就是回补本身，`rebuyStatus` 按 `卖出量 − ownLotCoverQty` 决定，待买单只挂没买回来的差额（同日买卖也算先卖后买：A股 T+1 当日买的不能当日卖；卖出日期空着 → 无法判序，保守地保留整张单）。先买后卖（买入日更早）不受影响，P 列仍是「下一轮打算什么价买回」。老 fixture 里没有「既有批次又填 P 列」的行，所以 BASELINE 的 rebuyCount=4 / exposureQty=2000 不变 |
| 回补价 R3 | 手填 > 关联买入价 > 卖出价−该股间隔（`manual.ts` deriveRebuyPrice） |
| 奖励 R4/R5 | 组池 key = `股票\|成本分`（**V9.32 起单一账户**，原来的 `账户\|` 前缀已删）；gross=全部真实卖出盈利；容量=floor((gross−used)/每手成本)；FIFO 授给最早还能买的单；`doneRewardQty` 已成交不可撤；used 按成交时价组永久归属（P4）。另有检查「Σ已买回的奖励手数 ≤ Σ组容量」（V9.33）：容量被挂钩/改数缩水到装不下已买回奖励时亮黄灯。已全部回补的单子不再领新奖励。老库/老备份的成交键带 `acc:xxx\|` 前缀——`ledger.ts` 的 `stripAccountPrefix` 统一剥掉（只改派生副本） |
| 回补成交 R6 | 记成交 → **自动生成回补批次**（v9.20 用户决策 B，取代旧 D5「不新增批次」）：虚拟批次不落库、撤销成交即消失；目标价 = 成交价 + 该股间隔，自动出现在待卖清单/价格树；缺间隔配置 → 待补价格异常。id 形如 `lot:exec:*`，sourceRow 用 200000+ 段位避开 Excel/手动行号；明细页看不到该行（它不是 record），挂单/树/概览都可见 |
| 先卖后买挂钩 H | V9.26（2026-10-25 决策 E）：裸卖（无批次卖出）**人工指定**挂到一只或多只**未卖的高位批次**，合计股数 = 卖出量（`hedges` 表 `hedge:<sellRow>`，Dexie v6）。**纯派生**（ledger.ts）：活跃 = 裸卖未回补——被挂份额退出待卖、按（卖价−买价）暂记负盈利挂到批次行（synthetic sell `sell:hedged:*`，`hedgedFromSellRow` 标记，不重复计卖出量/金额/笔数、不进组池）；裸卖自身盈利暂缓（`hedgedHold`，profitCents null）；敞口按差额计（挂住的股已交割）。**记回补成交 → 买回那截永久了结（V9.36 用户拍板）**：被挂份额按卖出价兑现（synthetic sell `sell:closed:*` + `hedgeClosed`），批次**不再复活**、退出待卖，亏损留在合计盈利里；回补批次成为唯一实盘批次。撤销成交 / 删掉回补又自动回到「挂住」状态——不写任何解除记录。一直不买回 = 暂记负盈利即真实亏损（计入合计盈利）。候选批次限定：同股票、真实未卖出、有剩余、扣除其它活跃挂钩占用；超挂截断（hedgeOverflow）、挂不满（hedgeMismatch）、挂错行（hedgeInvalid）都标异常。**UI（V9.30）**：绑定面板抽成 `components/HedgeBinder.tsx`（逻辑 + 校验 + 保存/解除），两处部署——明细抽屉内联、行上标签点开的 `HedgeSheet` 弹层；入口标签 「裸卖待挂钩」/「已挂钩 · 改挂」（明细行 `[data-hedge=<row>]`、挂单页待买行 `.hedge-entry`）；能不能挂统一走 `domain/hedge.ts` 的 `isHedgeable(rec, execQty)`（V9.32：**不看有没有待买订单**，没填 P 列的裸卖也有入口）。挂单页判断可挂**不能看 `o.exposure`**（全额挂住后它已置否），要看「记录没买入价 + soldQty>0 + execQty=0」。面板默认只列**高位买单**（买价 > 卖价，挂上去才是亏损），可切「显示全部」；行上按买价降序、列表自己滚（max-height 42vh），底部固定「已分配 x/y 股 · 记亏 ¥z」+ 保存/解除。**V9.32 修 bug**：`cap` 原来写的是 `remainingQty − used`，而 `remainingQty` 在前面每挂一条时已经扣过 → 同一批次被两张裸卖挂时第二张可用量被重复扣减（500 股挂 200+300 只挂上 300）。现在 `cap` 直接用当前 `remainingQty`，`hedge.spec.ts` 有对应用例。**V9.33/V9.36 部分买回**：可挂量按「还没买回 = 卖出量 − 已回补」算；已买回那截永久了结（份额不再回来），剩下继续挂着；被挂那部分不再按 P 列算盈利（整笔挂住才是 `hedgedHold` + profit null，行上显示「暂缓」）。挂钩按 `at` 先后应用（先挂先占）。`exposureExecBaseQty` 改成按「记录是不是裸卖」判定（部分买回 + 剩余全挂住时 exposure 已置否，但买回那截仍是空头回补基础股）。新增检查「Σ已买回的奖励手数 ≤ Σ组容量」（`doneRewardQty` 折手，容量按组池，池没了按 0 → 缩水会亮黄灯）。面板：异常红条（`hedgeInvalid/Overflow/Mismatch` 就地显示）、缺成交价拦保存、可切「允许挂不满」、一键「自动挂满」、清空=解除。**V9.36 回本链**（`ledger.repairChains` + `components/RepairChainCard.tsx`）：了结时的亏损 Σ(卖价−成本)×股数 记在 `chain:<锚行>` 上，回补价差 Σ(卖价−回补价)×股数 逐轮累加为 `recoveredCents`；`effectiveCostCents`（成本 − 回血/股）与 `gapCents`（还差多少，归零 = `done`）给界面用。**回血不进「已实现盈利」**——回补批次的成本本来就是回补价，再记一次等于双算。界面：明细行标「高位已了结 · 还差 ¥x」、抽屉与概览渲染进度卡（`[data-testid="chain-section"]` / `overview-chains`）——**这套 V9.36 口径已在 V9.46 整体重写，见下一行**。`exposureExecBaseQty` 再改一次：已了结那截不再扣（批次份额已不在待卖，没有双算） |
| 回本链 V9.46 | **主口径**：一条链的累计盈亏 = 最初高位卖出的亏损 + **归属于它的后续买卖已实现净盈利**。链在**亏着清仓那笔成交当场成立**（`domain/chain.ts` 的 `collectSeeds`：真实批次 `remainingQty === 0` 且按成本算出亏损 `< 0`；来源两种——`hedgeClosed` 的合成卖出、正常卖出把批次卖光），一直不买回亏损也留在账上。**只累计已完成的买卖**：买回后还没卖出 → 只进「当前持仓」，不算回本；**回补节省**（Σ(高位卖价 − 回补价) × 股数，`RepairBranch.savingCents`）**只展示、绝不计入进度**——「卖 7 买 5 省的 1000」和「5 买 7 卖赚的 1000」一起算，界面会显示已回本而现金仍少 500（用户明确要求，别改回去）。字段：`lossCents` 原始亏损 / `profitCents` 后续净盈利（= Σ归属交易已实现盈利，含回补虚拟批次**后来卖出**那截，走 `branchOf()`）/ `netCents = loss + profit` / `gapCents = max(0, −net)` / `done = net >= 0` / `covered ∈ [0,1]`（进度条宽）/ `holdingQty`（Σ分支剩余）/ `plannedQty = max(0, 锚点股数 − Σ分支股数)` / `unallocatedLossCents`。**每份盈亏只归属一次**：`chainLinks` 的 memberRows 收编独立交易，`chain.ts` 把亏损按股数摊到各分支（`raw = round(loss × 分支股数 / 锚点股数)`，夹在 `[loss, 0]` 防超分）得 `netCents = 分摊亏损 + 已实现盈利`；**全局「已实现盈利」仍每笔只算一次**（`ledger.totals` 不动，链卡只展示归属）。**归属可人工指定 / 自动继承**：`components/ChainBinder.tsx` 在锚点抽屉里勾选同股票真实批次 → `setChainMembers`（一笔只进一条链，抢占时从旧链移出）；「＋ 新增一笔归入本链」由 `TradesPage.startAddIntoChain` 记 `pendingChainAnchor`，落库后立刻并进 memberRows。用户「结束这条链」写 `closedAt`（历史与归属都留着，之后再做的算独立交易）、「重新打开」清掉。**只存关联**：`chainLinks` 表 `chainlink:<锚行>`（Dexie v9、备份 schemaVersion 9、`validateBackup.checkChainLinks`），records 一分不动、派生每次重算；审计 `entity: 'chain'`。界面：`RepairChainCard` 四个数字（原始亏损 / 后续净盈利 / 链累计盈亏 / 还差多少）+ 进度条 +「当前持有 x 股 · 计划再买回 y 股」+ 分支列表（`本笔回本` 标签、回补批次那支标「回补批次」、节省额单独一行并注明不计入）；明细行 `TradeItem` 加 `data-chain="anchor|member"`（标签「回本链 · 还差 ¥x」/「已回本」/「归入回本链」），**锚点与归属行不再被默认 hideDone 隐藏**（还欠着账不算完成 → 62 行里可见从 33 变 35，e2e 已钉）；概览只渲染未结束且未回本的链（`overview-chains`），已结束/已回本的折成一行提示（`overview-chains-closed`）。单测 `domain/chain.spec.ts`（13 条，含用户「10 买 7 卖 / 5 买 7 卖」的例子与回补节省），e2e `[10]`/`[11]` 覆盖建链 → 归属 → 撤销 → 结束 → 重开 |
| 守恒式 R7 | `Σ待卖 − 待补敞口 − 空头回补基础股 = 净持仓`；`净持仓 = Σ买入(含回补批次) − Σ卖出`。空头回补基础股 = 空头单成交里 (qty−rewardQty) 部分——既抵了敞口又以批次进了待卖，扣回防双算 |
| 导入幂等 | v9.20 决策 C：`domain/importPlan.ts` 按行身份（股票+买入日期+买入价+有效份额，D 列派生值折算）匹配——同 key 跳过、身份命中则**更新卖出侧字段**（importKey/nanoId 不变）、身份对不上才新增。审计走 import-update 来源。改这个逻辑先跑 `importPlan.spec.ts` |
| 账户 | **V9.32 已删除**（只按一个账户做）：没有 accounts 表/账户筛选/顶部选择器，`records` 就是全部数据；`accounts` 表在 Dexie v7 里整表丢弃，老备份带 `accounts` 段直接忽略（schemaVersion 7） |
| 合并同价买单 V9.45 | **只做关联，不改数据**：明细抽屉里几笔**同股票、同买入价、还没卖完**的批次可以勾选合并（`merges` 表 `merge:<锚行号>`，Dexie v8）；`records` 各自的数量/买入日期一分不动。挂单页「待卖」（今日挂单 + 常驻待卖 + 复制清单 + CSV）按 `domain/merge.ts` 的 `mergeTargetRows` 合并显示：**数量/金额/预期盈利相加，日期取组内最早买入日**，`data-merge-group` 标合并行、点击跳最早那笔。组合并条件是**还有 ≥2 笔在卖**（有剩余、未删除、买入价仍一致）——卖到只剩一笔自动散开，但关联保留（回补/恢复后又能合上）；目标价不同的（手动拆过）不跨价合并。计划价：优先读 `plan:<merge:<组>@<价>>`（合并行自己的计划），没有就尝试把成员原有的同价计划数量相加；不同价则不给计划（一张单装不下两个价）。沙盒模拟行永不合并。合并只影响挂单提醒——价格树/概览汇总照旧按原始 targets 算。e2e `[8.1.3]` 用柳工 9.61 的 16/22 行合并成 10.68 × 800、校验最早 2026-03-20 与解除恢复 |
| 下一轮应买 V9.47 | **卖完的老批次也要提醒买**（网格一轮一轮做）：`domain/buyBoard.ts` 的 `buildNextRoundBuyRows` 给每个**卖完的真实批次**（`lot:<行>` 且 `remainingQty === 0`）按**买入价 C 列**排一档应买，数量 = 建仓量（超卖夹到批次量）。用户拍板的三条：价用 C 列（不是「卖出价 − 间隔」）、纳入卖完的批次 + **已回补完**的单（`remainingQty === 0 && execQty > 0`，行上标「回补过一轮」）、同价合并**复用 V9.45 的 merges 组**（组内 ≥2 笔都是卖完候选才合，数量相加、日期取最早、`anchorRow` 跳最早那笔；只剩一笔自动散开，关联不动）。**还没回补完的行直接跳过**——那张 P 列待买单已经在提醒、价位还不一样，并列会把同一笔钱提示两遍。回补虚拟批次（`lot:exec:*`）与沙盒行不参与。**纯展示、不碰账**：不进 `ledger.orders` / 待买剩余金额 / 组池奖励 / 守恒式 / records，所以 baseline 与单测数都不受影响；`key` 是 `buy:<行>` / `buy:merge:<组 id>`（只活在内存，不落库、不是 ID 前缀约定的一部分）。界面（`OrdersPage`）：今日挂单的「可挂买」把区间内档位并进来（组标签注「含已完成批次 N 条」，越界计数 `outCount` 也算它），待买卡下方常驻 `[data-testid="next-round-buy"]` 小节列全部档（行 `[data-buy-level=<锚行>]`、`data-merge-group`、蓝「下一轮」标签、**不给「记成交」**——它不是一张待买单）；复制清单加「【今日可挂买 · 已完成批次下一轮】」，CSV 加类型「应买（下一轮）」。**顺带修**：点这些行跳明细会落到「已完成」行，而明细默认 `hideDone` 把它藏掉 → 深链落空；`TradesPage` 现在对 `idFilter` 命中的那一行豁免 hideDone（与软删豁免同一思路）。e2e `[8]` 钉了小节存在、档数 ≥5、并入可挂买、R60-63 不重复提示、无「记成交」、深链恰好命中 1 行 |
| 计划价 P8 | plans 只影响展示/导出，永不参与计算 |
| 软删除 | `deletedAt` 非空的行不参与一切派生；导入幂等按 importKey，同 key 不覆盖 |
| 基准 | `defaults.ts` BASELINE 只对「26年网格记录」fixture 成立，金额 ±1 元容差（E 列三位小数取整）；改任何派生逻辑跑 `io/baseline.spec.ts` 是红线 |
| 价格树 | **逻辑层** `TreeTrunk.tsx`（数据聚合 aggregate → groupLevels、视野/交互/命中/hover 预览/e2e 桥/风格注册切换）+ **样式层** `treeStyleAtlas.ts`（图鉴素雅风：细锥双线干+淡水彩、统一弧线枝、干上泡牌价签、单行衬线注记）、`treeStyleSketch.ts`（手绘抖动风，V9.18~21 存档：木色粗干+树皮排线+树轮+装饰叶+云+沸腾）与 `treeStyleAxis.ts`（数轴风，**V9.25 起默认**：弃树意象，Apple 简约；V9.25.3 丰满化——冷白微渐变底+整步淡网格骨架、发丝轴两端渐隐、渐变枝+光环软投影端点、轴对侧价位 chip、hover 整行色带（TreeFrame.hover 由逻辑层传入）。V9.23：滚轮/捏合缩放**锚定指针**（`zoomToSpan`；桥 `zoomBy` 保持正中缩放旧语义）；图例按钮循环切三风格（数轴→图鉴→手绘），偏好存 localStorage `ezgrid.treeStyle`（不落台账库）。V9.25：**点击传价格区间**（TreePick lo~hi 分）——单档跳 `price=`、聚合组跳 `priceLo/priceHi`（明细页四个价格字段 OR 落区间即命中，与精确 price 同口径）；hover 预览 V9.26.2 已按用户要求移除（点击跳转保留，热区=拾取圆+注记文字）。聚合档数展示：数轴风=**枝上垂直刻线**（一道=一档，封顶 8 道，V9.26.2 取代「·N档」文字）、图鉴风=枝上小点、手绘风=叶。合并粒度由风格 `cardRowPx`（图鉴/数轴 27、手绘 34）按缩放推算——放大时聚合枝自动分散回原档位数；注记 买/卖 价×份额、已成交「已盈利±¥xx」=该价位 soldProfitCents 合计；e2e 桥 `canvas.__tree`：levels/span/center/panX/panXBy/setView/pickAt/zoomBy/projectPrice/**style**（projectPrice 返回所在合并组的 repCents——点击跳的是组内代表档）。命中检测 = 拾取圆（圆心距离最近者胜）+ 枝梢注记文字热区（`bin.note`，数轴风），等距才按 待卖→待买→已成交。**V9.31 数轴改「格子进度条」**（用户拍板）：待买/待卖不再画枝线，改成**一格 = 一档**的小方格进度条（`CELL`5px / `CELL_GAP`1.5 / `CELL_MAX`8），聚合几档就长几格、由内向外逐格变淡；注记（买/卖 价×份额）一律排在格子**外侧**，且**先量注记宽度再定格子数**（`room`），塞不下的档数紧跟格子标「+N」（`BranchBin.over`）——绝不允许文字压格子；轴对侧价位 chip 已删，刻度数字改成**骑在轴上**（10px 淡灰 + 纸色挖穿），两侧留 `AXIS_HALF`16px 通道。已成交保持灰短枝+圆点不变，注记追加「卖出 N 次」（`BranchBin.times` = 组内 soldCount 之和）。概览树加**年份限制**：年份来自 `ledger.sells` 的卖出日期，Select 放图例条，**只筛已成交**（待买/待卖是当前挂单，不随年份消失），空值默认「全部」。e2e 桥新增 `bins()`（count/over/times）与 `year()` |
| 理想可卖到 | **V9.29 用户拍板：由金额改股价** = 该股待卖里的**最高目标价**（`StockSummary.targetMaxPriceCents`，派生自 `targets`，无待卖为 null；口径只在 `ledger.ts` summarizeByStock，`baseline.spec.ts` 钉了柳工 ¥11.48）。含义 = 股价涨到这里待卖全部出清。数轴风画**琥珀点线**横贯 + 左下 chip（`TreeFrame.idealCents`，与昨收紫虚线并列的两条参考线），图鉴/手绘风没有价格刻度 → 退回画布左上角只读角标。只做展示，不参与任何计算 |
| 手动新增 / 编辑（V9.35） | 日期解析**收 `-` `/` `.` 与全角斜杠、月日可一位数**（`edit.ts: isoToSerial`），输出永远补零成 YYYY-MM-DD；新增一笔打开时**日期默认今天**、股票默认当前筛选。
先卖后买的行抽屉页脚多一个**「补买入」**：一键把买入价=回补价（P 列）、买入份额=卖出量、买入日期=今天填好再进编辑；**普通「编辑」绝不预填买入侧**——只想改卖出侧的人不该因为保存把买入写进台账（当初做成自动预填，e2e 里改一行目标价就把整行变成批次、连带盈利/敞口全变）。新增卖出的「回补价」placeholder 直接显示推导值（卖出价 − 该股间隔），「目标售价」显示买入价 + 间隔；日期字段旁有「今天」快捷键 |

| UI 基础控件 V9.38 | **下拉**用 `ui/Select.tsx`（不用组件库的 Select：库面板横向浮在触发框右侧，390 宽下两侧都出屏）。面板在触发框正下方就地展开，下方不够向上翻转，左右按 `getBoundingClientRect` 夹进视口，`max-height` 取可用空间并自己滚；触发器保留 `role="combobox"`、选项 `role="option"`（e2e 靠这个选股票/年份）。**日期**用 `ui/DateField.tsx`：手输框（认 `- / .` 与全角斜杠）+ 日历按钮唤起原生 `input[type=date]`（`showPicker()`，失败退回 focus），选完按 ISO 回填；日历按钮 `preventDefault` 防止 `<label>` 激活抢焦点。明细抽屉编辑与新增一笔的日期格都用它 |
| 沙盒模式 V9.39 | **只预览、不写库**：挂单页右上「沙盒」开关（`[data-sandbox-toggle]`）；打开后 `sandboxLedger = buildLedger(真实 records + 模拟 records, 真实 hedges + 模拟 hedges)`，自动派生的待买/待卖也一起进预览。模拟条目在 `domain/sandbox.ts` 的 `SandboxState.items`（**内存态**，刷新/恢复备份/清库即清空），预览行号从 `SANDBOX_ROW_BASE = 300000` 起；`kind:'sell'` = 模拟待买（先卖后买：成交价 + P），`kind:'buy'` = 模拟待卖（假设买入：买入价 + 目标价，目标价空按间隔推）。「＋ 模拟待买 / ＋ 模拟待卖」弹窗默认昨收价、昨收 ± 该股间隔、100 股、今天；模拟行紫色虚线（`.line.sandbox-row` / `.sandbox-mark`）、不可跳明细。**模拟挂钩**复用 `HedgeBinder mode="sandbox"`（标题「沙盒挂钩预演」），可挂真实未卖批次或模拟批次，结果立即反映到挂单页四项指标与概览横幅（`[data-testid="sandbox-banner"]`：已实现盈利 / 理想可卖到 / 理想剩余可赚的真实 → 预览差值）；价格树用 `<TreeTrunk ledger={viewLedger}>` 重画、`__tree.ideal()` 跟着变。**记为成交**：`commitSandboxItem` 把该条转成真实手动记录（100000 段）写明细；挂着模拟批次时先一起转正（通知里 `committed > 1`），再用真实行号写 `hedge:<newRow>` + 审计「沙盒挂钩转正」，写完必须 `setHedges` 同步内存。模拟条目不进备份、不写 audit；清空模拟/退出沙盒只动内存。e2e 覆盖「未挂 +250 → 挂钩 10.89 批次 −1,945 / 最高卖价 11.48→11.38 → 记为成交 100001 → 刷新清空」 |
| 编辑抽屉滚动 / 输入法 V9.40 | **抽屉打开会丢滚动位置**：animal-island-ui `Drawer` 打开时给 body 写 `overflow:hidden`，而页面是普通文档流（`.app` 只有 `min-height:100%`）——文档高度塌成一屏，窗口 `scrollY` 被浏览器清零，关掉后也回不去。`TradesPage` 在 `open()` 里先记 `window.scrollY`，抽屉**真正关闭**（`current === null`，不是 `openRow`——行被筛掉时抽屉也会关）后一帧 `scrollTo` 补回来。**输入法避让**：`ui/viewport.ts` 的 `useKeyboardInset(open)` 监听 `visualViewport`，把键盘高度写进 `--kb-inset`、可见高写进 `--kb-vh`、面板高写进 `--ed-h`；Drawer 的 `height` prop 传 `var(--ed-h, 84vh)`（内联样式支持 CSS 变量），`styles.css` 的 `.trades-edit-drawer` 用 `bottom: var(--kb-inset)` + `max-height: calc(var(--kb-vh) - 8px)`，键盘弹出时面板整体抬到键盘上沿、高度收进可见区；`.animal-body` 的 `scroll-padding-bottom` 保证聚焦最下面几行时输入框不被页脚挡住。e2e `[7.2]` 用 `Object.defineProperty(visualViewport, 'height')` 模拟键盘并断言面板几何与滚动复原 |
| PWA 更新 V9.40 | `vite.config.ts` 的 `registerType` 从 `autoUpdate` 改成 `prompt`：**新版本只提示、绝不自动 reload**（旧 autoUpdate 在部署后强制刷新页面，编辑到一半会丢弹窗和滚动位置）。`main.tsx` 的 `onNeedRefresh` 只弹「手动刷新页面后生效」，每小时 `reg.update()` 照旧检查。用户手动刷新后新 SW 才接管。**别改回 autoUpdate**——用户明确要求「数据更新后只有在手动刷新时才更新页面数据」 |
| 布局 V9.41 | **删全局「网格交易」header**（`App.tsx` 不再渲染 `.app-header`，`--header-h` 只剩 `env(safe-area-inset-top)`；`.app-main` 自己让出状态栏安全区）。**概览首屏重排**：股票 tab 置顶（原「选股 · 当前股票汇总」标题行删除）；树上方只留高频四项（已实现盈利 / 理想可卖到 / 理想剩余可赚 / 今年共卖），树用 `height: calc(100dvh − --nav-h − 20px − safe-top)` 铺到导航上沿（390×844 画布实测 568px）；可卖/待补/净持仓/已实现 + 回本链下移到树下方，全局三格/标签等低频内容继续往下，必须滚动才看得到。**统计 · 成交日历**当日明细行首加红框「卖出」chip（`.side-chip.sell`），成本文案改「买入成本」（日历只按卖出日归集） |
| 挂单吸顶 V9.42 / V9.44 | 下滑超过 96px 把挂单页吸顶块（标题 + 沙盒面板 + 选股/昨收/涨跌停设置）收成**一行摘要**（`[data-testid="orders-compact"]`：股票 · 昨收 · 涨停 · 跌停 · 沙盒标记），回顶 24px 内恢复完整布局。阈值带回差 + rAF 节流；摘要只读，切股/改价要回顶（点摘要平滑回顶）。**V9.44 修「顶部抽搐闪烁」**：根因是收放直接 `display:none` 改文档高度，浏览器滚动锚定把 `scrollY` 补偿回阈值内 → 收→放→收 连环触发。现在 ①`html, body { overflow-anchor: none }` 关掉锚定；②摘要常驻 DOM、设置块不再 `hidden`，用 `.orders-compact-slot` / `.orders-setup-collapse` 的 `grid-template-rows: 0fr↔1fr`（`--dur-3`）连续收放，摘要淡入 + 上移 4px，`visibility` 过渡隐藏不可点；③滚动监听走 rAF，收放期间不会被打断。e2e `[8.1.2]` 钉了收起高度 44px、摘要可见性/内容、仍吸顶、回顶复原与昨收保留，并新增抖动检查（0→300→0 小步滚动时 `is-compact` 翻转 ≤3 次、`landed === 300`） |
| 管理页入口 V9.44 | 管理页从「一排 tab」改成**按钮入口**：`ManagePage` 先渲染 4 个 `.manage-item`（`[data-manage-entry]` = stocks / import / checks / backup，带图标 + 名称 + 一句说明），点进去才渲染对应分区，顶部 `.manage-bar` 有「‹ 管理」返回按钮（`[data-testid="manage-back"]`）。不再用 `Tabs`；离开管理 tab 再回来会回到入口列表（组件卸载，不记忆上次分区）。e2e 里进分区要先点入口、换分区要先点返回——`nav('manage')` 在同 tab 时不会重挂载，别指望它重置 |
| 明细吸顶 V9.42 | **删除明细页搜索框**（原「搜股票名 / 行号」）：连带 `TradesPage` 的 keyword 过滤、搜索条件 chip、URL `q` 参数一起删（`TradesQuery` 不再有 `q`）。下滑超过 96px 把股票 tab / 状态筛选 / 条件 chips 整块用 `.trades-filters[hidden]` 收掉，只留「明细 x / y 行」标题（吸顶高 42px）；回到 24px 内恢复。排序 / 导出 / 新增仍在那张卡里，随页面自然滚走，回顶一起回来。e2e `[6.1]` 钉了搜索框不存在、收起与恢复、排序离开视野、标题仍吸顶 |
| 动效 V9.37 | 统一缓动 `--ease-soft / --ease-back` + 三档时长（`--dur-1/2/3`）；只动 transform / opacity / 色彩，不动 layout（唯一例外是删除那一行用 max-height 收高度）。**切页带方向**：`.app-main[data-dir=forward\|back]` → `page-in-forward / page-in-back`，方向由 App.tsx 比较 tab 序号得出。**明细行三态**用 `data-anim` 属性驱动（样式在 styles.css）：`new` = 新增落位 + 微光（承接「弹窗收成一条明细」）、`leaving` = 删除向右滑出并收高度（**先播 300ms 动画再真删**，别直接消失）、`done` = 刚完成洗一层青。通用 hook：`ui/motion.ts` 的 `useFlashOnAppear(keys)`（首帧不闪、依赖用 key 签名避免每帧重跑）。底部导航短横线常驻 + scaleX 过渡、图标弹跳；挂单页回补成交的那行同样会闪。`prefers-reduced-motion: reduce` 时全部退化为瞬切。 |

## 弹窗默认值 V9.48

- 有明确数值/日期默认值的输入留空（含纯空格）时，保存使用框内默认值；手填非空值优先，非法值和显式 0 仍走原校验，不能悄悄回退。
- 新增一笔：`domain/formDefaults.ts` 的 `manualFormDefaults` 同时提供 placeholder 与提交默认值，`resolveManualForm` 仅用于新增。买入默认 8.01 元、卖出默认 8.58 元、700 股、日期今天；目标/回补价按实际采用的价格和该股间隔派生，回补价优先关联买入价。可选买入信息全部空白时**不生成买入批次**，开始填写任一项后，其余项默认 8.30 元 / 本次卖出数量 / 今天。
- 普通编辑里的「元、股数、YYYY-MM-DD」仅为格式提示，清空字段继续表示清空；不得给普通编辑补买入默认值。
- 拆分目标默认当前批次目标价/剩余量；挂单计划默认建议价/待买剩余量或待卖量；回补成交默认回补价/剩余量/未成交奖励量（明确填 0 表示不买奖励股）。
- 沙盒默认昨收价（未确认昨收时 8.10）/100 股/今天，目标或回补价空白按当前实际采用价格与间隔推导。新增股票间隔空白默认 0.57 元；股票名称与股票选择仍须明确指定。
- 日期编辑占位统一用格式文字，新增与沙盒才显示今天；不要再把固定历史日期作为默认值提示。8 条 `formDefaults.spec.ts` 和 e2e 留空提交后的 IndexedDB 只读核验覆盖此行为。

## ID 前缀约定

`stock:` `lot:<row>` `sell:<row>` `target:<lot|extraId>` `rb:sell:<row>` `exec:<orderId>:<ts>`
`et:<lotId>:<ts>` `plan:<refId>` `batch:<ts>` `hedge:<sellRow>`（V9.26）
`merge:<锚行号>`（V9.45 同价买单合并组；`merge:<组 id>@<目标价分>` 是合并行的计划 ref）
`chainlink:<锚行号>`（V9.46 回本链归属，只存 memberRows + closedAt；派生链 id 是 `chain:<锚行号>`，不落库）
`sandbox:<seq>:<ts>`（V9.39 仅预览；预览行号 = 300000 + seq，绝不落库）。备份
schemaVersion 9（V9.46 加 chainLinks；V9.45 加 merges；V9.32 去掉 accounts）。`validateBackup` 现在逐表校验 records / stocks / 回补成交 / 计划 / 拆分目标 / **挂钩** / **合并组** / **回本链归属**（V9.32 起；之前只查前两张，`hedges: [{}]` 能过校验、恢复后 `for..of h.items` 直接白屏）。Dexie schema 改动必须递增 `db.ts` 里的 version()（老库
自动升级，不写迁移）。

## 已知取舍 / 已知坑（设计如此，别当 bug 修）

- 回补批次是虚拟批次：明细页没有对应行、不能行内编辑；要改买入日期/价格只能撤销成交重记。
  虚拟批次 sourceRow 从 200000 起，手动行从 100000 起——两者都逼近时先扩段位。
- 导入身份匹配会把「同股+同买入日期+同买入价+同份额」的多笔按次序配对；Excel 里买侧信息
  改了任何一项才会新增并存行（这是有意的：买侧变了就是另一批买入）。
- 超卖（soldQty > 批次量）会标 `oversell` 异常（v9.20 起），守恒式也会红灯。
- 日期列只接受 ≥20000 的序列号（1954 年后）与合法日期文本；价格误入日期列按缺失处理。
- 概览底部「数据只存在本机浏览器」：长期不打开 IndexedDB 可能被浏览器清理，靠每周导出备份兜底。
- **沙盒是纯内存态**（V9.39）：切 tab 不丢，但刷新页面 / 恢复备份 / 清空数据库都会清掉；模拟条目
  不进备份、不写 auditLogs、不进明细，只有每行「记为成交」才真正写库。这是用户要的「不生效，仅供预览」。
- **回本链不会自己长**（V9.46）：只有**人工归进这条链**（或从链上「＋ 新增一笔」）的交易才算进度，
  同股票的其它低位买卖照旧独立统计——链显示「还差 ¥x」不代表没赚钱，代表这些钱没被归属过来。
  回补价差（savingCents）永远只是展示数字，不参与任何结算。
- **animal-island-ui 的 `Tag` 不透传 `data-*`**（只透传 className/style/onClick/size 等声明过的 prop）：
  给 Tag 加 `data-xxx` 在 DOM 上找不到。e2e 对沙盒挂钩标签用 `.hedge-entry`；普通 div 行上的
  `[data-sandbox-row]` 不受影响。

## 设计决定记录（2026-10-24 用户拍板，接手 agent 不要擅自推翻）

- **A 组池账户维度**：~~加~~ → **V9.32 撤销**：账户功能整体删除，键回到 `股票|成本分`，老键前缀自动剥掉。
- **B 回补建批次**：自动建。回补成交派生虚拟批次（目标价=成交价+间隔）回到待卖清单，
  取代旧 D5「不新增批次」。守恒式相应改为「Σ待卖 − 待补 − 空头回补基础股 = 净持仓」。
- **C 导入幂等**：提交时按行身份匹配更新卖出侧字段（importPlan.ts），不改 importKey 本身
  （nanoId/深链保持稳定）。
- **D 小缺陷批次**：已修——日历「今天」用本地时区、记成交文案区分敞口/批次、超卖标异常、
  日期列序列号阈值 20000。**V9.38 起删除「载入内置示例」**：`public/demo/26年网格记录.xlsx`
  是真实台账，不再随站点发布；e2e 改用 `tests/fixtures` 本地塞文件。
- **E 先卖后买挂钩**（2026-10-25 拍板，V9.26）：裸卖须**手动指定**挂到未卖的高位批次
  （可多笔、合计=卖出量）；挂着的批次按（卖价−买价）暂记负盈利并退出待卖，裸卖盈利暂缓；
  ~~记回补成交即自动复原~~ → **V9.36 改为「买回那截永久了结」**（批次不复活、亏损留在合计盈利里，
  撤销成交才回到挂住状态）；一直不买回才视为真实亏损。全部纯派生，不存解除状态。
- **F 回本链口径**（2026-10-26 拍板，V9.46）：链在**首次亏损卖出成交时**建立（一直不买回，亏损也留在账上）；
  进度**只累计已完成的买卖净盈利**，回补价差（卖 7 买 5 省下的钱）**只显示不计入**——两条一起算会出现
  「界面显示已回本、现金仍少 500」；买回没卖出的部分只算持仓。独立录入的交易**人工指定归属**、
  从链上发起的**自动继承**，**每份盈亏只归属一次**；全局「已实现盈利」每笔只算一次，链卡不再重复加一遍。
  界面固定四个数：原始亏损、后续净盈利、合计还差多少、当前实际持仓。
- **G 先卖后买看份额不看日期**（2026-10-26 拍板，V9.47.1）：卖出日期早于买入日期是**合法记法**，不是数据错误；
  只要本行买入份额盖得住卖出份额，就视为已回补 = 已完成（撤掉待买单、不再标待回补，随即成为 V9.47 的
  下一轮应买档）。别再拿 `sellBeforeBuy` 当异常报，也别为了日期顺序把这类行留在待买里。
