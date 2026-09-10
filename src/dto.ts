/**
 * 面板数据契约（host ⇄ client 唯一的结构化载荷）。
 *
 * 为什么单独一个模块：本文件必须能被 client 半面直接 import——它是纯类型 + 纯
 * 函数，零 import、零 Node 依赖，所以浏览器打包不会被牵连（format.ts 的 import
 * 链带 Node 依赖，client 不能碰）。契约只此一份，两边不再各写一遍。
 *
 * 为什么带数字而不是格式化字符串：数字是事实，字符串是表现。host 只负责算，
 * 显示精度/千分位/涨跌色全归 client。这样改个小数位不用动 host，也不用为了
 * 显示再解析一次数字。
 *
 * 传输通道是可换的：当前挂在 /portfolio 的文本尾巴上（见 encodePayloadTag），
 * 将来换成 Typert AstockService 的 @Remote 返回值时，本文件一行不用改。
 */

/** 载荷版本：client 认不出的版本一律按「无数据」处理，绝不猜字段 */
export const PORTFOLIO_PAYLOAD_VERSION = 1

/** 总资产口径：现金（持仓市值+现金，随行情动）/ 手动快照（静态）/ 纯持仓 */
export type AssetsBasis = 'cash' | 'manual' | 'holdings'

/** 当日盈亏率的分母口径：总资产（与券商一致）/ 退化的持仓市值 */
export type DayPnlBasis = 'total-assets' | 'market-value'

/**
 * 已实现盈亏统计（来源：trades.csv 的卖出流水，见 src/trades.ts）。
 * 「已实现」只统计 action=sell 且 pnl 非空的记录；买入流水不进统计。
 */
export interface RealizedStats {
  /** 累计已实现盈亏（元）；无可计记录（0 笔）时为 null */
  pnl: number | null
  /** 计入统计的卖出笔数 */
  trades: number
  /** 盈利笔数（pnl > 0，不含打平） */
  wins: number
  /** 胜率（%），trades 为 0 时为 null */
  winRate: number | null
  /** 缺卖出价或成本、未计入统计的笔数（可手工补齐后自动计入） */
  skipped: number
}

export interface PortfolioPayloadRow {
  code: string
  name: string
  /** 缺行情时为 null（该行不计入市值/盈亏合计，见 missingQuotes） */
  price: number | null
  cost: number
  shares: number
  marketValue: number | null
  pnl: number | null
  pnlPct: number | null
  /** 今日涨跌幅（%），来自行情的 changePct */
  dayPct: number | null
  turnoverPct: number | null
  /** 占总市值的权重（%） */
  weightPct: number | null
}

export interface PortfolioPayload {
  v: typeof PORTFOLIO_PAYLOAD_VERSION
  /** 行情快照时间（已格式化的展示串，缺行情时 null） */
  quoteTime: string | null
  /** 行情时间落在集合竞价窗口（9:15–9:25）：现价是虚拟撮合参考价 */
  callAuction: boolean
  rows: PortfolioPayloadRow[]
  totals: {
    /** 只累计取到行情的持仓 */
    marketValue: number | null
    /** 不依赖行情，永远全量 */
    costBasis: number
    pnl: number | null
    pnlPct: number | null
    /** 总资产，口径见 assetsBasis */
    assets: number | null
    assetsBasis: AssetsBasis
    /** 现金余额（assetsBasis 为 'cash' 时有值） */
    cash: number | null
    /** 现金/手动快照的截至日期 */
    asOf: string | null
  }
  day: {
    /** 当日盈亏金额，现金流量法（见 format.ts summarize），与券商「当日参考盈亏」同口径 */
    pnl: number | null
    /** 百分比，分母口径见 basis */
    pct: number | null
    basis: DayPnlBasis
  }
  /** 未取到行情、未计入市值/盈亏合计的标的 */
  missingQuotes: string[]
  /** 行情取数失败的原因（成功时 null） */
  quoteError: string | null
}

/**
 * 当日盈亏率的分母：对齐券商「当日参考盈亏」用昨收总资产，而不是持仓市值。
 * 现金口径能精确还原（昨收持仓市值 + 昨收现金）；手动快照直接当昨收总资产用，
 * 偏差只有 dayPnl/总资产 量级。两者都没有时退化为持仓口径。
 *
 * 昨收现金要从今日现金里把当日成交的现金流倒推回去：当日卖出会让今日现金凭空
 * 多一块、买入少一块，直接拿今日现金当昨日现金，分母会连本带利算两遍。
 *
 * 单独导出是因为文本渲染和结构化载荷都要用它——同一个口径只能有一份实现。
 */
export function resolveDayPnlBasis(
  dayPrevValue: number | null,
  cash: number | undefined,
  manualTotalAssets: number | undefined,
  /** 当日净卖出金额（卖出收入 − 买入支出），见 PortfolioSummary.dayCashFlow */
  dayCashFlow = 0,
): { base: number | null; basis: DayPnlBasis } {
  const base = cash !== undefined && dayPrevValue !== null
    ? dayPrevValue + cash - dayCashFlow
    : manualTotalAssets ?? null
  return base !== null && base > 0
    ? { base, basis: 'total-assets' }
    : { base: null, basis: 'market-value' }
}

// ---------- 大盘概览（顶部行情条） ----------

/** 大盘载荷版本：client 认不出的版本按「无数据」处理 */
export const MARKET_PAYLOAD_VERSION = 1

export interface MarketIndexRow {
  /** 6 位指数代码：000001 上证 / 399001 深证 / 399006 创业板 */
  code: string
  name: string
  price: number | null
  change: number | null
  changePct: number | null
  /** 成交额（元） */
  amount: number | null
  /** 涨/跌/平家数；腾讯兜底时为 null */
  up: number | null
  down: number | null
  flat: number | null
  /** 主力净流入（元）；腾讯兜底时为 null */
  netInflow: number | null
}

export interface MarketPayload {
  v: typeof MARKET_PAYLOAD_VERSION
  /** 快照时间 HH:MM:SS */
  time: string | null
  indices: MarketIndexRow[]
  /** 沪深两市合计（只累加上证+深证，创业板含在深市里不重复计，见 sumMarketTotals） */
  totals: {
    up: number | null
    down: number | null
    flat: number | null
    amount: number | null
    netInflow: number | null
  }
  source: 'eastmoney' | 'tencent'
  /** 取数失败原因；成功为 null */
  error: string | null
}

/**
 * 把大盘载荷渲染成一段注入 prompt 的市场背景；没有数据时返回空串。
 *
 * 为什么大盘数字直接写进 prompt，而个股行情不写：模型有 astock_quote 可以自取
 * 更新的个股行情，写死在 prompt 里反而会过期；大盘则没有对应工具，不给它就只能
 * 瞎猜「今天是跟着大盘跌还是自己跌」。这里的数字来自本地 market.ts 的取数与合计，
 * 带着快照时间一起给，模型据此判断时效。
 *
 * 末尾那句「不要复述这些数字」是刚需：不加的话模型会先把大盘背一遍再答题，
 * 正好撞上「回答太长抓不住重点」的老毛病。
 */
export function renderMarketContext(payload: MarketPayload | null): string {
  if (payload === null || payload.error !== null || payload.indices.length === 0) return ''
  const yi = (n: number | null, digits = 0): string => n === null ? '—' : `${(n / 1e8).toFixed(digits)} 亿`
  const pct = (n: number | null): string => n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
  const indices = payload.indices
    .map(r => `${r.name} ${r.price ?? '—'}（${pct(r.changePct)}）`)
    .join(' / ')
  const { up, down, amount, netInflow } = payload.totals
  const lines = [
    `【当前大盘环境（本地取数${payload.time === null ? '' : ` ${payload.time}`}，来源 ${payload.source}）】`,
    `- ${indices}`,
  ]
  if (up !== null || down !== null) {
    lines.push(`- 沪深涨跌家数：涨 ${up ?? '—'} / 跌 ${down ?? '—'}，两市成交 ${yi(amount)}`)
  }
  if (netInflow !== null) {
    lines.push(`- 主力净流入：${netInflow > 0 ? '+' : ''}${yi(netInflow, 1)}`)
  }
  lines.push('这是判断「个股是跟随大盘还是独立行情」的背景，不要复述这些数字，'
    + '除非它与你的结论直接相关。')
  lines.push('')
  return lines.join('\n')
}

// ---------- 文本通道的挂载/解析（Typert 直连落地后这几个函数即可退役） ----------
//
// 命令通道只能返回文本，所以结构化数据挂成一行不可见的 HTML 注释捎回来。
// 按 kind 分标签，portfolio 与 profile 各走各的，互不干扰。

const TAG_CLOSE = '-->'

function tagOpen(kind: string): string {
  return `<!--astock:${kind} `
}

/** 把对象编码成一行 HTML 注释：注释在 markdown 渲染里不可见，又能被精确取出 */
export function encodeTag(kind: string, value: unknown): string {
  return `${tagOpen(kind)}${JSON.stringify(value)}${TAG_CLOSE}`
}

/**
 * 从文本里取出某个 kind 的载荷；没有、坏了都返回 null，由调用方决定回退。
 * 取最后一个：文本可能被追加过（如行情失败提示），以最新的为准。
 */
export function decodeTag<T>(kind: string, text: string): T | null {
  const open = tagOpen(kind)
  const start = text.lastIndexOf(open)
  if (start === -1) return null
  const from = start + open.length
  const end = text.indexOf(TAG_CLOSE, from)
  if (end === -1) return null
  try {
    return JSON.parse(text.slice(from, end)) as T
  } catch {
    return null
  }
}

/** 从 markdown 里剥掉某个 kind 的载荷注释（工具结果给人看时用） */
export function stripTag(kind: string, text: string): string {
  const open = tagOpen(kind)
  const start = text.lastIndexOf(open)
  if (start === -1) return text
  const end = text.indexOf(TAG_CLOSE, start)
  if (end === -1) return text
  return (text.slice(0, start) + text.slice(end + TAG_CLOSE.length)).trimEnd()
}

export function encodePayloadTag(payload: PortfolioPayload): string {
  return encodeTag('portfolio', payload)
}

/** 解析持仓载荷；版本对不上按「无数据」处理，绝不猜字段 */
export function decodePayloadTag(text: string): PortfolioPayload | null {
  const parsed = decodeTag<PortfolioPayload>('portfolio', text)
  return parsed?.v === PORTFOLIO_PAYLOAD_VERSION ? parsed : null
}

export function stripPayloadTag(text: string): string {
  return stripTag('portfolio', text)
}

export function encodeMarketTag(payload: MarketPayload): string {
  return encodeTag('market', payload)
}

/** 解析大盘载荷；版本对不上按「无数据」处理 */
export function decodeMarketTag(text: string): MarketPayload | null {
  const parsed = decodeTag<MarketPayload>('market', text)
  return parsed?.v === MARKET_PAYLOAD_VERSION ? parsed : null
}

// ---------- 个股诊断（astock_analyze → 对话流「诊断书」卡片） ----------
//
// 形态定案（2026-09-06，prototype/p0-1-deep-analysis.html 变体 A）：诊断书 = 确定性
// 判定与数字（本载荷）+ AI 三段白话解读（对话文本，不进载荷）。工具返回什么卡片
// 渲染什么，AI 之后只写「发生了什么/对持仓意味着什么/接下来看什么」。

export const ANALYZE_PAYLOAD_VERSION = 1

/** 压缩 K 线：[日期, 开, 收, 高, 低, 量(手)]，数组形态省载荷体积 */
export type AnalyzeBar = [string, number, number, number, number, number]

export interface AnalyzePayload {
  v: typeof ANALYZE_PAYLOAD_VERSION
  symbol: string
  name: string
  /** 行情快照时间（已格式化） */
  quoteTime: string | null
  price: number | null
  changePct: number | null
  /** 日 K 序列（升序，≤60 根，前复权） */
  bars: AnalyzeBar[]
  klineSource: 'fuyao' | 'tencent' | null
  /** 派生指标，原料不足时为 null（client 不再算第二遍） */
  ma5: number | null
  ma20: number | null
  /** 量比：最新量 / 20日均量 */
  volRatio: number | null
  /** 20 日区间位置（%，0=贴地） */
  pos20: number | null
  low20: number | null
  high20: number | null
  ret5: number | null
  ret20: number | null
  /** 基准指数（创业板个股对创业板指、其余对沪深300） */
  benchName: string | null
  benchRet5: number | null
  /** 相对基准 5 日超额（百分点）：ret5 − benchRet5 */
  relRet5: number | null
  /** 确定性判定标签（趋势/量能/相对强弱/位置），AI 只展开不推翻 */
  tags: { label: string; tone: 'up' | 'down' | 'flat' }[]
  /** 用户持仓上下文；该标的不在持仓中为 null */
  holding: {
    shares: number
    cost: number
    pnl: number | null
    pnlPct: number | null
    weightPct: number | null
  } | null
  /** K 线取数失败原因（现价仍在时非 null 也能出卡） */
  klineError: string | null
}

/** 解析诊断载荷；版本对不上按「无数据」处理 */
export function decodeAnalyzeTag(text: string): AnalyzePayload | null {
  const parsed = decodeTag<AnalyzePayload>('analyze', text)
  return parsed?.v === ANALYZE_PAYLOAD_VERSION ? parsed : null
}

// ---------- astock_show_html：内嵌 HTML 图解载荷 ----------
//
// HTML 是模型生成的自由文本，里面可能出现字面 `-->`（网页自己的注释、JS 惯用法），
// 直接塞进单行注释 tag 会被 TAG_CLOSE 截断。所以 html 先转 base64 再进 tag：
// base64 字母表不含 `-`，天然与注释定界符互斥。

export const HTML_PREVIEW_PAYLOAD_VERSION = 1

export interface HtmlPreviewPayload {
  v: typeof HTML_PREVIEW_PAYLOAD_VERSION
  /** 图解标题（卡片头展示） */
  title: string
  /** 存档文件绝对路径（explainers/） */
  file: string
  /** HTML 全文的 base64（UTF-8） */
  htmlB64: string
}

/** 浏览器/Node 双面可用的 base64 → UTF-8（dto 零 import，不能用 Buffer） */
export function utf8FromBase64(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * 解析内嵌图解载荷；没有、坏了都返回 null，由调用方决定回退展示。
 * html 字段已解码为原文，client 拿到即可直接喂给 iframe srcDoc。
 */
export function decodeHtmlPreviewTag(text: string): { title: string; file: string; html: string } | null {
  const parsed = decodeTag<HtmlPreviewPayload>('htmlpreview', text)
  if (parsed?.v !== HTML_PREVIEW_PAYLOAD_VERSION) return null
  if (typeof parsed.htmlB64 !== 'string' || parsed.htmlB64 === '') return null
  try {
    return {
      title: typeof parsed.title === 'string' && parsed.title !== '' ? parsed.title : '互动图解',
      file: typeof parsed.file === 'string' ? parsed.file : '',
      html: utf8FromBase64(parsed.htmlB64),
    }
  } catch {
    return null
  }
}
