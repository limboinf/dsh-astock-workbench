/**
 * 展示层 —— 把持仓 + 行情拼成确定性文本。
 * LLM 只负责解读这段文本，不参与任何数字计算。
 */

import type { Position } from './holdings.ts'
import { formatQuoteTime, type Quote } from './quotes.ts'
import type { DayTurnover } from './trades.ts'

export interface PositionRow {
  position: Position
  quote?: Quote
  /** 现价（行情缺失时 undefined） */
  price?: number
  marketValue: number | null
  /** 累计盈亏额 */
  pnl: number | null
  /** 累计盈亏率（%） */
  pnlPct: number | null
}

export interface PortfolioSummary {
  rows: PositionRow[]
  /** 总资产：当前仅按持仓市值口径，不含现金余额 */
  totalAssets: number | null
  /** 总市值：只累计取到行情的持仓（部分覆盖时配合 missingQuotes 与脚注解读） */
  totalMarketValue: number | null
  /** 持仓成本合计：不依赖行情，离线/部分缺行情时也是全量口径 */
  totalCostBasis: number
  /** 累计盈亏合计：只累计取到行情的持仓 */
  totalPnl: number | null
  /** 累计盈亏率（%）：totalPnl / 有行情部分的成本合计（部分覆盖时与 totalPnl 同口径） */
  totalPnlPct: number | null
  /** 当日盈亏金额（元）：现金流量法，见 summarize，与券商「当日参考盈亏」同口径 */
  dayPnl: number | null
  /** 当日盈亏率（%）：dayPnl / 昨收持仓市值，持仓口径；券商口径见 renderSummaryText */
  dayPnlPct: number | null
  /** 昨收持仓市值：Σ(昨收_i × 昨日股数_i)，与 dayPnl 同覆盖；供上层换算「占总资产」口径 */
  dayPrevValue: number | null
  /** 当日净卖出金额（卖出收入 − 买入支出）：上层倒推昨收现金用，见 resolveDayPnlBasis */
  dayCashFlow: number
  /** 当日有成交却算不进当日盈亏的标的（缺行情或流水缺成交价），由展示层出提示 */
  dayGaps: string[]
  /** 行情缺失、未计入市值/盈亏合计的标的 */
  missingQuotes: string[]
}

import {
  encodePayloadTag,
  PORTFOLIO_PAYLOAD_VERSION,
  resolveDayPnlBasis,
  type AssetsBasis,
  type PortfolioPayload,
  type RealizedStats,
} from './dto.ts'

export function summarize(
  positions: Position[],
  quotes: Map<string, Quote>,
  /** 当日成交（按标的聚合，见 trades.ts collectDayTurnover）；不传等同当日无成交 */
  dayTurnover?: Map<string, DayTurnover>,
): PortfolioSummary {
  const rows: PositionRow[] = positions.map(position => {
    const quote = quotes.get(position.code)
    const price = quote?.price
    const marketValue = price !== undefined ? price * position.shares : null
    const pnl = marketValue !== null ? marketValue - position.cost * position.shares : null
    const pnlPct = pnl !== null ? ((price! - position.cost) / position.cost) * 100 : null
    return { position, quote, price, marketValue, pnl, pnlPct }
  })

  // 持仓成本不依赖行情，永远全量累计；市值/盈亏只累计取到行情的行，
  // 避免「一只缺行情、全部合计消失」——缺行情的标的记入 missingQuotes，
  // 由展示层脚注明示覆盖口径。
  let totalCostBasis = 0
  let coveredMarketValue: number | null = null
  let coveredCostBasis = 0
  let coveredPnl = 0
  // 当日盈亏用现金流量法，逐只算：
  //   当日盈亏 = 期末价值 − 期初价值 − 当日净投入
  //            = (现市值 + 当日卖出收入) − 昨收 × 昨日股数 − 当日买入支出
  //   昨日股数 = 现股数 + 当日卖出股数 − 当日买入股数
  // 为什么不是老的 Σ(现价−昨收)×现股数：当日加仓的股份，昨收到成交价那一段涨跌
  // 不归你（券商从成交价起算）；当日清仓的标的更是整只从 holdings.csv 消失，当天
  // 赚的钱凭空蒸发。这两处 2026-09-07 实测合计差 1,490 元。
  // 现金流量法对「隔夜持有 / 当日买入 / 当日卖出 / 日内买卖」四种情形是同一个式子，
  // 不需要 FIFO 逐笔配对——昨日股数的反推自动兜住。
  // 不用 Σ(市值×涨跌幅%)/Σ(市值) 的近似——金额和百分比要同源，否则拿百分比反乘市值对不上金额。
  // 这里的 dayPnlPct 是持仓口径；对券商展示的百分比在 renderSummaryText 换成总资产口径。
  let dayPnl = 0
  let dayPrevValue = 0
  let dayCashFlow = 0
  // 当日口径单独判定覆盖：当日清空持仓后 rows 为空、市值合计没覆盖，
  // 但当日盈亏依然存在（就是那几笔卖出赚的钱），不能跟着市值一起变 null
  let dayCovered = false
  const dayGaps: string[] = []
  const missingQuotes: string[] = []
  const turnoverUsed = new Set<string>()
  for (const row of rows) {
    totalCostBasis += row.position.cost * row.position.shares
    if (row.marketValue === null || row.pnl === null) {
      missingQuotes.push(row.position.code)
      continue
    }
    coveredMarketValue = (coveredMarketValue ?? 0) + row.marketValue
    coveredCostBasis += row.position.cost * row.position.shares
    coveredPnl += row.pnl
    if (row.quote) {
      const t = dayTurnover?.get(row.position.code)
      if (t !== undefined) turnoverUsed.add(row.position.code)
      const net = t === undefined ? 0 : t.sellAmount - t.buyAmount
      const prevShares = row.position.shares + (t?.sellShares ?? 0) - (t?.buyShares ?? 0)
      const prevValue = row.quote.prevClose * prevShares
      dayPnl += row.marketValue + net - prevValue
      dayPrevValue += prevValue
      dayCashFlow += net
      dayCovered = true
      if (t !== undefined && t.skipped > 0) {
        dayGaps.push(`${t.name || t.code}（${t.skipped} 笔成交缺成交价）`)
      }
    }
  }
  // 当日清仓的标的：已不在 holdings.csv 里，但当天赚的钱要计入当日盈亏。
  // 现市值恒为 0，其余同上式；行情（昨收）由上层补取，取不到就只出提示不猜数。
  for (const t of dayTurnover?.values() ?? []) {
    if (turnoverUsed.has(t.code)) continue
    const quote = quotes.get(t.code)
    if (quote === undefined) {
      dayGaps.push(`${t.name || t.code}（当日有成交但未取到行情）`)
      continue
    }
    const net = t.sellAmount - t.buyAmount
    const prevValue = quote.prevClose * (t.sellShares - t.buyShares)
    dayPnl += net - prevValue
    dayPrevValue += prevValue
    dayCashFlow += net
    dayCovered = true
    if (t.skipped > 0) dayGaps.push(`${t.name || t.code}（${t.skipped} 笔成交缺成交价）`)
  }
  const hasCoverage = coveredMarketValue !== null
  const totalPnlPct = hasCoverage && coveredCostBasis > 0 ? (coveredPnl / coveredCostBasis) * 100 : null
  const dayPnlPct = dayCovered && dayPrevValue > 0 ? (dayPnl / dayPrevValue) * 100 : null
  return {
    rows,
    totalAssets: coveredMarketValue,
    totalMarketValue: coveredMarketValue,
    totalCostBasis,
    totalPnl: hasCoverage ? coveredPnl : null,
    totalPnlPct,
    dayPnl: dayCovered ? dayPnl : null,
    dayPnlPct,
    dayPrevValue: dayCovered ? dayPrevValue : null,
    dayCashFlow,
    dayGaps,
    missingQuotes,
  }
}

function fmt(n: number | null | undefined, digits = 2, suffix = ''): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + suffix
}

function fmtSigned(n: number | null | undefined, digits = 2, suffix = ''): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : ''
  return sign + fmt(n, digits, suffix)
}

/**
 * 集合竞价时段（9:15–9:25）判断：此时现价是虚拟撮合参考价，9:25 才定开盘价。
 * 只看行情时间字符串里的 HH:MM，不校验星期——非交易日不存在该时段的行情快照。
 * client 半面另有一份同口径实现（src/client/index.ts），那边不能 import 本模块
 * （import 链带 Node 依赖，浏览器打包会炸），改动时两处同步。
 */
function isCallAuctionTime(quoteTime: string): boolean {
  const m = / (\d{2}):(\d{2}):\d{2}/.exec(quoteTime)
  if (m === null) return false
  const t = Number(m[1]) * 60 + Number(m[2])
  return t >= 555 && t < 565
}

/** 全量持仓概览（模型工具 astock_positions 的输出，也是 /portfolio 命令的输出） */
export function renderSummaryText(
  summary: PortfolioSummary,
  quoteTime?: string,
  manualTotalAssets?: { value: number; updatedAt: string },
  /** 现金口径：总资产 = 持仓市值 + 现金，随行情变动（与快照口径互斥，由调用方保证只传其一） */
  cash?: { value: number; updatedAt: string },
  /** 已实现盈亏统计（trades.csv 卖出流水）；无卖出记录时调用方不传，保持输出不变 */
  realized?: RealizedStats,
): string {
  const lines: string[] = []
  const withMv = summary.rows.filter(r => r.marketValue !== null)
  lines.push('## 持仓概览')
  lines.push('')
  lines.push('| 代码 | 名称 | 现价 | 成本 | 股数 | 市值 | 累计盈亏 | 盈亏率 | 今日 | 换手 | 权重 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const row of summary.rows) {
    const name = row.position.name || row.quote?.name || '—'
    const weight =
      row.marketValue !== null && summary.totalMarketValue !== null && summary.totalMarketValue > 0
        ? fmt((row.marketValue / summary.totalMarketValue) * 100, 1, '%')
        : '—'
    const turnover = row.quote?.turnoverPct
    lines.push(
      [
        row.position.code,
        name,
        fmt(row.price),
        fmt(row.position.cost),
        String(row.position.shares),
        fmt(row.marketValue),
        fmtSigned(row.pnl),
        fmtSigned(row.pnlPct, 2, '%'),
        row.quote ? fmtSigned(row.quote.changePct, 2, '%') : '—',
        turnover !== undefined ? fmt(turnover, 2, '%') : '—',
        weight,
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
    )
  }
  lines.push('')
  lines.push('## 合计')
  if (cash !== undefined) {
    // 现金口径：总资产 = 有行情覆盖的持仓市值 + 现金，随行情滚动更新
    // （覆盖范围与市值合计同口径，部分缺行情时沿用下方 missingQuotes 脚注）
    const totalWithCash = summary.totalAssets !== null ? summary.totalAssets + cash.value : null
    lines.push(
      `- 总资产（持仓市值 + 现金）：${fmt(totalWithCash)} 元（现金 ${fmt(cash.value)}，截至 ${cash.updatedAt}）`,
    )
  } else {
    lines.push(`- 总资产（持仓口径，不含现金）：${fmt(summary.totalAssets)} 元`)
  }
  if (manualTotalAssets !== undefined) {
    lines.push(`- 手动总资产：${fmt(manualTotalAssets.value)} 元（截至 ${manualTotalAssets.updatedAt}）`)
  }
  lines.push(`- 总市值：${fmt(summary.totalMarketValue)} 元`)
  lines.push(`- 持仓成本：${fmt(summary.totalCostBasis)} 元`)
  lines.push(`- 累计盈亏：${fmtSigned(summary.totalPnl)} 元（${fmtSigned(summary.totalPnlPct, 2, '%')}）`)
  // 已实现盈亏与上面的浮动口径并列：浮动是「如果今天全卖」，已实现是「已经落袋」，
  // 两者分开展示不做相加——混成一个「综合盈亏」会引入口径纠纷，得不偿失
  if (realized !== undefined && (realized.trades > 0 || realized.skipped > 0)) {
    lines.push(
      `- 已实现盈亏（卖出落袋）：${fmtSigned(realized.pnl)} 元（卖出 ${realized.trades} 笔，` +
        `胜率 ${realized.winRate === null ? '—' : fmt(realized.winRate, 1, '%')}）`,
    )
    if (realized.skipped > 0) {
      lines.push(`- ⚠️ 另有 ${realized.skipped} 笔卖出缺卖出价/成本，未计入已实现盈亏（可在 trades.csv 补齐）`)
    }
  }
  // 当日盈亏对齐券商「当日参考盈亏」：金额同为 Σ(现价−昨收)×股数，百分比的分母是
  // 总资产（含现金）而非持仓市值——半仓时两者差一倍（0.56% × 52.3% 仓位 = 0.29%）。
  // 分母取昨收总资产：现金口径能精确还原（昨收持仓市值 + 现金）；手动快照直接当昨收
  // 总资产用，偏差只有 dayPnl/总资产 量级，对结果影响不到 0.001 个百分点。
  // 两者都没有时降级为持仓口径，并在文案里写明分母，别让人误当券商数看。
  const { base: dayBase, basis: dayBasis } = resolveDayPnlBasis(
    summary.dayPrevValue, cash?.value, manualTotalAssets?.value, summary.dayCashFlow,
  )
  const dayPct = dayBase !== null && summary.dayPnl !== null
    ? (summary.dayPnl / dayBase) * 100
    : summary.dayPnlPct
  lines.push(
    `- 当日参考盈亏：${fmtSigned(summary.dayPnl)} 元（${fmtSigned(dayPct, 2, '%')}，` +
      `${dayBasis === 'total-assets' ? '占总资产' : '占持仓市值'}）`,
  )
  if (summary.dayGaps.length > 0) {
    lines.push(
      `- ⚠️ 以下标的当日有成交但未计入当日盈亏，该数字偏离券商口径（在 trades.csv 补齐成交价即可自动计入）：${summary.dayGaps.join('、')}`,
    )
  }
  if (summary.missingQuotes.length > 0) {
    lines.push(
      `- ⚠️ 以下标的未取到行情，市值/盈亏合计未包含它们（持仓成本为全量口径）：${summary.missingQuotes.join('、')}`,
    )
  }
  if (quoteTime) lines.push(`- 行情时间：${quoteTime}`)
  if (quoteTime !== undefined && isCallAuctionTime(quoteTime)) {
    lines.push('- ⚠️ 集合竞价时段（9:15–9:25）：现价是虚拟撮合参考价，9:25 才定开盘价，与券商 App 对数会有出入')
  }
  lines.push('')
  lines.push(`- 有市值的持仓 ${withMv.length} 只 / 全部 ${summary.rows.length} 只`)
  return lines.join('\n')
}

/** 单只/多只行情的文本输出 */
export function renderQuotesText(quotes: Quote[]): string {
  const lines: string[] = ['## 实时行情', '']
  for (const q of quotes) {
    lines.push(
      // fuyao 快照不带名称（估值补齐失败时可能为空），为空就不占位
      `- ${q.symbol}${q.name !== '' ? ` ${q.name}` : ''}：现价 ${fmt(q.price)}（${fmtSigned(q.change)} / ${fmtSigned(q.changePct, 2, '%')}）` +
        ` 开 ${fmt(q.open)} 高 ${fmt(q.high)} 低 ${fmt(q.low)} 昨收 ${fmt(q.prevClose)}` +
        ` 量 ${fmt(q.volume, 0)} 手 额 ${fmt(q.amountWan / 10000, 2)} 亿` +
        (q.turnoverPct !== undefined ? ` 换手 ${fmt(q.turnoverPct, 2, '%')}` : '') +
        (q.pe !== undefined ? ` PE ${fmt(q.pe)}` : '') +
        (q.pb !== undefined ? ` PB ${fmt(q.pb)}` : '') +
        (q.totalMvYi !== undefined ? ` 总市值 ${fmt(q.totalMvYi)} 亿` : ''),
    )
  }
  if (quotes.length > 0 && quotes[0].time) {
    lines.push('')
    lines.push(`行情时间：${formatQuoteTime(quotes[0].time)}`)
  }
  return lines.join('\n')
}

/**
 * 把汇总结果打成面板的结构化载荷（见 src/dto.ts 的契约说明）。
 * 与 renderSummaryText 同源同口径——当日盈亏分母共用 resolveDayPnlBasis，
 * 不再出现「文本一套、面板另一套」的漂移。
 */
export function buildPortfolioPayload(
  summary: PortfolioSummary,
  quoteTime?: string,
  manualTotalAssets?: { value: number; updatedAt: string },
  cash?: { value: number; updatedAt: string },
  quoteError?: string,
): PortfolioPayload {
  const { base: dayBase, basis: dayBasis } = resolveDayPnlBasis(
    summary.dayPrevValue, cash?.value, manualTotalAssets?.value, summary.dayCashFlow,
  )
  const dayPct = dayBase !== null && summary.dayPnl !== null
    ? (summary.dayPnl / dayBase) * 100
    : summary.dayPnlPct
  const assetsBasis: AssetsBasis = cash !== undefined ? 'cash'
    : manualTotalAssets !== undefined ? 'manual'
    : 'holdings'
  const assets = cash !== undefined
    ? (summary.totalMarketValue === null ? null : summary.totalMarketValue + cash.value)
    : manualTotalAssets !== undefined ? manualTotalAssets.value
    : summary.totalMarketValue
  const totalMv = summary.totalMarketValue
  return {
    v: PORTFOLIO_PAYLOAD_VERSION,
    quoteTime: quoteTime ?? null,
    callAuction: quoteTime !== undefined && isCallAuctionTime(quoteTime),
    rows: summary.rows.map(row => ({
      code: row.position.code,
      name: row.position.name || row.quote?.name || '',
      price: row.price ?? null,
      cost: row.position.cost,
      shares: row.position.shares,
      marketValue: row.marketValue,
      pnl: row.pnl,
      pnlPct: row.pnlPct,
      dayPct: row.quote?.changePct ?? null,
      turnoverPct: row.quote?.turnoverPct ?? null,
      weightPct: row.marketValue !== null && totalMv !== null && totalMv > 0
        ? (row.marketValue / totalMv) * 100
        : null,
    })),
    totals: {
      marketValue: summary.totalMarketValue,
      costBasis: summary.totalCostBasis,
      pnl: summary.totalPnl,
      pnlPct: summary.totalPnlPct,
      assets,
      assetsBasis,
      cash: cash?.value ?? null,
      asOf: cash?.updatedAt ?? manualTotalAssets?.updatedAt ?? null,
    },
    day: { pnl: summary.dayPnl, pct: dayPct, basis: dayBasis },
    missingQuotes: summary.missingQuotes,
    quoteError: quoteError ?? null,
  }
}

/** 载荷的文本挂载形式：附在 /portfolio 输出末尾（一行不可见的 HTML 注释） */
export function renderPayloadTag(payload: PortfolioPayload): string {
  return encodePayloadTag(payload)
}
