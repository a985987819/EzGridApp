# 挂单/成交专项审计（基线 aa74bfd）

仅审计与临时复现，不修改产品文件。独立浏览器临时 profile 与项目原 e2e 的 9444/9445 端口完全分离；使用 9457/9458。完整输出在同目录 pure-results.txt、store-results.txt、member-results.txt。

## 已复现问题

### O1 P1 当前选股未过滤待买档，混入其它股票，可误记其它股票成交

- 位置：src/pages/OrdersPage.tsx:191，后续 213/220/231/1190-1212。
- T 欠500股@5，U欠600股@6；选T且不设区间，应该买入卡显示 `T · ¥6100`，两档 `6×600`、`5×500`，行上没有U股名；逐笔台账仅有T一条，与首屏不一致。
- 根因：`orders`、`targets`、`nextRound` 按 effectiveStock 过滤，但 `buySplits = view.buySplits` 包含所有股票；真实/沙盒建议、当前金额、复制CSV均沿用。
- U行点记成交因当前orders无U而走 openTrade，打开无股票提示的成交弹窗；该来源交给store后确实记为U600。此次脚本实际确认了UI打开和同来源store落库；保存按钮路径正是同一recordBuySuggestion调用。
- 建议：传给建议/沙盒/合计的档位在入口统一按股票过滤；每个成交弹窗显示股票并在提交时验证弹窗股票与所有来源股票相符。测试两个股票相同及不同价、各自涨跌停区间、切股、复制CSV。

### O2 P1 欠股与可选再买在分类前/改单后跨组混合，计划身份共享

- 位置：src/domain/suggestions.ts:57/63/88/106/117，149-161；OrdersPage.tsx:213/220。
- 同股欠500@5 + 已完成下一轮300@5（该完成批次无盈利，无奖励干扰） => 只有一条 `buy:T:500` qty800，sellFirst=true，全部列为应该买入，bonus为空。期望欠500应买入、300锦上添花分别存在。
- 普通P列可选再买500@4.5 + 欠股500@5，前者改单到5 => 合并1000进应该买入。两次合并key均缺purpose/kind；后分类无法恢复。
- 旧plan `buy:T:500` 同时约束混合来源，未做到新规则的计划隔离。重构时不能直接把旧计划复制给两组，需无歧义迁移或提示。
- 现有 regressions.spec.ts 约141/224/244的用例恰在钉死旧行为，仍通过并不证明符合2026-10-28现行规则。
- 建议：来源先确定业务目的（欠股/可选），最初分桶、计划ref、最终价合并都带目的；exposure防御分类也要放在合并前。覆盖 order+next、order+order、改单撞价、清除、旧计划歧义、复制导出、沙盒。

### O3 P2 奖励只按股数拦截，改高实际成交价可花超利润预算

- 位置：src/domain/dependencies.ts:7-14；src/store/useApp.tsx:749-753/783-793；src/domain/ledger.ts:664-674/724-734/922。
- 5买500、7卖500，P5；利润1000元、预算授200奖励股。`recordRebuy(order,700,1000,200)` 成功落库，即10元买700股含奖励200，奖励花费2000元，而可用利润仅1000元。之后才在checks出现超支。
- 已通过真实IndexedDB/store实证，validator本身也接受。recordBuySuggestion使用同样校验且按原价组授予股数自动算奖励，存在同一缺口。
- 这是现金预算控制问题，不是库存双扣；股份守恒仍成立。应用若必须忠实录入已发生的超预算成交，应允许显式登记“额外自有资金”，而不是自动暗示这些奖励完全由利润支付；不要因历史事实不合策略而简单拒绝历史录入。
- 建议：实际成交价下重新核算可用奖励整手，UI清楚提示预算差额；新交易策略限制与历史事实录入采用明确口径。多订单同组需在事务内累计本次各笔实际奖励支出。

### O4 P2 改单缩量未缩来源贡献，合并后实际扣错档

- 位置：src/domain/suggestions.ts:80/90/115；src/store/useApp.tsx:744-752。
- 同一欠1000订单：4元档200、默认5元档800。两条分别改单到5元且各计划100，合并行qty200，但sources仍200+800。
- 真实UI点记成交默认200并保存：仅第一来源落库200，第一档剩0/default仍800；期望尊重两成员计划各100，余量应100+700。全局checks全部通过，这不是总量超买，却是按来源计划成交失真。
- 建议：区分source容量与此次建议贡献量，套计划后截断/分配来源贡献、再合并；store继续验证实时容量。保持原source身份，不能通过修改持久账本来补救展示。

### O5 P2 合并成员数大于计划量时，实际计划量静默放大

- 位置：src/pages/OrdersPage.tsx:697-706。
- 两条撞价成员合并后改单qty=1，界面接受；循环强制每成员至少1，最终两个计划各1，行显示2股，成功提示仍“合计1股”。真实UI复现成功。
- 建议：支持某成员贡献0且总和精确为输入，或输入不足成员数时明确拒绝；不可静默扩大；多成员计划更新用一个事务避免中间状态。

### O6 P2/体验 空沙盒忽略真实建议级改单

- 位置：src/pages/OrdersPage.tsx:213 vs 231-242/419，沙盒不走buildBuySuggestions。
- 真账欠500@5，建议改单6元/100；真实卡金额600元。开启无任何模拟条目的沙盒后变回5元500/2500元。
- 真实React UI复现。账务金额/持仓没有改动，偏差在展示的可挂价格和数量、区间内外与后续默认值。
- 当前沙盒不合并模拟与真实来源是明确设计，保留独立转正按钮合理；但这并不自然要求丢弃真实改单。建议复用实际有效计划计算，再单独渲染模拟操作；若刻意不继承则应在UI明示。

## 架构与可优化空间

1. 建立统一挂单视图派生Module：输入账本+计划+选股+业务目的+区间+沙盒，输出来源份额可追溯的可执行行。现在 OrdersPage真实、沙盒、snapshot/CSV分别组合，导致选股、分类、计划失配。目标是集中规则，不把账务P8计划混入buildLedger核心。
2. 计划修改采用纯函数分配+原子写库。分配后检查Σ成员计划=用户输入、每贡献非负且不超容量、跨目的不合并。
3. 成交验证增加实际金额预算；按组累计本事务支出，边界输入/并发在同一Dexie事务中验证。保留当前事务内实时重算和回滚能力。
4. buildBuySuggestions 多处plans.find、mergeTargetRows嵌套plans.find/rows.find、buildNextRoundBuyRows每个candidate再filter全量，存在二次复杂度；先建Map，以1000/10000条合成账测时后再决定是否优化。未进行性能基准，不能称性能缺陷。
5. 奖励FIFO的createdAt实际取sourceRow（ledger.ts:583/926），不是成交日/录入时间。未知产品意图，列为口径待明确，不作为确定bug。
6. setPlan/clearPlan/addExtraTarget/removeExtraTarget/addBuyTarget/removeBuyTarget/stock启停排序等没有审计写入，违反根AGENTS“全部动作写auditLogs”的声明。对账追溯完整性应单列；无需改变产品口径。

## 已有保护/测试与缺口

- 运行针对性89项测试（regressions 41、buyBoard15、tradeAccounting13、merge13、reward7），全部通过。
- 已有覆盖有效：基础/奖励数量分开、奖励整手、同源多档来源ID、真实欠量上限、部分成交、撤销恢复档位、旧成交同价匹配、默认未拆余量、计划不改账、卖单有效价汇总排序与planRefs清理、成交事务重新读取、失败回滚。
- 缺口：多股票买档页面隔离、最新跨目的禁合并、旧计划隔离、套计划后的来源贡献Σ、成员数量大于目标数量、实际成交价下奖励预算、空沙盒实际计划一致性。
- 纯函数验证能找到O2，真实UI/IndexedDB是O1/O3/O4/O5/O6的关键接口；只测buildLedger守恒发现不了这些问题。

## 重放

```powershell
.\node_modules\.bin\vite-node.cmd .tmp/audit-orders/probe.ts
node .tmp/audit-orders/store-probe.mjs http://127.0.0.1:5173
node .tmp/audit-orders/member-probe.mjs http://127.0.0.1:5173
npm test -- src/domain/regressions.spec.ts src/domain/buyBoard.spec.ts src/domain/tradeAccounting.spec.ts src/domain/merge.spec.ts src/domain/reward.spec.ts
```

浏览器脚本要求已有本地dev（5173），从项目根运行，使用独立临时profile，无用户浏览器/用户数据库影响；finally关闭本脚本浏览器。
