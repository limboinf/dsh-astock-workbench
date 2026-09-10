<div align="center">

# dsh-astock-workbench

**A 股投资工作台 · DeepSeek Harness（dsh）插件**

基于你的真实持仓与投资者画像，给出同花顺给不了的 AI 分析与买卖时机参考；
决策日志与长期账面，沉淀属于你自己的投资纪律。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-blue.svg)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%E6%8F%92%E4%BB%B6-orange)](https://github.com/deepseek-ai/deepseek-harness)

</div>

---

不改动 dsh 核心代码，以插件形式挂载。数字只走本地确定性数据层，模型只负责解读：

```
holdings.csv ────┐
                 ├─→ astock_* 工具（本地确定性计算）──→ 模型生成分析 / 简报 / 复盘
fuyao 行情(主) ──┤
腾讯行情(兜底) ──┘
```

## 让 AI 帮你安装

复制下面整段话，发给你的 AI 编程助手（dsh、Claude Code 等任意 Agent），它会替你完成安装和配置：

```text
请帮我安装 DeepSeek Harness（dsh）插件 dsh-astock-workbench（A 股投资工作台）。

1. 在本机找到 deepseek-harness 仓库目录（常见位置如 ~/work/github/deepseek-harness）；
   如果没有，先 git clone https://github.com/deepseek-ai/deepseek-harness 并执行 pnpm install。
2. 在该仓库目录执行：pnpm dsh plugin --profile web add github:limboinf/dsh-astock-workbench
3. 如果安装报「prepare / 构建授权」类错误（pnpm 10 及以上默认拒绝运行 git 依赖的
   prepare 脚本），在 --profile web 对应 profile 目录的 pnpm-workspace.yaml 中加入：
   allowBuilds:
     dsh-astock-workbench: true
   然后重新执行第 2 步。
4. 验证安装：pnpm dsh --profile headless --dump-config | grep astock
   输出里有 astock-workbench 即为成功。
5. 最后询问我是否有 fuyao（https://fuyao.aicubes.cn）的 API Key：
   有则帮我写入 ~/.dsh/astock-workbench/env 文件（内容一行：export FUYAO_API_KEY=我的Key，
   目录不存在就先创建）；没有则跳过，行情会自动使用腾讯免费接口兜底。
```

## 功能

| 能力 | 入口 | 说明 |
|---|---|---|
| 持仓汇总 | 模型工具 `astock_positions` | 现价、市值、累计盈亏、当日涨跌、换手、权重与合计；总资产 = 持仓市值 + 现金（随行情实时变动） |
| 行情查询 | 模型工具 `astock_quote` | 一次最多 30 只；6 位代码自动识别沪/深/北；股票另补名称/PE/PB |
| 个股诊断 | 模型工具 `astock_analyze` | 趋势/量能/相对强弱判定 + MA、区间位置、量比、持仓上下文（60 日 K 线本地计算，前复权） |
| 个股基本面 | 模型工具 `astock_fundamentals` | 估值（PE-TTM/PB-MRQ）+ 近 4 个单季营收/归母净利及同比环比 |
| 买入 / 清仓记账 | `astock_add_position` / `astock_remove_position` | 同代码加权合并成本；清仓自动补记卖出流水 |
| 卖出流水 | `astock_record_trade` / `astock_trades` | 手动补录历史交易，按代码/日期查询，已实现盈亏统计（合计/笔数/胜率） |
| 截图对账 | 模型工具 `astock_reconcile` | 券商 App 持仓截图 → 逐行抄录 → 本地 diff 预览 → 确认后写入；截图没有的默认保留 |
| 决策日志 | `astock_log_decision` / `astock_decision_logs` | 按交易日追加结构化条目（性质徽标 + 标签维度），AI 不主动落笔，先问后写 |
| 现金余额 | `astock_set_cash` | 录入券商现金余额，总资产随行情实时变动 |
| 手动总资产 | `astock_set_total_assets` | 录入券商口径快照（与现金口径互斥，后设置的生效） |
| 工作台面板 | dsh web 侧边栏 | 宏观驾驶舱：总资产/已实现盈亏卡片、盘中 5s 自动轮询、大盘指数条、决策日志徽标、AI 解读/体检/复盘入口、个性化设置卡 |
| 每日简报 | dsh 原生计划任务 + 技能 `astock-briefing` | 盘后自动生成持仓简报，落盘 `briefings/<日期>.md` |
| 术语图解 | 技能 `astock-explain` + 工具 `astock_show_html` | 术语大白话讲解；小白画像遇难懂术语自动生成可交互 HTML/Canvas，**对话内嵌预览**（沙箱 iframe，不跳浏览器），存档 `explainers/` |
| 快捷命令 | `/portfolio` `/market` `/profile` `/decision-logs` | 不经模型，纯本地直读持仓/大盘/画像/日志 |

## 快速开始

### 1. 安装

前提：本地已有 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（完成一次 `pnpm install`）。

```bash
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add github:limboinf/dsh-astock-workbench
```

pnpm ≥10 首次安装会要求构建授权（git 依赖的 prepare 脚本）：按报错提示把包名写入
`--profile web` 对应 profile 目录的 `pnpm-workspace.yaml`，然后重新 add：

```yaml
allowBuilds:
  dsh-astock-workbench: true
```

更新版本：先 `pnpm dsh plugin --profile web remove dsh-astock-workbench` 再重新 add。

### 2. 配置行情主源 fuyao（重要）

行情主源是 [fuyao](https://fuyao.aicubes.cn)（同花顺金融数据 REST 服务），
请到其官网注册并**自签 API Key**，插件通过 `X-api-key` 请求头调用。
Key 按以下顺序查找：

1. 环境变量 `FUYAO_API_KEY`
2. 数据目录 env 文件 `~/.dsh/astock-workbench/env`（**推荐**，对 dsh 计划任务环境同样生效）
3. 项目根 `.env`（仅开发自检用，已被 `.gitignore` 排除）

推荐把 Key 写进数据目录：

```bash
mkdir -p ~/.dsh/astock-workbench
echo 'export FUYAO_API_KEY=你的Key' >> ~/.dsh/astock-workbench/env
```

> 不配置 Key 插件也能运行：行情自动降级到腾讯免费接口兜底，但深市股票、深市 ETF 等存在
> 已知缺口（部分标的取不到价格），要完整的行情体验建议配置 fuyao。

### 3. 验证

```bash
pnpm dsh --profile headless --dump-config | grep astock   # 配置树出现 astock-workbench
```

打开 dsh web，问模型「看看我的持仓」→ 应触发 `astock_positions` 工具并在侧边栏出现工作台面板。

### 4. 安装技能（可选）

让会话里的「写简报」「持仓截图对账」「术语讲解与图解」遵循同一规范：

```bash
mkdir -p ~/.dsh/skills
cp -R skills/astock-briefing skills/astock-reconcile skills/astock-explain ~/.dsh/skills/
```

## 数据存放位置

所有运行时数据都在**你自己的** dsh 数据工作区（环境变量 `ASTOCK_DATA_DIR`，默认
`~/.dsh/astock-workbench/`，首次运行自动生成），插件安装包不携带任何数据：

```
~/.dsh/astock-workbench/
├── holdings.csv      # 持仓表（列 code,name,shares,cost,sector,note）
├── trades.csv        # 卖出流水（列 date,code,name,action,shares,price,cost,pnl,note）
├── briefings/        # 每日简报
├── decision-logs/    # 交易日决策日志：YYYY-MM-DD.md
├── balance.json      # 可选：资产口径（现金或快照，二选一）
├── profile.json      # 可选：投资者画像（详略/术语/结构 + 一句话自述）
└── env               # 可选：export FUYAO_API_KEY=...
```

两份 CSV 都容忍空行与 `#` 注释行（写回时逐字保留）；存在坏行或重复代码时记账工具会
拒绝写入并提示先修复，防止覆盖丢数据。也可以不手编辑，直接在对话里说
「我买了 600519，100 股，成本 1700」让 AI 记账。CSV 请用 UTF-8 编码保存。

## 本地开发

```bash
npm install
npm run typecheck && npm test   # 类型检查 + node:test 单测
npm run live-check              # 联网实测四类标的：fuyao 主源 + 腾讯兜底全链路
npm run build                   # 产出 lib/（host + client）
```

开发模式挂载、构建细节与踩坑记录见 [`AGENTS.md`](AGENTS.md)。

## 项目文档

- [`CONTEXT.md`](CONTEXT.md) —— 产品使命（AI 投研助理 > 复盘引擎）与语言定义
- [`docs/adr.md`](docs/adr.md) —— 关键决策简化归档（使命定位、投资建议契约）
- [`docs/web-ui注入技术方案-20260903.md`](docs/web-ui注入技术方案-20260903.md) —— 面板注入机制拆解

## 数据源与免责声明

- 持仓行情：[fuyao](https://fuyao.aicubes.cn)（同花顺金融数据 REST）为主源，腾讯公开接口兜底缺口；
  大盘概览走东方财富公开接口。这些均为非官方接口，无契约保证，仅限个人研究使用。
- 本插件**只读行情、只记持仓**，不接任何交易/下单接口。
- AI 输出的分析与买卖参考仅供参考、不构成投资建议，最终决策与后果由用户自行承担。

## License

[MIT](LICENSE)
