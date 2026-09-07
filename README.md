# dsh-astock-workbench —— A股投资工作台（DeepSeek Harness 插件）

不改动 DeepSeek Harness（dsh）核心代码，以插件形式挂载的 A 股投资工作台。
第一使命 **AI 投研助理**：基于真实持仓与投资者画像，给出同花顺给不了的分析与买卖时机参考；
第二使命 **复盘引擎**：决策日志与长期账面沉淀在 dsh 数据工作区（`ASTOCK_DATA_DIR`，
默认 `~/.dsh/astock-workbench/`，首次运行自动创建，是每个用户自己的数据），帮用户形成自己的投资纪律。
当前能力：**持仓记账 + 实时行情 + 确定性汇总 + 个股诊断/基本面 + AI 每日简报 + 交易日决策日志**。
仓库里的 `CONTEXT.md`、`docs/adr.md` 是开发侧的使命语言与决策记录，不随插件安装分发。

```
数据流（数字只走确定性数据层，LLM 只解读）：
holdings.csv ────┐
                 ├─→ astock_positions 工具（本地计算）──→ 模型生成简报/分析
fuyao 行情(主) ──┤
腾讯行情(兜底) ──┘
```

## 功能

| 能力 | 入口 | 说明 |
|---|---|---|
| 持仓汇总 | 模型工具 `astock_positions` | 现价、市值、累计盈亏、当日涨跌、换手、权重、总市值/总盈亏合计；总资产按下方「资产口径」显示；有卖出流水时附「已实现盈亏（卖出落袋）」合计/笔数/胜率 |
| 行情查询 | 模型工具 `astock_quote` | 一次最多 30 只；6 位代码自动识别沪/深/北；fuyao 主源 + 腾讯兜底；股票另补名称/PE/PB（估值快照） |
| 个股诊断 | 模型工具 `astock_analyze` | 趋势/量能/相对基准强弱的判定标签 + MA5/MA20、20日区间与位置、5/20日收益、量比、持仓上下文（60 日 K 线本地算死，fuyao 主源 + 腾讯兜底） |
| 个股基本面 | 模型工具 `astock_fundamentals` | 估值（PE-TTM/PB-MRQ）+ 财务近 4 个单季（营收/归母净利及同比环比）；fuyao quarterly 返回累计值，本地折算单季；仅股票 |
| 买入记账 | 模型工具 `astock_add_position` | 同代码按股数加权合并成本 |
| 清仓记账 | 模型工具 `astock_remove_position` | 从持仓表移除，并自动补记卖出流水（可传入实际成交价计盈亏） |
| 卖出流水 | `astock_record_trade` / `astock_trades` | 清仓/减仓自动补记到 trades.csv（卖出价按当时行情、成本按本地口径，可手工修正）；支持手动补录历史交易、按代码/日期查流水与累计已实现盈亏统计 |
| 截图对账 | 模型工具 `astock_reconcile` + 技能 `astock-reconcile` | 券商App持仓截图 → 模型逐行抄录 → 本地 diff 预览（新增/更新/一致/未出现）→ 用户确认后带 token 覆盖写入；截图里没有的默认保留，确认清仓才移除；清仓/减仓同步补记卖出流水 |
| 决策日志 | `astock_log_decision` / `astock_decision_logs` | 按交易日追加、读取 Markdown 日志；条目为「时间 + [性质] + 摘要 + 【标签】维度块」结构（契约在 `src/decision-entry.ts`，性质徽标红买绿卖，兼容三种历史写法）；只记录决策，不执行交易；AI 不主动落笔，先问后写 |
| 现金余额 | 模型工具 `astock_set_cash` | 录入券商现金余额；总资产 = 持仓市值 + 现金，随行情实时变动（推荐长期使用） |
| 手动总资产 | `astock_set_total_assets` | 录入券商口径总资产快照（含现金），静态数字直到再次录入；与现金口径互斥，后设置的生效 |
| 决策日志直读 | 斜杠命令 `/decision-logs` | 不经模型，纯本地读取日志列表（工作台面板「刷新日志」走此通道） |
| 快速看仓 | 斜杠命令 `/portfolio` | 不经模型，纯本地计算打印汇总 |
| 大盘概览直读 | 斜杠命令 `/market` | 不经模型，纯本地取数打印三大指数/涨跌家数/成交额/主力净流入（失败不报错，装在载荷 error 字段里由 UI 降级） |
| 画像读写 | 斜杠命令 `/profile` | 不经模型读写投资者画像（详略/术语/结构 + 一句话自述，存 `profile.json`），面板 ⚙ 设置卡走此通道 |
| 每日简报 | `scripts/daily-briefing.sh` | 系统 cron → dsh headless 全新会话 → 简报落盘 `briefings/<日期>.md` |
| 简报规范 | 技能 `astock-briefing` | 约束模型：数字必须引用工具返回、不给投资建议 |

## 数据目录

环境变量 `ASTOCK_DATA_DIR`，默认 `~/.dsh/astock-workbench/`：

```
~/.dsh/astock-workbench/
├── holdings.csv      # 持仓表（首次启动自动生成模板）
├── trades.csv        # 卖出流水（首次启动自动生成模板；清仓/减仓自动补记 + 手动补录，已实现盈亏的数据源）
├── briefings/        # 每日简报输出
├── decision-logs/     # 交易日决策日志：YYYY-MM-DD.md
├── balance.json      # 可选：资产口径（现金 { cash } 或快照 { totalAssets }，二选一）+ { updatedAt, note }
├── profile.json      # 可选：投资者画像（面板 ⚙ 设置卡 / /profile 命令写入）
├── env               # 可选：export DEEPSEEK_API_KEY=...（cron 用）、export FUYAO_API_KEY=...（fuyao 行情主源）
└── cron.log          # 可选：cron 运行日志
```

`holdings.csv` 列：`code,name,shares,cost,sector,note`，`#` 行与空行忽略，股数须为正整数。
`#` 注释行在记账写回时**逐字保留**；表里存在坏行或重复代码时，记账工具会**拒绝写入**并提示先修复（防止覆盖丢数据）。
`trades.csv` 列：`date,code,name,action,shares,price,cost,pnl,note`（action：sell/buy，price/cost/pnl 可留空），
同款文档模型纪律；只统计 `sell` 且 `pnl` 齐备的记录为「已实现盈亏」。
也可以不手编辑，直接在会话里说「我买了 600519，100 股，成本 1700」让 AI 记账。

## 接入 dsh

### 方式 A：GitHub 安装（推荐）

前提：本地有 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库；本插件已托管在 GitHub。
`package.json` 已带 `prepare` 脚本——git 拉取源码后 pnpm 会自动构建 `lib/`，无需手工 build。

```bash
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add github:limboinf/dsh-astock-workbench
```

- **建议锁定 commit**，防止后续推送悄悄改变实际运行的代码：
  `github:limboinf/dsh-astock-workbench#<sha>`。
- **pnpm ≥10 首次 add 会失败**（默认拒绝运行 git 依赖的 prepare 脚本）：按报错提示把包名
  写进 `--profile web` 对应 profile 目录的 `pnpm-workspace.yaml`，然后重新 add：
  ```yaml
  allowBuilds:
    dsh-astock-workbench: true
  ```
  构建授权等于允许该包代码在安装期于本机执行（不在 agent 沙箱内），只应对可信源码授权。
- 更新版本：先 `pnpm dsh plugin --profile web remove dsh-astock-workbench` 再重新 add（锁定
  sha 的换新 sha）。
- 其他安装形态（npm 包名 / tarball）与机制说明见官方文档
  [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。

### 方式 B：开发模式（源码直载，改插件时用这个）

前提：同上，另需完成一次 dsh 的 `pnpm install` + `pnpm run build:lib`。

```bash
cd /path/to/deepseek-harness
pnpm dsh --profile web --patch /path/to/dsh-astock-workbench/cordis.dev.patch.yml
```

> 注意：本仓库当前版本的 CLI 里 `--patch` 是根启动器参数，要写在 `web` 之前
> （等价写法 `pnpm dsh --profile web --patch <文件>`，文档里的 `dsh web --patch` 写法会报 unknown option）。
> 若 3080 端口已被别的 dsh 实例占用，复制 `cordis.dev.patch.yml` 并追加一段
> `webserver` 覆盖（config 是整行替换，需带上 `host`/`compression` 等完整字段，参考
> `deepseek-harness/packages/bundle/web-app/cordis.patch.yml:116`）把端口改到 3081。

### 方式 C：安装模式（本地路径，免发布）

```bash
npm run build                                    # 产出 lib/index.js 与 lib/client.js
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-astock-workbench
```

装完插件行会写进 profile 层，之后 `pnpm dsh` 直接生效。

### 验证

```bash
# 1) 配置树里出现 astock-workbench 行
pnpm dsh --profile headless --patch /path/to/dsh-astock-workbench/cordis.dev.patch.yml --dump-config | grep astock   # 开发模式（带 --patch）
pnpm dsh --profile headless --dump-config | grep astock                                                              # GitHub/本地安装（不带 --patch）
# 2) 打开 web 后问模型：「看看我的持仓」→ 应触发 astock_positions 工具
```

## 每日简报（cron）

```bash
# 编辑 cron：crontab -e，加入（周一到周五 16:10，收盘后留足数据稳定时间）
10 16 * * 1-5 /path/to/dsh-astock-workbench/scripts/daily-briefing.sh >> "$HOME/.dsh/astock-workbench/cron.log" 2>&1
```

脚本会：加载 `~/.dsh/astock-workbench/env` 里的 API key → 在数据目录起一个
headless 全新会话 → 模型调 `astock_positions` 取数 → 简报（stdout）写入
`briefings/<日期>.md`。

## 安装简报/对账技能（可选）

让交互式会话里的「写简报」「持仓截图对账」遵循同一规范：

```bash
mkdir -p ~/.dsh/skills
cp -R skills/astock-briefing skills/astock-reconcile ~/.dsh/skills/
```

## Web UI（浏览器半面，P0+P1 已上线）

不改动 dsh 仓库，以 client 插件形式把组件注入 dsh web（机制见
`docs/web-ui注入技术方案-20260903.md`）：

| 能力 | 注册点 | 状态 |
|---|---|---|
| 右侧停靠面板「工作台」（对话在左、面板在右；可拖拽调宽 320–860px，双击手柄重置，开合与宽度持久化；展开时自动收起原生 Details 避免叠压） | `shell.overlay` | ✅ |
| 面板真数据（零 mock）：订阅会话内 astock_positions 工具结果，空表显示自然语言录入引导 | client 数据层 | ✅ |
| 自然语言 CRUD：对话里说「我买了 600519，100 股，成本 1700」即记账；加仓自动加权、清仓即删；面板随之同步（写操作后提示刷新） | astock_* 工具 | ✅ |
| astock_* 工具结果渲染成红涨绿跌表格 | `tool.call.toolview` | ✅ |
| 输入框「📈 持仓」「📰 简报」快捷按钮 | `conversation.input.left` | ✅ |
| 面板 ✦ 分析 / AI 解读 / AI 体检 → 引入对话（回复就在左侧对话里） | `ConversationController.send` | ✅ |
| 面板「↻ 刷新」直接执行 `/portfolio`（不发送 AI 对话消息）；首屏自动加载持仓与决策日志；加载就绪后不再随会话切换重拉 | `remote.commands.execute` | ✅ |
| 盘中自动轮询：交易时段（周一~五 9:10–11:35、12:55–15:05）每 5s 自动执行 `/portfolio`（带秒级倒计时、取数互斥防重叠），页面隐藏/收起面板时停 | client + `remote.commands` | ✅ |
| 面板取数走影子会话（侧栏中名为「📊 A股工作台 · 面板数据」）：命令的 run/done 事件都落在专用会话里，不污染真实对话。id 记在 localStorage，adopt 失败（日志被 kill 弄坏 / cwd 变更）就换新 id 重建；拿不到影子会话时**放弃取数而非退回当前会话**（fail-closed）。影子会话日志随盘中轮询增长，可整会话删除，正路见下行 Typert 待办 | `sessions.create`（幂等 adopt） | ✅ |
| 面板数据走结构化载荷：`/portfolio` 输出末尾挂一行不可见的 HTML 注释承载 JSON（契约在 `src/dto.ts`，host/client 共享同一份），面板不再用正则啃中文文案——改文案不会再打断解析（2026-09-04） | `src/dto.ts` | ✅ |
| 总资产卡片（现金口径「持仓市值+现金」/ 手动快照 / 持仓口径，自动切换） | client + `astock_positions` + `astock_set_cash` + `astock_set_total_assets` | ✅ |
| 已实现盈亏卡片（卖出落袋合计 · 笔数 · 胜率；无卖出记录时不占位） | client + trades.csv 载荷 | ✅ |
| 个股/基金行情链接、个股 F10 链接 | Eastmoney / 同花顺 | ✅ |
| 交易日决策日志（按月分组折叠、点击展开 Markdown、结构化条目徽标渲染——性质/标签着色，兼容三种历史写法；AI 复盘/AI 体检入口，记录走自然语言，无独立记录按钮） | `astock_*_decision*` + `src/decision-entry.ts` | ✅ |
| 顶部大盘条：三大指数（点位/涨跌额/涨跌幅）、沪深涨跌家数进度条、两市成交额、主力净流入；与持仓同频 5s 轮询，与持仓行情是两条独立链路（大盘挂了不影响持仓表） | `/market` + client | ✅ |
| 大盘环境注入 AI 入口：✦ AI 解读、个股四问、AI 体检、AI 复盘、📰 简报发送前自动带上当前指数/涨跌家数/成交额/资金流（含快照时间与来源），模型据此判断个股是跟随大盘还是独立行情；纯操作类入口（记录决策日志、看看我的持仓）不带，省 prompt 预算 | `linkSend` + `renderMarketContext` | ✅ |
| 个性化设置卡（面板头部 ⚙）：详略（速览/标准/深度）、术语（解释/不解释）、结构（结论先行/论证先行）+ 一句话自述，存 `profile.json`，经 `/profile` 命令读写（不经模型）。保存后自动给所有面板 ✦ 入口的 prompt 加前缀——注入点唯一（`linkSend`），加新按钮不用重复拼 | `/profile` + client | ✅ |
| 个股 ✦ 按意图分流：「今天为什么这么走 / 该加该减还是不动 / 它在我组合里的问题 / 完整分析」，每个只取自己要的数据、只答自己那一段。开放问题会让模型用「全面覆盖」对冲不确定性，收窄入口比配置输出更有效 | client | ✅ |
| 面板免对话直连数据（AstockService/Typert Remote）：换掉命令通道，影子会话随之退役。载荷契约（`src/dto.ts`）已就位，届时只换传输、DTO 与 client 消费代码不动 | R2 | ⬜ 待做 |

开发模式（client 半面**必须先构建**，源码直载只对 Host 生效）：

```bash
npm run build:client   # 产出 lib/client.js（闭包工厂格式）
cd /path/to/deepseek-harness
pnpm dsh --profile web --patch /path/to/dsh-astock-workbench/cordis.dev.patch.yml --no-open --port 3081
```

改了 `src/client/index.ts` 后：`npm run build:client` + 重启 dsh web（client 产物
启动时快照，暂无 HMR）。设计纪律与 Host 半面一致：只值导入 react（模块表基线），
不 import 任何 `@deepseek-ai/*` 运行时符号，ctx 类型自声明。

## 自检与测试

```bash
npm run typecheck   # tsc --noEmit
npm test            # 单测（CSV 解析/合并、行情解析、汇总计算、决策日志、apply 注册面）
npm run live-check  # 联网实测四类标的（沪/深股票、沪/深 ETF）：fuyao 主源路由 + 腾讯兜底全链路
npm run build       # tsdown 产出 lib/index.js
```

## 设计纪律（为什么这么写）

1. **零运行时依赖**：不 import 任何 `@deepseek-ai/*` 运行时符号，工具用裸
   JSON-Schema 注册——dsh 还在 developer preview，破坏性变更频繁，这样插件最耐用。
2. **只读行情、只记持仓**：不接任何交易/下单接口。
3. **行情双源口径**：fuyao（同花顺金融数据，REST + X-api-key）为主源——股票批量快照、
   ETF 逐只快照、人工查询另调估值快照补名称/PE/PB；腾讯免费接口兜底 fuyao 缺口
   （深市股票空价、深市 ETF 未开放、北交所、盘前重置窗口，2026-09-04 实测）。
   两源契约固化在 `src/fuyao.ts` 头注与 `quotes.ts`；fuyao 需官网自签 Key，
   未配置时自动降级为纯腾讯链路。

## 已知限制（MVP）

- 行情以实时快照为主；历史 K 线仅 `astock_analyze` 内部的 60 日日K窗口（前复权，fuyao 主源 + 腾讯兜底，
  深市/指数的腾讯 K 线兜底尚未实测），不支持任意区间回看。
- 持仓是「快照表 + 卖出流水」：清仓/减仓会自动补记卖出流水并计入已实现盈亏；买入仍走加权成本
  没有逐笔交割单导入（后续做场景③交易复盘再上）。自动补记的卖出价是当时行情快照、成本是本地口径，
  与真实成交可能有出入，可在 trades.csv 手工修正。
- 截图对账依赖模型的视觉读数，可能抄错小数位——因此强制两段式（预览差异表 → 用户确认 → 带 token 写入），
  且 token 绑定行集与持仓文件，确认前后任何变化都会拒绝写入。
- “总资产”默认等于有行情覆盖部分的持仓市值（不含现金）；两种可选资产口径（互斥，后设置的生效）：
  `astock_set_cash` 录入现金后总资产 = 持仓市值 + 现金（随行情实时变动，贴合长期使用）；
  `astock_set_total_assets` 录入券商口径快照（静态数字，行情波动不改变它）。行情缺失时会明确标注覆盖范围。
- 持仓表暂未增加资产类型字段；前端对 5/15/16/18 开头代码按“可能是基金”保守处理，基金显示 Eastmoney 行情入口，不显示个股 F10。
- 简报里「涨跌原因/消息面」依赖模型自带知识或搜索工具，未接专门资讯源。
- fuyao 实测缺口（2026-09-04）：深市股票快照「有壳无价」、深市 ETF 报 3002 未开放、
  北交所代码报 1002、盘前重置窗口全清空——均已自动回落腾讯兜底，面板/简报不受影响。
- 腾讯兜底接口是无契约的免费接口（GBK 编码，依赖 Node 发行版自带 full-ICU，
  `engines.node >= 18`），仅个人研究用。
- 代码前缀按首位数字推断：沪市可转债（11xxxx 开头）会被归到深市，暂只支持股票代码（规则在 `src/symbols.ts`）。
- `holdings.csv` 按 UTF-8 读写：Excel 直接保存的 GBK CSV 名称会乱码，请用文本编辑器或「另存为 CSV UTF-8」。

## 项目文档

- `CONTEXT.md` —— 产品使命（AI 投研助理 > 复盘引擎）、语言定义与「场景价值」功能判决尺
- `docs/adr.md` —— 关键决策简化归档（产品使命定位、投资建议契约，含被否方案）
- `docs/web-ui注入技术方案-20260903.md` —— client 注入机制拆解（动 Web UI 前置阅读）

## 路线图

- [ ] 净值曲线（总资产随时间）
- [ ] 每周深度复盘：AI 起草、用户过目补充后落 `reviews/`（起草-确认制，见 CONTEXT.md）
- [ ] 场景②：公告/龙虎榜/大宗交易异动监控 → 推送（对接 dsh-im 或系统通知）
- [ ] 场景③：交割单 CSV 导入 + 交易行为复盘周报
- [ ] 场景④：持仓体检（行业集中度、回撤、对比沪深300）
- [ ] 场景⑤：买入前多 Agent 个股研究流水线（借鉴 TradingAgents）
- [ ] Web UI P2：简报列表视图 + 简报「讨论」联动、完整持仓面板
