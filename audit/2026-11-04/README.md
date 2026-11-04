# M00基线证据（2026-11-04）

产品基线`0d0791a1fb5c1ab94f6e33eee347b621a0d4828e`。结论、环境、限制、下一轮任务见`docs/M00现状与性能基线-2026-11-04.md`。这些脚本是观察工具，成功退出不代表已修复缺陷。

`results/`保留本轮静态结果。重跑统一写`.tmp/m00/`，不覆盖归档；生成器只创建虚构数据，不读取用户Downloads或日常浏览器台账。Node压力集含软删除、链、两模式、拆档和回执；完整输入可由固定种子重建，不额外归档整份虚构快照。

从仓库根运行：

```powershell
node node_modules/vite-node/vite-node.mjs audit/2026-11-04/m00-probes.ts
node audit/2026-11-04/run-perf.mjs
node audit/2026-11-04/run-perf.mjs extended-10k
node node_modules/vite-node/vite-node.mjs audit/2026-11-04/m00-fixtures.ts
node node_modules/vite-node/vite-node.mjs audit/2026-11-04/m00-perf.ts mixed-four-stocks 1000 ledger
# 保存CPU样本，再用不带profiler的一次正式采样恢复同名时长结果：
node --cpu-prof --cpu-prof-name=m00.cpuprofile --cpu-prof-dir=.tmp/m00 node_modules/vite-node/vite-node.mjs audit/2026-11-04/m00-perf.ts mixed 1000 ledger
node node_modules/vite-node/vite-node.mjs audit/2026-11-04/m00-perf.ts mixed 1000 ledger
```

性能任务顺序运行，不与构建/测试/其它压力任务并发。默认每进程60秒总预算；extended-10k为180秒。超时杀自己创建的子进程，保留首次观察与未完成状态，不能补造p95。完整样本5次预热＋20次计时，首尾输出hash相同、输入不变；p95为20项升序第19项。

浏览器探针先启动单独本地服务，各占一个终端；确认端口空闲，不终止用户其它服务：

```powershell
npm run dev -- --host 127.0.0.1 --port 5184 --strictPort
# 另一个终端：
$env:GITHUB_PAGES='true'; npm run build
npm run preview -- --host 127.0.0.1 --port 4184 --strictPort
# 再单独依次运行：
node audit/2026-11-04/m00-browser.mjs http://127.0.0.1:5184
node audit/2026-11-04/m00-production.mjs http://127.0.0.1:4184/EzGridApp/
node audit/2026-11-04/summarize.mjs
```

`browser.mjs`固定Chrome安装路径、使用临时profile与9584/9585调试端口；先确认端口未占用，不接到用户日常浏览器。浏览器仅访问本地服务。store测试经公共AppProvider动作执行；生产性能脚本直接种子写入自己的临时IndexedDB，不是产品页面新增写库通道。

生产测量390×844、CPU4倍、无网络节流、绕过SW；冷缓存与暖缓存分别5＋20次，每次about:blank后导航且验证timeOrigin唯一。ready包括轮询及250ms绘制等待。LCP只是观察窗候选，未测INP；这些结果不代表真机或公网指标。

结果文件：`probes.json`为输入/链与fixture对照；`browser-store.json`为真实数据库观察；`*-ledger/views/validate.json`为正式时序；`perf-run.json`及`perf-extended.json`为完成/超时；`browser-production.json`保存逐次资源、LCP候选、长任务；`fixture-perf.json`为小样本；`m00.cpuprofile`为CPU采样；`summary.json`保存构建、硬件、实际包体及汇总。无真实个人数据、密钥或会话令牌。

最终检查（文档/指南接入后）：

- `m00-final-lint.log`：eslint通过，包含新增审计TS脚本。
- `m00-guide-unit.log`：指南索引4项通过；原有全套35文件、436项结果保留于`m00-tests.log`。
- `m00-fonts.log`：首次文档接入时重新生成两种字重的字体子集。
- `m00-final-build.log`：GitHub Pages子路径生产构建通过，44项预缓存、3307.61KiB。
- `m00-final-guide.log`：最终生产包离线指南36项通过，含20篇文档、M00内链、深链刷新、窄屏与运行时异常检查。
- `m00-accounting.log`：独立浏览器账务专项通过；没有把正向回归通过当作已修复本轮业务反例。

`summary.json`及浏览器性能样本保留**测量时的基线构建**，不是文档接入后的包体。最终构建的文档体积增长单独记在构建日志，不覆盖基线样本。

用户随后要求本地提交，并确认已创建Supabase项目；路线图3.4节补入控制台准备步骤。提交前再次检查的`m00-commit-lint/unit/fonts/build/guide.log`分别保存eslint、指南4项、字体子集、Pages构建及生产离线指南36项结果。该构建44项预缓存、3312.95KiB，字体补入新增文案用字；不把它与原始性能测量构建混用。Supabase接入代码、SQL迁移和工作流配置仍未实施。

发布范围：按用户后续指示整理为本地提交，提交号以Git记录为准；未推送/部署。不要把profile中Vite转译后的行号当作固定源码定位，按函数和文件核对。
