# 2026-10-28 逻辑审计证据

本目录归档 EzGridApp 在 `aa74bfd4032d485284f448447127f2bdfaf87dc4` 基线上的只读审计探针和原始结果。探针用于复现观察，代码中的 `PASS` 只表示“观察到脚本声明的现象/对照成立”，不表示缺陷已经修复。

归档副本只把脚本运行产物改写到项目根的 `.tmp/audit-replay/`，不把新结果写回本目录，避免覆盖静态证据。探针不改产品源码、正式测试或业务规则；浏览器探针使用临时 Chrome profile，脚本结束会关闭浏览器并删除 profile。

## 文件对应关系

| 归档文件 | 来源 | 用途 |
|---|---|---|
| `orders.ts` | `.tmp/audit-orders/probe.ts` | 纯函数挂单分类、改单撞价、奖励预算探针 |
| `orders-ui.mjs` | `.tmp/audit-orders/store-probe.mjs` | 真实 React + IndexedDB：跨股票、奖励超支、沙盒计划 |
| `plan-members-ui.mjs` | `.tmp/audit-orders/member-probe.mjs` | 合并计划成员来源与部分成交 |
| `chains.ts` | `.tmp/audit-chains/verify.ts` | 回本链自动归属、结束、二代回补、实际回补价 |
| `perf.ts` / `perf-large.ts` | `.tmp/audit-chains/perf*.ts` | `buildLedger` 合成数据耗时观察，不是生产 SLA |
| `persistence.mjs` | `.tmp/audit-persistence/probe.mjs` | 并发写入、导入、回滚、JSON/XLSX恢复和外键探针 |
| `numbers-and-statistics.ts` | `.tmp/audit-root/probe.ts` | 数值安全、统计投影、守恒与自定义区间 |
| `statistics-ui.mjs` | `.tmp/audit-root/ui-probe.mjs` | 统计页、日历、趋势和价格树 UI 探针 |
| `pwa-update.mjs` | `.tmp/audit-root/pwa-probe.mjs` | 本地服务上的 Service Worker A/B 更新策略 |

`results/` 保存对应原始输出，包括专项结果、`unit.log`、`accounting.log` 和 `smoke.log`。其中 `orders-findings.md`、`persistence-findings.md`、`chains-results.md` 是当次审计整理的原始发现记录，不是修复提交。

## 重放命令

从项目根目录执行。纯函数脚本使用项目锁定的 Vite Node：

```powershell
.\node_modules\.bin\vite-node.cmd audit/2026-10-28/orders.ts
.\node_modules\.bin\vite-node.cmd audit/2026-10-28/chains.ts
.\node_modules\.bin\vite-node.cmd audit/2026-10-28/perf.ts
.\node_modules\.bin\vite-node.cmd audit/2026-10-28/perf-large.ts
.\node_modules\.bin\vite-node.cmd audit/2026-10-28/numbers-and-statistics.ts
```

需要真实本地页面的脚本先启动开发服务器：

```powershell
npm run dev
node audit/2026-10-28/orders-ui.mjs http://127.0.0.1:5173
node audit/2026-10-28/plan-members-ui.mjs http://127.0.0.1:5173
node audit/2026-10-28/persistence.mjs
node audit/2026-10-28/statistics-ui.mjs
```

`pwa-update.mjs` 读取本地 `dist/`，测试服务固定使用 `/EzGridApp/` 子路径，因此须先按 Pages 配置构建，再运行：

```powershell
$env:GITHUB_PAGES='true'
npm run build
node audit/2026-10-28/pwa-update.mjs
```

运行产物统一写到 `.tmp/audit-replay/`。该目录可删除，不是审计归档的一部分。

## 临时端口与环境限制

- `orders-ui.mjs`：Chrome CDP `9457`。
- `plan-members-ui.mjs`：Chrome CDP `9458`。
- `persistence.mjs`：Chrome CDP `9555`。
- `statistics-ui.mjs`：Chrome CDP `9557`。
- `pwa-update.mjs`：本地 HTTP `5278`、Chrome CDP `9558`；只服务本地 `dist/`，不连接生产站点或外部服务。
- `orders-ui.mjs`、`plan-members-ui.mjs` 优先使用 `CHROME_PATH`，也会尝试内置候选路径；其余三个浏览器脚本固定使用 `C:/Program Files/Google/Chrome/Application/chrome.exe`。若环境路径不同，需调整为本机 Chrome/Chromium 路径；这属于运行环境限制，不是业务判断。

不要将这些脚本改接到日常浏览器调试端口或已有用户 profile。脚本中的 `resetAll`、导入、删除和恢复操作只针对新建临时 profile 的数据库；另一个 profile 的同源页面不会共享该 IndexedDB。运行前确认测试所用调试端口空闲，避免连接到无关浏览器。

审计发现的修复需要另行设计、写回归测试并提交；本目录本身只保存证据，不自动改变业务逻辑。
