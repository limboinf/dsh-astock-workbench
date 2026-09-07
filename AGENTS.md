# dsh-astock-workbench —— Agent 工作指引

A股投资工作台，以插件形式挂载到 DeepSeek Harness（dsh），**不改动 dsh 核心代码**。
MVP：持仓记账 + 实时行情 + 确定性汇总 + AI 每日简报。

- dsh 源码仓库（本机）：`/Users/limbo/work/github/deepseek-harness`（需先 `pnpm install` + `pnpm run build:lib`）
- 插件开发官方文档：https://deepseek-harness.github.io/deepseek-harness/develop/basic
- 仓库根 README.md 有完整的接入/验证命令，改动部署相关内容时先同步读它

## 常用命令

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test test/*.test.ts（node:test，无 vitest/jest）
npm run live-check  # 联网实测四类标的（沪/深股票、沪/深 ETF）：fuyao 主源路由 + 腾讯兜底全链路自检
npm run build       # tsdown → lib/index.js（ESM，无 dts）
```

## 目录结构

```
src/index.ts    插件入口（export name/inject/apply），注册 13 个 astock_* 工具 + /portfolio、/decision-logs 命令
src/holdings.ts 持仓 CSV 解析/加权合并/清仓/覆盖写（文档模型：注释/坏行原样保留），纯函数，单测覆盖
src/trades.ts   成交流水 trades.csv（文档模型同 holdings）：清仓/减仓自动补记 + 手动补录，
                已实现盈亏统计（合计/笔数/胜率/skipped）；卖出价=当时行情、成本=本地口径，可手工修正；
                collectDayTurnover 按标的聚合当日成交，供 format.ts 算当日盈亏
src/balance.ts  手动资产口径（balance.json）：现金（总资产=持仓市值+现金，随行情变动）与快照（静态数字）互斥，后写覆盖
src/reconcile.ts 持仓对账：外部行集校验/diff/token 两段式写入（模型只抄数，校验与写入全在本地）
src/symbols.ts  股票代码规范化（sh/sz/bj 前缀规则单一来源，holdings/quotes 共用）
src/fuyao.ts    fuyao（同花顺）REST 客户端与 key 解析（env 变量→数据目录 env→包内 .env）；接口契约实测固化在头注
src/quotes.ts   行情取数与解析：fuyao 主源（股票批量/ETF 逐只/估值补名）+ 腾讯兜底缺口；腾讯字段下标固化在 IDX
src/format.ts   展示层：市值/盈亏/权重等全部确定性计算与文本渲染 + 结构化载荷构造
src/market.ts   大盘概览：东财 push2 主源 + 腾讯兜底，接口契约与字段号固化在头注。
                与 quotes.ts 是两条独立链路，所有失败收敛成 payload.error 不外抛
src/kline.ts    日K取数与统计：fuyao 主源 + 腾讯兜底，供 astock_analyze 的
                趋势/量能/相对强弱判定（60 日窗口，前复权）
src/fundamentals.ts 个股基本面：估值快照 + 财务近4季单季折算（fuyao quarterly 实为
                年初至今累计值，本地差分成单季；2026-09-07 收编模型自取数 curl 链路）
src/profile.ts  投资者画像契约（纯类型 + 纯函数、零 import，client 直接 import）：
                档位定义、宽松校验、渲染成 prompt 前缀
src/profile-store.ts  画像落盘（profile.json，带 fs，host 专用）
src/decision-entry.ts 决策日志条目契约（纯类型 + 纯函数、零 import，client 直接 import）：
                条目标题行/标签块解析、性质与标签着色组、墙文切段（兼容三种历史写法）
src/dto.ts      面板数据契约（host ⇄ client 唯一载荷）：纯类型 + 纯函数、零 import，
                所以 client 半面能直接 import，两边不再双写。换传输通道时本文件不动
test/           node:test 单测（CSV、行情解析、汇总计算、apply 注册面）
scripts/        live-check.ts
skills/astock-briefing/  简报规范技能（约束模型：数字必须引用工具返回、不给投资建议）
skills/astock-reconcile/ 截图对账技能（约束模型：逐行抄数、两段式确认、token 原样传递）
docs/           web-ui注入技术方案-20260903.md（待 review 的 Web UI 计划）
cordis.dev.patch.yml  开发模式：源码直载（name 指向 ./src/index.ts）
cordis.patch.yml      安装模式：以 npm 包名插入
```

## 设计纪律（改代码前必读，违反即破坏本项目核心原则）

1. **零运行时依赖（Remote 边界外）**：不得 import 任何 `@deepseek-ai/*` 运行时符号。
   工具用裸 JSON-Schema 注册，context 类型在 `src/index.ts` 里自声明（刻意宽松），
   以抵御 dsh developer preview 的破坏性变更。
   **唯一例外**（2026-09-04 拍板）：将来落地 Typert 直连时，`TypertRemoteService`
   与 `@Remote` 装饰器必须 import dsh 符号，允许且只允许出现在 `src/remote.ts`
   这一个文件里——爆炸半径限定在单文件 + 构建配置，其余模块纪律不变。
2. **只读行情、只记持仓**：不接任何交易/下单接口。
3. **行情接口口径**：持仓行情走 fuyao（同花顺金融数据 REST，需官网自签 Key）主源、
   腾讯免费接口兜底其缺口；大盘概览走东财 push2 主源、腾讯兜底（见 src/market.ts）。
   东财/腾讯都是**非官方公开接口，无契约保证**——字段号固化在常量、实测样本进单测、
   解析失败逐项降级并在 UI 标注数据源，是这类源的统一纪律（深市股票空价/深市 ETF 未开放/北交所/盘前重置，2026-09-04 实测）。
   两源契约与字段名固化在 `src/fuyao.ts` 头注与 `quotes.ts`（腾讯字段下标在 IDX，
   `test/quotes.test.ts` 有兜底）。解析失败逐标的兜底并在输出中标注 ⚠️；
   fuyao 未配置 Key 时自动降级纯腾讯链路。

## 代码约定

- TypeScript strict + ESM（`"type": "module"`）；`verbatimModuleSyntax` 开启，
  类型导入必须 `import type`；相对导入带 `.ts` 扩展名（`allowImportingTsExtensions`）。
- 代码注释与用户可见文案均为中文；注释风格是「设计纪律」式的（解释为什么这么写）。
- 股票代码统一规范化为带 `sh/sz/bj` 前缀的小写形式（单一来源 `src/symbols.ts`，
  勿在别处复制规则）；纯 6 位数字按首位补前缀：6/5/9→sh，0/3/1/2→sz，4/8→bj。
  已知限制：沪市可转债 11xxxx 会被归到 sz（README 已知限制有记录）。
- holdings.csv 列 `code,name,shares,cost,sector,note`；容忍空行与 `#` 注释行；
  坏行跳过并返回 warnings；坏行/重复代码未清理前，记账工具拒绝写回
  （fail-closed 防覆盖丢数据），注释行写回时逐字保留（holdings.ts 的文档模型）。
- 当日盈亏用现金流量法（format.ts summarize）：逐只算
  `(现市值 + 当日卖出收入) − 昨收×昨日股数 − 当日买入支出`，昨日股数由
  `现股数 + 当日卖出 − 当日买入` 反推。老口径 `Σ(现价−昨收)×现股数` 会把当日加仓
  的股份从昨收起算、把当日清仓的标的整只丢掉（2026-09-07 实测差 1,490 元）。
  **代价：口径正确性依赖记账纪律** —— 当日成交必须落到 trades.csv 才算得准：
  清仓/减仓走 astock_remove_position / astock_reconcile 自动补记；加仓要给
  astock_add_position 传 `tradeDate`（不传只更新持仓表，退回昨收口径少算一段——
  这是刻意的 fail-safe：把历史持仓补录当成当日买入错得远比漏记严重）。
  流水缺成交价、或当日清仓标的取不到行情时，summary.dayGaps 出提示，绝不猜数。
- 数据目录：环境变量 `ASTOCK_DATA_DIR`，默认 `~/.dsh/astock-workbench/`（含
  holdings.csv、trades.csv（卖出流水）、briefings/、可选 env 文件存
  FUYAO_API_KEY（行情主源；另项目根 `.env` 供开发自检，已在 .gitignore）。

## dsh 接入的坑

- 开发模式（源码直载，改动后无需构建）：
  ```bash
  cd /Users/limbo/work/github/deepseek-harness
  pnpm dsh --profile web --patch /Users/limbo/work/github/dsh-astock-workbench/cordis.dev.patch.yml
  ```
  ⚠️ `--patch` 是根启动器参数，必须写在 `web` **之前**；`dsh web --patch` 写法会报 unknown option。
  ⚠️ **「无需构建」只对 host 半面成立**（`cordis.dev.patch.yml` 直载 `src/index.ts`），
  且 host 是常驻进程、tsx 只在启动时加载一次 —— 改了 `src/*.ts` 必须**重启 dsh**。
  client 半面（`src/client/index.ts`）走包的 `./client` 导出，即 `lib/client.js`，
  改完必须 `npm run build:client` 再刷新浏览器。两边不同步会出「前端解析不到后端文本」
  这类假故障（2026-09-04：改了合计行文案，host 未重启 → 面板当日盈亏显示为空）。
- 3080 端口被占时：复制 `cordis.dev.patch.yml` 追加 `webserver` 覆盖改端口——
  config 是整行替换，必须带全 `host`/`compression` 等字段（参考
  `deepseek-harness/packages/bundle/web-app/cordis.patch.yml:116`）。
- 安装模式：`npm run build` 后在 dsh 仓库执行 `pnpm dsh plugin --profile web add <本仓库路径>`。
- 验证插件挂载：`pnpm dsh --profile headless --patch <dev.patch> --dump-config | grep astock`。

## 敏感区前置阅读

- 动 Web UI / client 半面（浏览器侧组件）之前：读 `docs/web-ui注入技术方案-20260903.md`
  （含 dsh.client 清单、闭包工厂打包格式等机制拆解），原则仍是 dsh 仓库零改动。
- 动简报输出格式/数据纪律之前：读 `skills/astock-briefing/SKILL.md`，简报结构改动需同步该技能。
