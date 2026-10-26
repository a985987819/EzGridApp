# AGENTS.md — 接手必读

网格交易台账：本地优先（IndexedDB，无后端），React + Dexie + SheetJS + animal-island-ui。
规则来源是用户的 Excel 台账口径（62 行基准数据钉死在测试里），改口径前先读本文「关键口径」。
**明细/批次/订单的类型体系（每种数据长什么样、进哪些账、界面落点）见 `docs/detail-kinds.md`——理解数据先读它，本文是公式与决策记录。**

## 命令

```bash
npm run dev        # 127.0.0.1:5173
npm test           # vitest，301 条（domain 纯函数 + 真实 xlsx fixture 回归）
npm run lint       # eslint
npm run build      # tsc --noEmit && vite build；GITHUB_PAGES=true 时启用 /EzGridApp/ 子路径 base
node e2e/smoke.mjs http://127.0.0.1:5173   # 无头 Chrome CDP，460 项断言，需先起 dev
                   # 数据种子 = tests/fixtures 经 CDP DOM.setFileInputFiles 塞进上传框（站点不带示例数据）
node e2e/accounting.mjs http://127.0.0.1:5173 # 独立浏览器：真实 IndexedDB、多轮回补/卖出/分链/防重复
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
| 回本链 V9.49 价位槽 | **全自动归属、不落库、不用手动勾**（V9.46 的人工归属退成可选项，`chainLinks` 仍保留）。链之后**同股、同卖出价**的裸卖（先卖后买订单 C/D）自动挂回这条链，按它的 P 列各开一个**价位槽**；之后所有同股、**买入价正好等于该档**的买入（回补成交的虚拟批次、明细新增、导入）自动进槽，盈亏一路累加——用户原话「之后的每个 5 买都自动关联到 10 买 7 卖」。根裸卖的盈利按 P 列（空头回补）算、槽内批次按自己卖出时算，**各算一次不重复**；根的空头收益本身就是回补节省，不再另记 `savingCents`。槽的 `cover` 量直接扣待买单 `baseQty` → 回补完成自动 `repaid`、敞口自动关（用户拍板「不手动关」），会连带影响待买剩余金额 / 组池奖励 / 守恒式输入。`plannedQty` 有槽时只看槽里还欠多少（A/B 视为已完成）；没槽时沿用 V9.46 的「锚点股数 − 已归属买入」。多链共享同一价位 → 归给**锚点卖出日期最近**的那条；锚点批次不被别的链收编；有挂钩合成成交的裸卖走 V9.36 老路。`sell.rebuyPriceCents` 在 ledger 里提前算好（P 列 > 卖出价 − 间隔），链与待买共用同一口径。UI：`RepairBranch.kind='sell'`（`rootSellRow` / `cycles` / `memberRows`），链卡分支行写「7.00 卖 → 5.00 买回 · 卖了 x 次」，完成态文案 **【已不亏钱】**；明细行 `data-chain="branch"` 标「回本链 · 同价回补」并豁免 `hideDone`；挂单页待买行加 `[data-testid="rebuy-of"]`「回补 第 N 笔」+ `rebuy-chain`。单测 `chain.spec.ts` 新增 3 条（用户完整例 → 累计 +500 已不亏钱 / 未回补仍挂单欠 500 / 买入日期早于再卖不归链），baseline 19 条不动 |
| 挂单拆分 V9.50 | **卖单也能拆买**：先卖后买的单子可按价位拆成多笔买入（`buyTargets` 表 `buytarget:<卖单行>:<ts>`，Dexie v10、备份 schemaVersion 11、`validateBackup.checkBuyTargets`），与 V6 的 `extraTargets`（买单拆卖）对称。派生出的 `ledger.buySplits` 是**待买展示档**：没拆 = 整单一条（价 = 计划价 > P 列），拆了按 `at` 顺序分段、组池奖励并到最后一档（成交落档与总量约束见下一行 V9.51.1）；**合计 > 欠量 → 按欠量截断并标 `buyTargetOverflow`**。挂单页「今日挂单 / 可挂买」、买入建议（`buildBuySuggestions` 的输入从 orders 换成 buySplits，同价仍合并成一条）、概览的敞口列表**只认拆出来的档**；记成交按档取价、取量（账务仍是 `RebuyOrder`，orderId 不变，`BuySource.splitKey` 防同一卖单两档被当成重复来源）。编辑锁（用户拍板）：已落库的**买入份额 / 卖出份额只读**（表单 `disabled` + 「成交数量不可改」），只放开对手价（买单改目标售价、卖单改回补价）；「补买入」的空买入侧仍可填。拆出来的档用 `data-split-key` / `data-buy-split` / `[data-testid="buy-split-section"]` 标记，留空回退默认值的规则照旧 |
| 缺陷修复 V9.51.1 | 审查 V9.49/V9.50 时发现的四处口径问题，已修：① **链结束后的交易不再自动归链**——`collectPriceSlots` 拿 `chainLinks.closedAt` 的本地日期做边界，之后再卖 7 / 再买 5 都算独立交易（结束前的历史槽根与已发生的买回照旧生效），`plannedQty` 同时归 0；② **计划量扣已成交**——`slotPending` 只累加「还没买回」的股数，原来把已有回补成交的也算进「计划再买回」；③ **拆分档成交按价格落档**——`buildBuySplits` 先把每笔回补成交落到同价档位（价格对不上才按顺序补），避免 6 元档吞掉 5 元的成交；④ **拆分档总量受 `remainingQty` 约束**——被回本链同价买回盖住的那截不会再挂出来，拆分上限改用「卖出量 − 本行买入」（不是扣完链覆盖的 `baseQty`），链覆盖不再被误报成 `buyTargetOverflow`；⑤ 明细「买入拆分」的上限与账务同口径（`baseQty − 已拆`），「还没回补」显示不含组池奖励。回归：`chain.spec` 加「结束链后不归链」、`regressions.spec` 加「成交按价格落档」，272 条全绿 |
| 挂单改单 / 部分成交 V9.53 | **推荐挂单可以硬改，也可以只成交一部分**。① 买单建议（`buy:` 段）与卖单（`sell:` 段）每行都有「**改单**」按钮（`data-action="suggestion-plan"` / `sell-plan`，原来的「计划」改名），弹窗标题「改这一笔挂单」，价量存 `plans` 表（P8：**永不参与计算**，不回写 records / orders，不动盈亏与守恒式）——只影响这一行显示、今日挂单区间判断、复制清单 / CSV、以及「记成交 / 记卖出」的默认价量。买单建议的 key 是 `buy:股票:派生价`（`buildBuySuggestions` 在合并后统一套用一次计划：`qty = min(建议量, 计划量)`、`priceCents = 计划价`、`edited = true`，行上标「已改单」），所以改价后 key 仍然稳定、不会丢关联；**数量只允许往下夹**（往上会记不进去）。② 部分成交：`记成交` 走 `openExec`（单来源）或 `recordBuySuggestion`（多来源合并），`记卖出` 走 `recordLotSales`，三者都用 `Math.min(left, source.qty)` 按列表顺序分配，成交数量填小一点就是部分成交，剩余继续挂着；弹窗文案已写明「这条挂单 x 股：成交量填小一点就是部分成交」。③ 卖单的计划价量由 `mergeTargetRows` 套用（价 = 计划价、量 = min(来源量, 计划量)），所以挂单页的 `今日可挂卖`/越界判断/金额合计与行显示的 `卖 x × y` 都是改后的口径；待卖总量 / 守恒式仍按 ledger 原始 `targets`（计划不进账）。单测 `regressions.spec`「V9.53 推荐买单可以硬改价量，来源不变且数量不放大」；e2e `[8.2]` 改点 `[data-action="sell-plan"]` |
| 挂单页排序 / 来源展开 V9.54 | **先卖后买的待买排最前 + 默认展开来源**。① 标记：`RebuyOrder.sellFirst` / `BuySplit.sellFirst` / `BuySuggestion.sellFirst` 三层同源，口径写在 `ledger.ts` —— `sell.sellBeforeBuy \|\| ownLotCoverQty > 0`（卖出日早于或等于买入日、或压根没有买入批次的裸卖；先买后卖走 P 列的不算）。② 排序：`buildBuySuggestions` 末尾统一 `sellFirst` 优先、组内仍按价格升序、`key` 兜底稳定——今日挂单「可挂买」、待买卡、复制清单、CSV 一起生效；待买卡「逐笔回补状态与撤销」用稳定排序同口径（`orderedRebuys`），沙盒的 `buyToday` 也一样。③ 标示：买建议行 tag「先卖后买」（`data-testid="suggestion-sell-first"`，行上有 `data-sell-first="1"`），逐笔待买行在 `先卖后买` 与 `空头敞口 / 回补再买入` 之间二选一、敞口仍单独补一个红 tag；来源明细里把 `待回补` 改称 `先卖后买`。④ 推荐的「N 笔来源 · 查看明细」改成 `<details open>` 默认展开。单测 `regressions.spec`「V9.54 先卖后买的待买排最前」5 条。**V9.58 起逐笔回补收进挂单页底部「台账」折叠区，见「挂单页三组 V9.58」** |
| 编辑弹层保滚动 V9.55 | **用户明确要求：所有编辑弹窗都不许改变页面滚动位置**——「改完还要翻回去找太麻烦」。根因：animal-island-ui 的 `Modal` / `Drawer` 打开时给 body 写 `overflow:hidden`，本项目是普通文档流，文档高度当场塌成一屏、`window.scrollY` 被清零，关掉回不到原位。做法：`ui/scrollHold.ts` 的 `useScrollHold(open)`——**用 `useLayoutEffect` 抢在库锁 body 之前记下 `scrollY`**（换成 `useEffect` 就只能记到 0，这个坑别踩），全部弹层关掉后 rAF + 400ms 内最多 5 次重试补回来（库清 `overflow`、文档高度恢复后才滚得动）。**嵌套弹层要传合并后的布尔值**（抽屉里再开弹窗时 body 还锁着，中间那层不许抢着滚）；已被别的弹层锁住时直接沿用已有锚点。已接入：明细抽屉 + 新增弹窗 + 挂钩弹层（`TradesPage`）、记成交 / 改单 / 记回补 / 沙盒 / 两张挂钩弹层（`OrdersPage`）、新增股票（`ManageStocks`）。**以后新增任何 Modal/Drawer 都要接上，别再手写 scrollY**。**V9.57 补「锁定期钉住 body」**：光关后补滚不够——弹层开着的整个期间背景塌成一屏、遮罩底下显示的是页顶（开/关一次背景就跳上去再跳回来），iOS 上 `overflow:hidden` 还挡不住触摸拖遮罩。现在锁住时给 body 上 `position:fixed; top:-Y`（弹层门户都是 fixed 定位不受宿主影响），背景纹丝不动；恢复要**等库清掉 `overflow`** 才摘钉子（钉子挂着时文档高度恒为一屏，`scrollHeight` 判断永远不成立，别用它），**摘钉 + `scrollTo` 必须同一帧**，否则背景闪一下页顶；重入（回滚没落地又开新弹层）时钉子保持、回滚让给下一轮。`styles.css` 给所有 `[class*='animal-body']` 补了 `overscroll-behavior: contain`（原来只有抽屉有，Modal 内滚到头会把滚动链交给文档） |
| 改单撞价合并 V9.55 | **改单把两条待买改到同一个价，要重新合成一条**：数量相加、金额按最终价重算，**来源分开展示**（`sources` 一条不少）。第一层合并按「派生价」（改单前），所以在 `buildBuySuggestions` 套完计划之后又按（股票 + 最终价）归了一次组——`hit.members` 记住成员清单（每条成员原来的行身份 + 它自己那份数量），**行身份优先留「本来就落在这个价」的那条**（`buy:股票:价`），否则沿用第一条，保证计划不丢、不会改完刷新又弹回去。**改单/清除必须按份写回**（`OrdersPage.savePlan`）：合并行的计划价要写到每个成员身份上（同一个价）、数量按份额比例分（每份至少 1 股，`setPlan` 不收 0，合计 = 填的计划量），否则只有半边动、合并行立刻被拆回两行；「清除改单」要把成员的计划一起清掉。待卖那边 `mergeTargetRows` 本来就在套完计划后按有效价归组（`sell:股票:价`），不用改。单测 `regressions.spec`「V9.55 改单撞价后重新合并」3 条 |
| 价位槽认不出先后就不归链 V9.56 | **审计发现的口径漏洞（会击穿守恒式）**：V9.49 的「链之后同股同卖的裸卖 → 价位槽」两条 `after` 判断原来都写成 `日期为 null 也放行`。真实后果：R60–63 是老裸卖、卖出日期是 `=TODAY()` 公式没有缓存值（`soldAt === null`）→ 被当成「链之后的同价再卖」，槽又把**历史同价批次**（`buyDate` 空或更早）当成「已买回」→ `chainCover` 把这笔裸卖的待买自动关掉 → 敞口凭空少 500 股、**守恒式亮红灯**，链还因为这笔空头收益被顶成「已不亏钱」（概览把卡片折成一行）。修法：两条 after 判断都改成 **fail-closed**（`x.closeDate !== null && s.soldAt !== null && s.soldAt >= x.closeDate`；批次同理）——认不出先后就**不归链**，待买单留着；想归链可以人工指定（V9.46 `chainLinks`）。和 V9.47.1「卖出日期空着 → 保守地保留整张单」同一口径。修完 e2e 从 455 PASS / 4 FAIL 变成 **459 PASS / 0 FAIL**；单测 `chain.spec` 补 2 条（空日期裸卖、空日期批次） |
| 审计小修 V9.56 | 同一轮审计里修掉的（都带单测或 e2e 覆盖）：① **记回补成交连点两下会记两笔**——`execOrder` 弹窗原来没有在途保护（部分成交时第二次仍过 `remainingQty` 校验），加 `savingExec` 并禁用按钮。② **合并买入行改单会把量砍半**——预填用了「某个成员」的计划量（两条各 400 合成 800 时预填 400，「打开→不动→保存」就变 400），合并行改用整行现价现量。③ **来源列表重复 React key**——同一张卖单拆两档共用 `sourceRow`，撞价并进同一条建议后 `kind+row` 重复，key 带上 `splitKey`/股数。④ **待卖「合计」口径不一致**——合计走 `view.targets`（真实价）而行/预期收益已是计划口径，改成按行金额相加（V9.53 本来就这么写）。⑤ **`new Date('2026/1/5T12:00:00')` = Invalid → `at: NaN` 落库**（日期框认斜杠/点号写法），回补批次 `buyDate` 变 `NaN-NaN-NaN`、导出的备份因 NaN→null 连自己都恢复不了；统一先 `serialToIso` 补零再拼时间并兜有限性检查。⑥ **卖单「清除改单」没反应**——行 key 是当前价派生的，改完价换身份，只删当前 key 删不到任何计划；`TargetRow.planRefs` 记下这一行读过的整串计划身份，清除时逐个删。⑦ `ui/scrollHold` 重入丢锚点（400ms 内又开别的弹层会把半路位置当锚点）、`useFlashOnAppear` 定时器被顶掉导致闪灯常亮、`?price=` 空串被当成 0 分筛选——都修了 |
| 行关联 / 删除拦截 / 备份外键 V9.56 | 三处「行没了但关联还在」的洞：① **回滚导入只删 records**，而 `hedges/buyTargets/extraTargets/merges/chainLinks/plans` 全以行号为外键、导入又会**复用 Excel 行号** → 旧挂钩/拆分档/计划价静默套到下一次导入的另一笔交易上。现在 `domain/unlink.ts` 的 `cleanupRowLinks(rows, tables)`（纯函数、单测 `unlink.spec`）在同一个事务里清干净：卖出那笔没了整条挂钩作废、只删了被挂的批次就摘掉那条 item、合并组剩不到 2 笔就散组（挂在组上的 `merge:<id>@价` 计划一起清）、回本链锚点没了整条删而成员没了只摘成员（保留「已结束」）；价格型计划身份（`sell:股票:价`）认不出属于哪一行，**宁可不删也不误删**。批次里还记过回补成交的直接拦（先撤销）。② **软删被挂钩占着的批次**原来不拦，`ledger` 里 `lotByRow.get(it.row)` 找不到就 `continue`，挂账凭空消失、盈利从「暂缓」变回按 P 列结算——现在 `softDelete` 直接报错并点名「第 N 笔」和股数。③ **恢复备份只校验结构不校验引用**（`hedges` 指向不存在的行 → 静默失效、`soldLotId` 找不到成本 → 该笔盈亏变 null 不计入，界面却说恢复成功）：`validateBackup` 末尾加 `checkReferences`，悬空引用整包拒绝；`lot:exec:*` 虚拟批次与价格型 refId 认不出，不拦。**老备份若含悬空引用会被拒**，这是有意的（`ManageImport` 的回滚确认文案已写明会清哪些关联，错误也会弹出来不再静默） |
| 挂单页三组 V9.58 | **挂单页首屏按「钱在哪」重排（用户口径：先买后卖的钱都在股票里，手头现金只有卖出拿回来的那部分）**。买入侧分两组：**【应该买入】** = 先卖后买/带敞口的欠股（`domain/suggestions.ts` 的 `splitBuySuggestions`：`sellFirst \|\| 敞口`，敞口判定是防御性的——域内 `exposure` 实际只出现在先卖后买行）；**【锦上添花】** = 已完成批次的下一轮应买 + 先买后卖行里 P 列填了价的待回补（行上「P 列再买」标签）；**【应该卖出】** = 全部未卖份额（`targetRows`）。原「今日挂单 / 待买 / 待卖 / 敞口提示」四卡与 `next-round-buy` 小节删除；**越界档无法成交，折叠成一行摘要**（`must-out` / `bonus-out` / `sell-out`：N 档 · X 股 · 价格界，点开有完整行、可改单拉回区间内）；**逐笔回补状态与撤销收进底部 `[data-testid="rebuy-ledger"]` 折叠区，默认收起**——**e2e / 程序读它之前必须先 `d.open = true`，收起的 `<details>` 拿不到 innerText**。行渲染统一：真实走 `buySuggestionLine`（每行必有身份标签：先卖后买 / 下一轮 / P 列再买；全部来源是 next 的行带 `data-buy-level` 保深链，整行可点跳明细——`closest('button, summary, a, input, label')` 命中则不跳），沙盒走抽出来的 `sbBuyLine` / `sellLine`（沙盒不用 `buildBuySuggestions`：模拟行要保留「记为成交/删除」，模拟与真实同价不并条）；组池「可分配」与敞口提示并进应该买入卡脚；沙盒「＋ 模拟待买/待卖」挪进沙盒面板；复制清单/CSV 按三组顺序重排（CSV 类型列 = 应该买入/锦上添花/应该卖出）。下一轮档从「不给记成交」改为**可直接记成交**（它本来就是建议行，走 V9.49 的 `recordBuySuggestion` 路径）。单测 `regressions.spec` 2 条；e2e `[8]`/`[8.1.1]`/`[8.1.3]`/`[9.x]`/`[12.5]` 断言同步改写，smoke 与 accounting 全绿 |
| 回补覆盖统一 V9.57 | **所有「这笔卖还欠多少股」只在 `domain/cover.ts` 算一次**：`owed = 卖出量 − 本行买入覆盖`（V9.47.1）；`baseQty = owed − 同价真实买入覆盖`（V9.49 价位槽）；`openBaseQty = baseQty − 回补成交基础股`；`openExposureQty = max(0, owed − 真实覆盖 − 成交基础股 − 挂钩股)`；`deductQty = max(0, 成交基础股 − 已了结挂钩股) + 真实覆盖`（守恒式扣减）。**回补成交生成的虚拟批次不参与 cover**——它已经由 `execQty` 扣一次，再算进 cover 就是把同一笔股数减两遍（症状：order `baseQty` 600 / 真实欠 1000、敞口 200 / 真实 600、链计划 200 / 真实 600、守恒式 −200 vs −600）。**真实同价买入必须进守恒式扣减**（症状：targetQty 500 − 敞口 0 − 0 = 500，而净持仓 0）。`buildRepairChains` 改为返回 `{ chains, realCoverBySell }`，删掉 out 参数；`chainCover` 变量不复存在。价位槽按锚点**实际卖出过的价位**匹配（不再用加权均价）；「已结束」判据放进 `find`，已结束的同价链不再挡住另一条未结束的链。链分支的已实现盈亏包含 `hedgeClosed`（`realizedProfitOf` 与 ChainBinder 同源，原来成员的永久了结亏损不进链）。「记卖出」子成交已有待买的批次不再排下一轮（`buyBoard` 的 `childOrderLotIds`）；挂钩 UI 的「已买回」用 base `execQty − doneRewardQty`；`resetAll` 补清 `buyTargets`；备份校验补 `records.soldLotId / nextRoundOfRow` 外键。人工归属面板收进 `[data-testid="chain-manual"]` 折叠区（自动价位槽优先）。测试 301 条，smoke 460 PASS |
| 加载性能与收放动画 V9.60 | **预缓存 5082→3950 KiB（−22%）**：① `vite.config.ts` 的 `stripChineseFont500` 插件把 animal-island-ui 字体里中文 500 字重一档（~1.1MB）从库样式剥掉——**必须 `enforce: 'pre'`**：vite:css 的 transform 会先把 url() 换成资产占位符并发射字体文件，普通插件的 transform 看到的已经是占位后的 CSS（连文件名都没有），剥了也白发；剥掉后零星 `font-weight:500` 按 CSS 字体匹配规则自动落到 400 渲染，不需要改任何使用处。② `manualChunks` 把 react / dexie / animal-island-ui 拆成 `vendor-*` 三块——升级部署时 vendor 内容不变，HTTP 缓存与 PWA revision 都不重下；index JS 568→276KB。③ xlsx 本来就是 `import('xlsx')` 动态引入（420KB 只在导入/导出时加载），别改回静态。**明细页筛选收起**从 `.trades-filters[hidden]` 瞬切改成 grid-rows 连续收放（`.trades-collapse` / `.trades-collapse-inner`，同挂单页 V9.44 模式），内容 opacity/visibility 淡出 + `pointer-events:none`，e2e `[6.1]` 断言改查容器高度与 visibility。数据就绪首屏与切页沿用 `.app-main > *` 的 page-in，`prefers-reduced-motion` 照旧全退 |
| 统计进行度 V9.61 | 统计页新增三卡（`domain/gridStats.ts` 纯函数 + 单测）：①**网格进行度**（`[data-testid="grid-progress"]`）——完成轮次（批次 `remainingQty===0 && qty>0`，**回补虚拟批次也算一轮**）、进行中批次、每轮均盈（完成批次的自身盈利/完成数）、平均持仓天数（买入日→最后一笔卖出日）、待卖/待回补/敞口、最热价位；②**高成交点位**（`hot-levels`）——按（股票,买入价）聚合批次，完成次数降序→盈利降序→价位升序，条形图宽度按最大完成数归一，点行跳明细带 `stock+price+showDone`；③**近 12 个月盈利**（`profit-trend`）——复用 `ledger.monthly` 尾部 12 项，条高按绝对值、红盈绿亏。**盈利口径注意：进行度/点位用的是「批次自身卖出盈利」（`sell.lotId` 归属，不含裸卖与挂钩暂记负盈利），与 `totals.profitCents` 总账口径不同，界面上已注明别对数**。统计页数据只认启用股票（按 enabledIds 过滤 lots/sells）。e2e 钉值：fixture 最热 = 三一重工 19.53 · 完成 1 轮 |
| 守恒式 R7 | `Σ待卖 − 待补敞口 − 空头回补基础股 = 净持仓`；`净持仓 = Σ买入(含回补批次) − Σ卖出`。空头回补基础股 = 空头单成交里 (qty−rewardQty) 部分 + 同价真实买入覆盖，**两部分都既抵了敞口又以批次进了待卖**，扣回防双算；已永久了结的挂钩股不扣（批次份额已不在待卖） |
| 导入幂等 | v9.20 决策 C：`domain/importPlan.ts` 按行身份（股票+买入日期+买入价+有效份额，D 列派生值折算）匹配——同 key 跳过、身份命中则**更新卖出侧字段**（importKey/nanoId 不变）、身份对不上才新增。审计走 import-update 来源。改这个逻辑先跑 `importPlan.spec.ts` |
| 账户 | **V9.32 已删除**（只按一个账户做）：没有 accounts 表/账户筛选/顶部选择器，`records` 就是全部数据；`accounts` 表在 Dexie v7 里整表丢弃，老备份带 `accounts` 段直接忽略（schemaVersion 7） |
| 合并同价买单 V9.45 | **只做关联，不改数据**：明细抽屉里几笔**同股票、同买入价、还没卖完**的批次可以勾选合并（`merges` 表 `merge:<锚行号>`，Dexie v8）；`records` 各自的数量/买入日期一分不动。挂单页「待卖」（今日挂单 + 常驻待卖 + 复制清单 + CSV）按 `domain/merge.ts` 的 `mergeTargetRows` 合并显示：**数量/金额/预期盈利相加，日期取组内最早买入日**，`data-merge-group` 标合并行、点击跳最早那笔。组合并条件是**还有 ≥2 笔在卖**（有剩余、未删除、买入价仍一致）——卖到只剩一笔自动散开，但关联保留（回补/恢复后又能合上）；目标价不同的（手动拆过）不跨价合并。计划价：优先读 `plan:<merge:<组>@<价>>`（合并行自己的计划），没有就尝试把成员原有的同价计划数量相加；不同价则不给计划（一张单装不下两个价）。沙盒模拟行永不合并。合并只影响挂单提醒——价格树/概览汇总照旧按原始 targets 算。e2e `[8.1.3]` 用柳工 9.61 的 16/22 行合并成 10.68 × 800、校验最早 2026-03-20 与解除恢复 |
| 下一轮应买 V9.47 | **卖完的老批次也要提醒买**（网格一轮一轮做）：`domain/buyBoard.ts` 的 `buildNextRoundBuyRows` 给每个**卖完的真实批次**（`lot:<行>` 且 `remainingQty === 0`）按**买入价 C 列**排一档应买，数量 = 建仓量（超卖夹到批次量）。用户拍板的三条：价用 C 列（不是「卖出价 − 间隔」）、纳入卖完的批次 + **已回补完**的单（`remainingQty === 0 && execQty > 0`，行上标「回补过一轮」）、同价合并**复用 V9.45 的 merges 组**（组内 ≥2 笔都是卖完候选才合，数量相加、日期取最早、`anchorRow` 跳最早那笔；只剩一笔自动散开，关联不动）。**还没回补完的行直接跳过**——那张 P 列待买单已经在提醒、价位还不一样，并列会把同一笔钱提示两遍。回补虚拟批次（`lot:exec:*`）与沙盒行不参与。**纯展示、不碰账**：不进 `ledger.orders` / 待买剩余金额 / 组池奖励 / 守恒式 / records，所以 baseline 与单测数都不受影响；`key` 是 `buy:<行>` / `buy:merge:<组 id>`（只活在内存，不落库、不是 ID 前缀约定的一部分）。界面（`OrdersPage`）：今日挂单的「可挂买」把区间内档位并进来（组标签注「含已完成批次 N 条」，越界计数 `outCount` 也算它），待买卡下方常驻 `[data-testid="next-round-buy"]` 小节列全部档（行 `[data-buy-level=<锚行>]`、`data-merge-group`、蓝「下一轮」标签、**不给「记成交」**——它不是一张待买单）；复制清单加「【今日可挂买 · 已完成批次下一轮】」，CSV 加类型「应买（下一轮）」。**顺带修**：点这些行跳明细会落到「已完成」行，而明细默认 `hideDone` 把它藏掉 → 深链落空；`TradesPage` 现在对 `idFilter` 命中的那一行豁免 hideDone（与软删豁免同一思路）。e2e `[8]` 钉了小节存在、档数 ≥5、并入可挂买、R60-63 不重复提示、无「记成交」、深链恰好命中 1 行。**V9.58 起该小节并入挂单页「锦上添花」组、档位可直接记成交，见「挂单页三组 V9.58」** |
| 计划价 P8 | plans 只影响展示/导出，永不参与计算 |
| 软删除 | `deletedAt` 非空的行不参与一切派生；导入幂等按 importKey，同 key 不覆盖 |
| 基准 | `defaults.ts` BASELINE 只对「26年网格记录」fixture 成立，金额 ±1 元容差（E 列三位小数取整）；改任何派生逻辑跑 `io/baseline.spec.ts` 是红线 |
| 价格树 | **逻辑层** `TreeTrunk.tsx`（数据聚合 aggregate → groupLevels、视野/交互/命中/hover 预览/e2e 桥/风格注册切换）+ **样式层** `treeStyleAtlas.ts`（图鉴素雅风：细锥双线干+淡水彩、统一弧线枝、干上泡牌价签、单行衬线注记）、`treeStyleSketch.ts`（手绘抖动风，V9.18~21 存档：木色粗干+树皮排线+树轮+装饰叶+云+沸腾）与 `treeStyleAxis.ts`（数轴风，**V9.25 起默认**：弃树意象，Apple 简约；V9.25.3 丰满化——冷白微渐变底+整步淡网格骨架、发丝轴两端渐隐、渐变枝+光环软投影端点、轴对侧价位 chip、hover 整行色带（TreeFrame.hover 由逻辑层传入）。V9.23：滚轮/捏合缩放**锚定指针**（`zoomToSpan`；桥 `zoomBy` 保持正中缩放旧语义）；图例按钮循环切三风格（数轴→图鉴→手绘），偏好存 localStorage `ezgrid.treeStyle`（不落台账库）。V9.25：**点击传价格区间**（TreePick lo~hi 分）——单档跳 `price=`、聚合组跳 `priceLo/priceHi`（明细页四个价格字段 OR 落区间即命中，与精确 price 同口径）；hover 预览 V9.26.2 已按用户要求移除（点击跳转保留，热区=拾取圆+注记文字）。聚合档数展示：数轴风=**枝上垂直刻线**（一道=一档，封顶 8 道，V9.26.2 取代「·N档」文字）、图鉴风=枝上小点、手绘风=叶。合并粒度由风格 `cardRowPx`（图鉴/数轴 27、手绘 34）按缩放推算——放大时聚合枝自动分散回原档位数；注记 买/卖 价×份额、已成交「已盈利±¥xx」=该价位 soldProfitCents 合计；e2e 桥 `canvas.__tree`：levels/span/center/panX/panXBy/setView/pickAt/zoomBy/projectPrice/**style**（projectPrice 返回所在合并组的 repCents——点击跳的是组内代表档）。命中检测 = 拾取圆（圆心距离最近者胜）+ 枝梢注记文字热区（`bin.note`，数轴风），等距才按 待卖→待买→已成交。**V9.31 数轴改「格子进度条」**（用户拍板）：待买/待卖不再画枝线，改成**一格 = 一档**的小方格进度条（`CELL`5px / `CELL_GAP`1.5 / `CELL_MAX`8），聚合几档就长几格、由内向外逐格变淡；注记（买/卖 价×份额）一律排在格子**外侧**，且**先量注记宽度再定格子数**（`room`），塞不下的档数紧跟格子标「+N」（`BranchBin.over`）——绝不允许文字压格子；轴对侧价位 chip 已删，刻度数字改成**骑在轴上**（10px 淡灰 + 纸色挖穿），两侧留 `AXIS_HALF`16px 通道。已成交保持灰短枝+圆点不变，注记追加「卖出 N 次」（`BranchBin.times` = 组内 soldCount 之和）。概览树加**年份限制**：年份来自 `ledger.sells` 的卖出日期，Select 放图例条，**只筛已成交**（待买/待卖是当前挂单，不随年份消失），空值默认「全部」。e2e 桥新增 `bins()`（count/over/times）与 `year()` |
| 理想可卖到 | **V9.29 用户拍板：由金额改股价** = 该股待卖里的**最高目标价**（`StockSummary.targetMaxPriceCents`，派生自 `targets`，无待卖为 null；口径只在 `ledger.ts` summarizeByStock，`baseline.spec.ts` 钉了柳工 ¥11.48）。含义 = 股价涨到这里待卖全部出清。数轴风画**琥珀点线**横贯 + 左下 chip（`TreeFrame.idealCents`，与昨收紫虚线并列的两条参考线），图鉴/手绘风没有价格刻度 → 退回画布左上角只读角标。只做展示，不参与任何计算 |
| 手动新增 / 编辑（V9.35） | 日期解析**收 `-` `/` `.` 与全角斜杠、月日可一位数**（`edit.ts: isoToSerial`），输出永远补零成 YYYY-MM-DD；新增一笔打开时**日期默认今天**、股票默认当前筛选。
先卖后买的行抽屉页脚多一个**「补买入」**：一键把买入价=回补价（P 列）、买入份额=卖出量、买入日期=今天填好再进编辑；**普通「编辑」绝不预填买入侧**——只想改卖出侧的人不该因为保存把买入写进台账（当初做成自动预填，e2e 里改一行目标价就把整行变成批次、连带盈利/敞口全变）。新增卖出的「回补价」placeholder 直接显示推导值（卖出价 − 该股间隔），「目标售价」显示买入价 + 间隔；日期字段旁有「今天」快捷键 |

| UI 基础控件 V9.38 | **下拉**用 `ui/Select.tsx`（不用组件库的 Select：库面板横向浮在触发框右侧，390 宽下两侧都出屏）。面板在触发框正下方就地展开，下方不够向上翻转，左右按 `getBoundingClientRect` 夹进视口，`max-height` 取可用空间并自己滚；触发器保留 `role="combobox"`、选项 `role="option"`（e2e 靠这个选股票/年份）。**日期**用 `ui/DateField.tsx`：手输框（认 `- / .` 与全角斜杠）+ 日历按钮唤起原生 `input[type=date]`（`showPicker()`，失败退回 focus），选完按 ISO 回填；日历按钮 `preventDefault` 防止 `<label>` 激活抢焦点。明细抽屉编辑与新增一笔的日期格都用它 |
| 沙盒模式 V9.39 | **只预览、不写库**：挂单页右上「沙盒」开关（`[data-sandbox-toggle]`）；打开后 `sandboxLedger = buildLedger(真实 records + 模拟 records, 真实 hedges + 模拟 hedges)`，自动派生的待买/待卖也一起进预览。模拟条目在 `domain/sandbox.ts` 的 `SandboxState.items`（**内存态**，刷新/恢复备份/清库即清空），预览行号从 `SANDBOX_ROW_BASE = 300000` 起；`kind:'sell'` = 模拟待买（先卖后买：成交价 + P），`kind:'buy'` = 模拟待卖（假设买入：买入价 + 目标价，目标价空按间隔推）。「＋ 模拟待买 / ＋ 模拟待卖」弹窗默认昨收价、昨收 ± 该股间隔、100 股、今天；模拟行紫色虚线（`.line.sandbox-row` / `.sandbox-mark`）、不可跳明细。**模拟挂钩**复用 `HedgeBinder mode="sandbox"`（标题「沙盒挂钩预演」），可挂真实未卖批次或模拟批次，结果立即反映到挂单页四项指标与概览横幅（`[data-testid="sandbox-banner"]`：已实现盈利 / 理想可卖到 / 理想剩余可赚的真实 → 预览差值）；价格树用 `<TreeTrunk ledger={viewLedger}>` 重画、`__tree.ideal()` 跟着变。**记为成交**：`commitSandboxItem` 把该条转成真实手动记录（100000 段）写明细；挂着模拟批次时先一起转正（通知里 `committed > 1`），再用真实行号写 `hedge:<newRow>` + 审计「沙盒挂钩转正」，写完必须 `setHedges` 同步内存。模拟条目不进备份、不写 audit；清空模拟/退出沙盒只动内存。e2e 覆盖「未挂 +250 → 挂钩 10.89 批次 −1,945 / 最高卖价 11.48→11.38 → 记为成交 100001 → 刷新清空」 |
| 编辑抽屉滚动 / 输入法 V9.40 | **抽屉打开会丢滚动位置**：animal-island-ui `Drawer` 打开时给 body 写 `overflow:hidden`，而页面是普通文档流（`.app` 只有 `min-height:100%`）——文档高度塌成一屏，窗口 `scrollY` 被浏览器清零，关掉后也回不去。`TradesPage` 在 `open()` 里先记 `window.scrollY`，抽屉**真正关闭**（`current === null`，不是 `openRow`——行被筛掉时抽屉也会关）后一帧 `scrollTo` 补回来。**输入法避让**：`ui/viewport.ts` 的 `useKeyboardInset(open)` 监听 `visualViewport`，把键盘高度写进 `--kb-inset`、可见高写进 `--kb-vh`、面板高写进 `--ed-h`；Drawer 的 `height` prop 传 `var(--ed-h, 84vh)`（内联样式支持 CSS 变量），`styles.css` 的 `.trades-edit-drawer` 用 `bottom: var(--kb-inset)` + `max-height: calc(var(--kb-vh) - 8px)`，键盘弹出时面板整体抬到键盘上沿、高度收进可见区；`.animal-body` 的 `scroll-padding-bottom` 保证聚焦最下面几行时输入框不被页脚挡住。e2e `[7.2]` 用 `Object.defineProperty(visualViewport, 'height')` 模拟键盘并断言面板几何与滚动复原。**V9.55 起滚动复原抽成 `ui/scrollHold.ts` 的 `useScrollHold`，所有弹层统一走它，见下面「编辑弹层保滚动 V9.55」** |
| PWA 更新 V9.40 | `vite.config.ts` 的 `registerType` 从 `autoUpdate` 改成 `prompt`：**新版本只提示、绝不自动 reload**（旧 autoUpdate 在部署后强制刷新页面，编辑到一半会丢弹窗和滚动位置）。`main.tsx` 的 `onNeedRefresh` 只弹「手动刷新页面后生效」，每小时 `reg.update()` 照旧检查。用户手动刷新后新 SW 才接管。**别改回 autoUpdate**——用户明确要求「数据更新后只有在手动刷新时才更新页面数据」 |
| 布局 V9.41 | **删全局「网格交易」header**（`App.tsx` 不再渲染 `.app-header`，`--header-h` 只剩 `env(safe-area-inset-top)`；`.app-main` 自己让出状态栏安全区）。**概览首屏重排**：股票 tab 置顶（原「选股 · 当前股票汇总」标题行删除）；树上方只留高频四项（已实现盈利 / 理想可卖到 / 理想剩余可赚 / 今年共卖），树用 `height: calc(100dvh − --nav-h − 20px − safe-top)` 铺到导航上沿（390×844 画布实测 568px）；可卖/待补/净持仓/已实现 + 回本链下移到树下方，全局三格/标签等低频内容继续往下，必须滚动才看得到。**统计 · 成交日历**当日明细行首加红框「卖出」chip（`.side-chip.sell`），成本文案改「买入成本」（日历只按卖出日归集） |
| 挂单吸顶 V9.42 / V9.44 | 下滑超过 96px 把挂单页吸顶块（标题 + 沙盒面板 + 选股/昨收/涨跌停设置）收成**一行摘要**（`[data-testid="orders-compact"]`：股票 · 昨收 · 涨停 · 跌停 · 沙盒标记），回顶 24px 内恢复完整布局。阈值带回差 + rAF 节流；摘要只读，切股/改价要回顶（点摘要平滑回顶）。**V9.44 修「顶部抽搐闪烁」**：根因是收放直接 `display:none` 改文档高度，浏览器滚动锚定把 `scrollY` 补偿回阈值内 → 收→放→收 连环触发。现在 ①`html, body { overflow-anchor: none }` 关掉锚定；②摘要常驻 DOM、设置块不再 `hidden`，用 `.orders-compact-slot` / `.orders-setup-collapse` 的 `grid-template-rows: 0fr↔1fr`（`--dur-3`）连续收放，摘要淡入 + 上移 4px，`visibility` 过渡隐藏不可点；③滚动监听走 rAF，收放期间不会被打断。e2e `[8.1.2]` 钉了收起高度 44px、摘要可见性/内容、仍吸顶、回顶复原与昨收保留，并新增抖动检查（0→300→0 小步滚动时 `is-compact` 翻转 ≤3 次、`landed === 300`） |
| 管理页入口 V9.44 | 管理页从「一排 tab」改成**按钮入口**：`ManagePage` 先渲染 4 个 `.manage-item`（`[data-manage-entry]` = stocks / import / checks / backup，带图标 + 名称 + 一句说明），点进去才渲染对应分区，顶部 `.manage-bar` 有「‹ 管理」返回按钮（`[data-testid="manage-back"]`）。不再用 `Tabs`；离开管理 tab 再回来会回到入口列表（组件卸载，不记忆上次分区）。e2e 里进分区要先点入口、换分区要先点返回——`nav('manage')` 在同 tab 时不会重挂载，别指望它重置 |
| 明细吸顶 V9.42 | **删除明细页搜索框**（原「搜股票名 / 行号」）：连带 `TradesPage` 的 keyword 过滤、搜索条件 chip、URL `q` 参数一起删（`TradesQuery` 不再有 `q`）。下滑超过 96px 把股票 tab / 状态筛选 / 条件 chips 整块用 `.trades-filters[hidden]` 收掉，只留「明细 x / y 行」标题（吸顶高 42px）；回到 24px 内恢复。排序 / 导出 / 新增仍在那张卡里，随页面自然滚走，回顶一起回来。e2e `[6.1]` 钉了搜索框不存在、收起与恢复、排序离开视野、标题仍吸顶。**V9.60 起收起改成 grid-rows 连续收放（同挂单页 V9.44），断言改查 `.trades-collapse` 容器高度与 visibility，见「加载性能与收放动画 V9.60」** |
| 动效 V9.37 | 统一缓动 `--ease-soft / --ease-back` + 三档时长（`--dur-1/2/3`）；只动 transform / opacity / 色彩，不动 layout（唯一例外是删除那一行用 max-height 收高度）。**切页带方向**：`.app-main[data-dir=forward\|back]` → `page-in-forward / page-in-back`，方向由 App.tsx 比较 tab 序号得出。**明细行三态**用 `data-anim` 属性驱动（样式在 styles.css）：`new` = 新增落位 + 微光（承接「弹窗收成一条明细」）、`leaving` = 删除向右滑出并收高度（**先播 300ms 动画再真删**，别直接消失）、`done` = 刚完成洗一层青。通用 hook：`ui/motion.ts` 的 `useFlashOnAppear(keys)`（首帧不闪、依赖用 key 签名避免每帧重跑）。底部导航短横线常驻 + scaleX 过渡、图标弹跳；挂单页回补成交的那行同样会闪。`prefers-reduced-motion: reduce` 时全部退化为瞬切。 |

## 记账与挂单完整性 V9.49（覆盖上文旧描述）

- 导入时 `sourceRow` 是永久内部 ID；新买单碰到旧行号时分配未占用 ID，原 Excel 行号存 `excelRow`（老记录回退 `sourceRow`）。已有后续成交的行不允许被导入改写；已回补订单不允许导入减少卖出量至已回补量以下或清空回补价。
- 挂单支持「记卖出」：新行 `soldLotId` 指向原真实/回补批次，只扣来源库存，不重复创建买入。后续买回继续产生虚拟批次，多轮自动继承回本链。父成交已有后续卖出时，修改关键买侧字段、删除、撤销回补、回滚外部依赖所在批次均拒绝；先撤销后续成交。恢复关联卖出检查来源剩余量。
- 已卖份额出现净亏损即建链，包含部分卖出、尚未回补的挂钩亏损，无须等清仓/回补。后续盈利仍只计已完成买卖；回补节省不计进度。同一回补跨多个锚点时按实际归属股数分配，每份库存/盈利只能进一条链，多次卖出按 FIFO 消耗归属份额。`plannedQty` 取当前欠回补量与初始未回补份额的较大值，不把多轮累计买入误当初始回补。结束后的新回补不自动归入已结束的链。
- 明细按行汇总全部关联卖出，不再被最后一笔覆盖；抽屉列出来源与关联成交。回本链锚点、成员和相关裸卖不被「隐藏已完成」挡住。
- 待卖缺目标价按买入价+间隔推导；裸卖缺 P 且未明确标已回补时按卖价−间隔推导待买。缺真实成交价仍报缺失，不能捏造成交价。
- 待卖按股票+有效挂单价自动合并（不同买入成本也合并）；待买将待回补和下一轮建议按同价汇总，保留来源可追溯。计划价、计划量、区间过滤、复制/CSV、金额统计使用同一口径；拆分/计划限量后的来源贡献量同时截断。
- 下一轮建议成交落一笔真实买入，`nextRoundOfRow` 标明来源，部分成交只消耗相应份额；软删后额度恢复，恢复时防止重复占用。回补/合并成交在事务内重新读账校验额度，失败整笔回滚。
- **第三项策略待用户重新定义，保持现状**：原单已回补、回补批次尚未卖出时，原单是否继续出现「下一轮」仍沿用旧候选规则。本次不改裸卖基于 P 列的既有盈利口径。
- 备份 `schemaVersion: 11`（V9.50 起），新增可选行字段（`nextRoundOfRow`）与 `buyTargets` 表的结构校验，兼容旧备份。Dexie 已升到 v10（只加 `buyTargets` 表，无迁移）。回归覆盖 `regressions.spec.ts` 与 `e2e/accounting.mjs`。

## 弹窗默认值 V9.48

- 有明确数值/日期默认值的输入留空（含纯空格）时，保存使用框内默认值；手填非空值优先，非法值和显式 0 仍走原校验，不能悄悄回退。
- 新增一笔：`domain/formDefaults.ts` 的 `manualFormDefaults` 同时提供 placeholder 与提交默认值，`resolveManualForm` 仅用于新增。买入默认 8.01 元、卖出默认 8.58 元、700 股、日期今天；目标/回补价按实际采用的价格和该股间隔派生，回补价优先关联买入价。可选买入信息全部空白时**不生成买入批次**，开始填写任一项后，其余项默认 8.30 元 / 本次卖出数量 / 今天。
- **V9.51 少填**：买单数量默认跟着**实际采用的买入价**走（`deriveBuyQty`，6000 / 价 手数化；8.01 → 700、5.00 → 1200），改价后数量与目标价同时变，留空点确认即可；卖单数量仍默认 700。拆分面板的股数默认是**还能拆的量**（批次剩余 / 未回补欠量 − 已拆出去的档），填超过直接夹到剩余量并在提示里说明，不再靠事后截断标异常。
- 普通编辑里的「元、股数、YYYY-MM-DD」仅为格式提示，清空字段继续表示清空；不得给普通编辑补买入默认值。
- 拆分目标默认当前批次目标价/剩余量；挂单计划默认建议价/待买剩余量或待卖量；回补成交默认回补价/剩余量/未成交奖励量（明确填 0 表示不买奖励股）。
- 沙盒默认昨收价（未确认昨收时 8.10）/100 股/今天，目标或回补价空白按当前实际采用价格与间隔推导。新增股票间隔空白默认 0.57 元；股票名称与股票选择仍须明确指定。
- 日期编辑占位统一用格式文字，新增与沙盒才显示今天；不要再把固定历史日期作为默认值提示。9 条 `formDefaults.spec.ts` 和 e2e 留空提交后的 IndexedDB 只读核验覆盖此行为。

## ID 前缀约定

`stock:` `lot:<row>` `sell:<row>` `target:<lot|extraId>` `rb:sell:<row>` `exec:<orderId>:<ts>`
`et:<lotId>:<ts>` `plan:<refId>` `batch:<ts>` `hedge:<sellRow>`（V9.26）
`merge:<锚行号>`（V9.45 同价买单合并组；`merge:<组 id>@<目标价分>` 是合并行的计划 ref）
`chainlink:<锚行号>`（V9.46 回本链归属，只存 memberRows + closedAt；派生链 id 是 `chain:<锚行号>`，不落库）
`buytarget:<卖单行>:<ts>`（V9.50 卖单拆买，只存价位+股数；派生展示档是 `rb:sell:<行>#<序号>`，不落库）
`sandbox:<seq>:<ts>`（V9.39 仅预览；预览行号 = 300000 + seq，绝不落库）。备份
schemaVersion 11（V9.50 加 buyTargets；V9.49 加行级成交来源；V9.46 加 chainLinks；V9.45 加 merges；V9.32 去掉 accounts）。`validateBackup` 现在逐表校验 records / stocks / 回补成交 / 计划 / 拆分目标 / **拆分买入** / **挂钩** / **合并组** / **回本链归属**（V9.32 起；之前只查前两张，`hedges: [{}]` 能过校验、恢复后 `for..of h.items` 直接白屏）。Dexie schema 改动必须递增 `db.ts` 里的 version()（老库
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
- **Dexie 事务只能碰声明过的表（V9.54 踩过）**：`recordRebuy` / `recordLotSales` / `recordBuySuggestion`
  的事务体里都调 `currentLedger()`（重建整本账做额度校验），而 `currentLedger()` 会读 records / stocks /
  rebuyExecutions / hedges / extraTargets / chainLinks / **buyTargets**——V9.50 加表时漏同步，
  点「记成交 / 记卖出」直接抛 `NotFoundError: The specified object store was not found`。
  现在三处统一用 `useApp.tsx` 的 `LEDGER_TX_TABLES()`，**再加派生输入表时只改这一处**；
  恢复备份的整库事务同样要列全。
- **导入不要用组件库的 `Upload`（V9.52）**：它内部是隐藏 input + 程序 `click()` + 只写扩展名的
  `accept`，iOS / 微信 WebView 里点开选择器后文件会被全部过滤成灰的，表现就是「无法选择文件」。
  **V9.52.1 进一步**：`<label htmlFor>` + `display:none` 的 input 在部分手机 WebView 里点击仍无反应，
  最终形态是**透明 input 直接铺满整个触发区域**（`position:absolute; inset:0`，label 只作
  `position:relative` 容器、内容层 `pointer-events:none`）——手指点的就是原生 input 本身，不依赖
  label 转发、不依赖任何 JS `click()`。`accept` 同时写上 MIME 与 `application/octet-stream`，onChange
  里清空 value 以便重复选同一文件；桌面端拖拽（`onDrop` 冒泡到 label）保留。e2e 仍用
  `input[type="file"]` 塞 fixture（透明铺满不影响 `DOM.setFileInputFiles`）。
  **V9.59 独立模式（PWA）点击无响应**：浏览器标签页正常、添加到主屏幕后点文件选择没反应——
  ① 全透明（`opacity:0`）input 在独立模式的原生激活偶尔不吃 tap，透明度改 **0.01**（肉眼不可见
  但算「可见」）并加 `z-index:1`；② 程序化 `click()` 在独立模式里历史上不可靠，兜底顺序是
  `showPicker()`（Safari 16+ 正规 API，独立模式可用）→ `click()`，统一在 `ui/pickFile.ts` 的
  `openFilePicker`，**必须在 tap 的 click 手势里调用**；③ label 的 onClick 做「谁被点了」分诊——
  tap 正常落在 input 上时 target 就是它、原生路径已唤起，直接 return（防止双重唤起），命中测试
  被独立模式跳过时 target 是 label，preventDefault 后兜底唤起。**恢复备份的「从 JSON 恢复」
  原来就是 display:none + `fileRef.click()` 形态（独立模式必挂），已改成同一套 overlay + 兜底；
  accept 补了 `application/json,text/plain`——只写 `.json` 扩展名在部分 WebView 里文件是灰的。
  以后任何「点这里选文件」入口都照这套抄，别用组件库 Upload，别用 display:none。**

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
- **H 回本链价位槽**（2026-10-26 拍板，V9.49）：C/D 这类「同价再卖」的先卖后买订单**自动挂回**那条
  高买低卖的链，按 P 列开价位槽；之后**所有**同股、同价的买入（回补成交 / 明细新增 / 导入，不分入口）
  自动归槽、累计盈亏，不用手动关联；回补完成即视为已完成、待买单自动关（用户原话「不手动关」）。
  多链共享同一价位时归给锚点卖出日期最近的那条；锚点批次自己永远不会被别的链收编。
