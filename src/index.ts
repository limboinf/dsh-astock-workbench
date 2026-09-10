/**
 * dsh-astock-workbench —— A股投资工作台插件（DeepSeek Harness / dsh）
 *
 * 设计纪律：
 * - 数字全部来自确定性数据层（本地 holdings.csv + 腾讯行情接口），
 *   LLM 只做解读，不计算、不推断；
 * - 只读行情、只记持仓，不接任何交易/下单接口；
 * - 零运行时依赖：只靠 dsh 注入的 service（tools/commands），裸 JSON-Schema 注册，
 *   不 import 任何 @deepseek-ai/* 运行时符号，以抵御 developer preview 的破坏性变更。
 *
 * 数据目录：环境变量 ASTOCK_DATA_DIR，默认 ~/.dsh/astock-workbench
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  holdingsTemplate,
  mergePositionInDoc,
  parseHoldingsDoc,
  removePositionInDoc,
  renderHoldingsDoc,
  type HoldingsDoc,
} from './holdings.ts'
import { fetchQuotes, formatQuoteTime, normalizeSymbol, type Quote } from './quotes.ts'
import {
  buildPortfolioPayload,
  renderPayloadTag,
  renderQuotesText,
  renderSummaryText,
  summarize,
} from './format.ts'
import { currentLocalDate, DecisionLogStore, renderDecisionLogs, validateLogDate } from './decision-log.ts'
import { readBalance, validateBalanceDate, writeBalance, writeCashBalance } from './balance.ts'
import { readProfile, writeProfile } from './profile-store.ts'
import { defaultProfile, PROFILE_LABELS, type InvestorProfile } from './profile.ts'
import {
  encodeMarketTag,
  encodeTag,
  ANALYZE_PAYLOAD_VERSION,
  HTML_PREVIEW_PAYLOAD_VERSION,
  type AnalyzePayload,
  type HtmlPreviewPayload,
} from './dto.ts'
import { fetchMarketOverview } from './market.ts'
import { computeKlineStats, fetchKlines } from './kline.ts'
import { fetchFundamentals, renderFundamentalsText } from './fundamentals.ts'
import { resolveDataDir } from './fuyao.ts'
import {
  applyReconcile,
  collectSellEvents,
  diffReconcile,
  reconcileToken,
  renderReconcileApplied,
  renderReconcilePreview,
  validateReconcileRows,
  type SellEvent,
} from './reconcile.ts'
import {
  appendTradeRecord,
  makeSellRecord,
  collectDayTurnover,
  parseTradesDoc,
  renderTradesDoc,
  renderTradesList,
  summarizeTrades,
  tradesTemplate,
  type TradeRecord,
  type TradesDoc,
} from './trades.ts'

// ---------- 最小类型声明（对齐 dsh 官方教程的注册面，刻意保持宽松） ----------

interface TextBlock {
  type: string
  text?: string
}

interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => TextBlock[]
  }
  execute: (args: any, exec: { signal?: AbortSignal }) => Promise<unknown>
}

interface CommandDef {
  name: string
  description: string
  input?: { hint?: string }
  handler: (invocation: unknown) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string }
}

interface DshPluginContext {
  tools: { register: (def: ToolDef) => unknown }
  commands: { register: (cmd: CommandDef) => unknown }
  logger?: {
    info?: (...args: unknown[]) => void
    warn?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
}

// ---------- 持仓存储 ----------

class HoldingsStore {
  constructor(readonly dir: string) {}

  get file(): string {
    return join(this.dir, 'holdings.csv')
  }

  bootstrap(): void {
    mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.file)) {
      writeFileSync(this.file, holdingsTemplate(), 'utf8')
    }
  }

  loadDoc(): HoldingsDoc {
    if (!existsSync(this.file)) return { lines: [], positions: [], warnings: [] }
    return parseHoldingsDoc(readFileSync(this.file, 'utf8'))
  }

  /** 原子写：先写同目录临时文件再 rename，避免写一半崩溃损坏记账数据 */
  writeDoc(doc: HoldingsDoc): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, renderHoldingsDoc(doc), 'utf8')
    renameSync(tmp, this.file)
  }
}

/** 卖出流水存储：与 HoldingsStore 同款原子写 + 文档模型（注释/坏行原样保留） */
class TradesStore {
  constructor(readonly dir: string) {}

  get file(): string {
    return join(this.dir, 'trades.csv')
  }

  bootstrap(): void {
    mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.file)) {
      writeFileSync(this.file, tradesTemplate(), 'utf8')
    }
  }

  loadDoc(): TradesDoc {
    if (!existsSync(this.file)) return { lines: [], records: [], warnings: [] }
    return parseTradesDoc(readFileSync(this.file, 'utf8'))
  }

  writeDoc(doc: TradesDoc): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, renderTradesDoc(doc), 'utf8')
    renameSync(tmp, this.file)
  }

  /**
   * 追加流水（fail-closed）：文件有坏行时拒绝写入并返回警告——
   * 整文件重写会把手改的行永久抹掉，宁可少记一笔让用户先修 CSV。
   */
  appendAll(records: TradeRecord[]): { warning?: string } {
    const doc = this.loadDoc()
    if (doc.warnings.length > 0) {
      return {
        warning: `trades.csv 有 ${doc.warnings.length} 行无法解析，本笔流水未记入（避免覆盖丢数据）。请先修复 ${this.file}：\n${doc.warnings.map(w => `- ${w}`).join('\n')}`,
      }
    }
    let next = doc
    for (const record of records) next = appendTradeRecord(next, record)
    this.writeDoc(next)
    return {}
  }
}

// 数据目录解析的单一来源已移到 fuyao.ts（key 查找也要用它）；此处 re-export 保持旧调用方兼容
export { resolveDataDir }

// ---------- 工具实现（确定性部分） ----------

/** 卖出事件落成流水：卖出价取当时行情快照（缺行情记空价，事后可补），reason 用于结果展示 */
type RecordedSell = TradeRecord & { reason: string }

async function recordSellEvents(
  trades: TradesStore,
  events: SellEvent[],
  note: string,
  signal?: AbortSignal,
): Promise<{ recorded: RecordedSell[]; warning?: string }> {
  if (events.length === 0) return { recorded: [] }
  let quotes = new Map<string, Quote>()
  try {
    quotes = await fetchQuotes(events.map(e => e.code), { signal })
  } catch {
    // 行情整链路失败也照记：流水先留痕（价格空、盈亏空进 skipped），事后补价即可
  }
  const date = currentLocalDate()
  const records = events.map(e => ({
    ...makeSellRecord({
      date,
      code: e.code,
      name: e.name,
      shares: e.shares,
      price: quotes.get(e.code)?.price ?? null,
      cost: e.cost,
      note: `${note}（${e.reason}）`,
    }),
    reason: e.reason,
  }))
  const { warning } = trades.appendAll(records)
  return { recorded: warning === undefined ? records : [], warning }
}

/** 已实现盈亏统计的单一取数口：汇总、面板载荷、流水工具都用这份数字 */
function readRealized(trades: TradesStore): {
  stats: ReturnType<typeof summarizeTrades>
  warnings: string[]
  records: TradeRecord[]
} {
  const doc = trades.loadDoc()
  return { stats: summarizeTrades(doc.records), warnings: doc.warnings, records: doc.records }
}

/**
 * 行情快照所属的交易日（YYYY-MM-DD）——当日成交要跟行情的「昨收」对齐同一天。
 * 不能用本机今天：周末/盘后看面板时本机已翻篇，而行情还停在上个交易日，
 * 按本机日期取成交会取空，当日盈亏悄悄退回「全按昨收算」的旧口径。
 * 两种行情源的时间形态都带日期：东财 14 位数字串、fuyao 已格式化的 'YYYY-MM-DD HH:MM:SS'。
 */
function resolveTradingDate(quoteTime: string | undefined): string | null {
  if (quoteTime === undefined) return null
  if (/^\d{14}$/.test(quoteTime)) return `${quoteTime.slice(0, 4)}-${quoteTime.slice(4, 6)}-${quoteTime.slice(6, 8)}`
  const m = /^(\d{4}-\d{2}-\d{2})\b/.exec(quoteTime)
  return m === null ? null : m[1]
}

async function buildPositionsText(store: HoldingsStore, trades: TradesStore, signal?: AbortSignal): Promise<string> {
  const { positions, warnings } = store.loadDoc()
  if (positions.length === 0) {
    return [
      '## 持仓概览',
      '',
      `暂无持仓。请编辑 ${store.file}，或用 astock_add_position 工具记账。`,
      ...warnings.map(w => `- ⚠️ ${w}`),
    ].join('\n')
  }
  let quotes = new Map<string, Quote>()
  let quoteError: string | undefined
  try {
    quotes = await fetchQuotes(positions.map(p => p.code), { signal })
  } catch (e) {
    quoteError = String(e instanceof Error ? e.message : e)
  }
  const onlyTime = [...quotes.values()][0]?.time
  const realized = readRealized(trades)
  // 当日成交要参与当日盈亏（见 format.ts summarize 的现金流量法）。当日清仓的标的
  // 已不在持仓表里、上面那次行情没请求它，这里按需补一次拿昨收——只在真有当日
  // 清仓时才多发一个请求，平时零开销。补取失败不阻塞，summary 会出 dayGaps 提示。
  const tradingDate = resolveTradingDate(onlyTime)
  const dayTurnover = tradingDate === null
    ? undefined
    : collectDayTurnover(realized.records, tradingDate)
  const closedOut = [...(dayTurnover?.keys() ?? [])].filter(code => !quotes.has(code))
  if (closedOut.length > 0) {
    try {
      for (const [code, q] of await fetchQuotes(closedOut, { signal })) quotes.set(code, q)
    } catch {
      // 忽略：当日盈亏会把这些标的记进 dayGaps，由文案提示，不猜数
    }
  }
  const summary = summarize(positions, quotes, dayTurnover)
  // 资产口径二选一（balance.json 互斥存储）：现金口径（总资产=持仓市值+现金，随行情变动）
  // 优先于快照口径（静态数字）。都未录入时保持持仓口径。
  const balance = readBalance(store.dir)
  const cash =
    balance?.cash !== undefined ? { value: balance.cash, updatedAt: balance.updatedAt } : undefined
  const manualTotalAssets =
    cash === undefined &&
    balance !== null &&
    balance.totalAssets !== undefined &&
    Number.isFinite(balance.totalAssets) &&
    balance.totalAssets > 0
      ? { value: balance.totalAssets, updatedAt: balance.updatedAt }
      : undefined
  const quoteTimeText = onlyTime ? formatQuoteTime(onlyTime) : undefined
  const hasRealized = realized.stats.trades > 0 || realized.stats.skipped > 0
  let text = renderSummaryText(summary, quoteTimeText, manualTotalAssets, cash, hasRealized ? realized.stats : undefined)
  if (quoteError) {
    text += `\n- ⚠️ 行情获取失败，以上不含现价（持仓成本仍为全量口径）：${quoteError}`
  }
  if (warnings.length > 0) {
    text += `\n${warnings.map(w => `- ⚠️ ${w}`).join('\n')}`
  }
  if (realized.warnings.length > 0) {
    text += `\n${realized.warnings.map(w => `- ⚠️ 卖出流水：${w}`).join('\n')}`
  }
  // 结构化载荷挂在末尾（不可见的 HTML 注释）：面板照它取数，不再靠正则啃中文文案。
  // 模型读到的仍是上面的 markdown，载荷只是同一份数字的机器可读形式。
  const payload = buildPortfolioPayload(summary, quoteTimeText, manualTotalAssets, cash, quoteError)
  return `${text}\n${renderPayloadTag(payload)}`
}

/** 大盘概览的命令输出：人读的摘要 + 面板读的结构化 tag */
function renderMarketText(payload: import('./dto.ts').MarketPayload): string {
  const yi = (n: number | null): string => n === null ? '—' : `${(n / 1e8).toFixed(0)} 亿`
  const lines = ['## 大盘概览']
  if (payload.error !== null) lines.push(`- ⚠️ ${payload.error}`)
  for (const row of payload.indices) {
    const pct = row.changePct === null ? '—' : `${row.changePct > 0 ? '+' : ''}${row.changePct.toFixed(2)}%`
    lines.push(`- ${row.name}：${row.price ?? '—'}（${pct}）`)
  }
  const { up, down, amount, netInflow } = payload.totals
  lines.push(`- 沪深涨跌家数：涨 ${up ?? '—'} / 跌 ${down ?? '—'}`)
  lines.push(`- 沪深成交额：${yi(amount)}`)
  lines.push(`- 主力净流入：${yi(netInflow)}`)
  if (payload.time !== null) lines.push(`- 快照时间：${payload.time}（来源 ${payload.source}）`)
  return `${lines.join('\n')}\n${encodeMarketTag(payload)}`
}

/**
 * 画像的命令输出：人读的一行摘要 + 面板读的结构化 tag。
 * 未设置时回显默认档（面板据此显示默认选中态，不用自己复制一份默认值）。
 */
function renderProfileText(profile: InvestorProfile | null): string {
  const effective = profile ?? defaultProfile()
  const summary = [
    `- 详略：${PROFILE_LABELS.depth[effective.depth]}`,
    `- 术语：${PROFILE_LABELS.jargon[effective.jargon]}`,
    `- 结构：${PROFILE_LABELS.order[effective.order]}`,
    effective.note === '' ? '- 自述：（未填）' : `- 自述：${effective.note}`,
    profile === null ? '- 状态：未设置，以上为默认档' : `- 更新于：${effective.updatedAt}`,
  ].join('\n')
  return `## 投资者画像\n${summary}\n${encodeTag('profile', { ...effective, saved: profile !== null })}`
}

async function buildQuoteText(symbols: string[], signal?: AbortSignal): Promise<string> {
  if (symbols.length === 0) throw new Error('symbols 不能为空')
  // enrich：fuyao 快照不带名称/PE/PB，人工查询时额外调估值快照补齐（轮询路径不开，省请求）
  const quotes = await fetchQuotes(symbols, { signal, enrich: true })
  const ordered = [...new Set(symbols.map(s => normalizeSymbol(s)))]
    .map(s => quotes.get(s))
    .filter((q): q is Quote => q !== undefined)
  const failed = [...new Set(symbols.map(s => normalizeSymbol(s)))].filter(s => !quotes.has(s))
  let text = ordered.length > 0 ? renderQuotesText(ordered) : '未取到任何行情。'
  if (failed.length > 0) text += `\n⚠️ 未取到：${failed.join('、')}`
  return text
}

/**
 * 个股诊断的确定性骨架：趋势/量能/相对强弱的判定标签 + 关键数字 + 持仓上下文。
 * 全部数字与标签在本函数算死，AI 在工具返回后只写三段白话解读（诊断书形态，
 * 定案见 prototype/p0-1-deep-analysis.html），禁止另算或改写数字。
 */
async function buildAnalyzeText(store: HoldingsStore, rawSymbol: string, signal?: AbortSignal): Promise<string> {
  const sym = normalizeSymbol(rawSymbol)
  const { positions } = store.loadDoc()
  const position = positions.find(p => p.code === sym)

  // 行情一次取齐：目标标的 + 全部持仓（后者只为算组合权重；失败不阻塞诊断本体）
  let quoteError: string | null = null
  const quotes = await fetchQuotes([...new Set([sym, ...positions.map(p => p.code)])], { signal }).catch(
    (e: unknown) => {
      quoteError = `行情获取失败：${e instanceof Error ? e.message : String(e)}`
      return new Map<string, Quote>()
    },
  )
  const quote = quotes.get(sym)
  const summary = summarize(positions, quotes)
  const row = summary.rows.find(r => r.position.code === sym)

  // 基准指数：创业板个股（3 开头）对创业板指，其余对沪深300（确定性映射，AI 不可挑基准）
  const bare = sym.replace(/^[a-z]{2}/, '')
  const benchSymbol = bare.startsWith('3') ? 'sz399006' : 'sh000300'
  const benchName = bare.startsWith('3') ? '创业板指' : '沪深300'

  let klineError: string | null = null
  const klines = await fetchKlines([sym, benchSymbol], { count: 60, signal }).catch((e: unknown) => {
    klineError = `K线获取失败：${e instanceof Error ? e.message : String(e)}`
    return new Map<string, import('./kline.ts').Kline>()
  })
  const kline = klines.get(sym)
  const bench = klines.get(benchSymbol)
  if (kline === undefined && klineError === null) klineError = 'K线无返回'
  const stats = kline !== undefined ? computeKlineStats(kline.bars) : undefined
  const benchStats = bench !== undefined ? computeKlineStats(bench.bars) : undefined
  const relRet5 =
    stats?.ret5 !== undefined && benchStats?.ret5 !== undefined ? stats.ret5 - benchStats.ret5 : undefined

  // 判定标签：阈值固定，不搞模糊措辞；tone 供 client 上色（up=红/down=绿）
  const tags: AnalyzePayload['tags'] = []
  if (stats?.ma20 !== undefined) {
    if (stats.lastClose < stats.ma20) tags.push({ label: `趋势：下行（收盘低于MA20）`, tone: 'down' })
    else if (stats.lastClose > stats.ma20) tags.push({ label: '趋势：上行（收盘高于MA20）', tone: 'up' })
    else tags.push({ label: '趋势：横盘（贴MA20）', tone: 'flat' })
  }
  if (stats?.volRatio !== undefined) {
    if (stats.volRatio >= 1.5) {
      const bearish = quote !== undefined && quote.changePct < 0
      tags.push({ label: `量能：放量 ${stats.volRatio.toFixed(1)}×`, tone: bearish ? 'down' : 'up' })
    } else if (stats.volRatio <= 0.7) {
      tags.push({ label: `量能：缩量 ${stats.volRatio.toFixed(1)}×`, tone: 'flat' })
    } else {
      tags.push({ label: `量能：平量 ${stats.volRatio.toFixed(1)}×`, tone: 'flat' })
    }
  }
  if (relRet5 !== undefined) {
    if (relRet5 <= -2) tags.push({ label: `相对${benchName}（5日）：跑输 ${Math.abs(relRet5).toFixed(1)}pp`, tone: 'down' })
    else if (relRet5 >= 2) tags.push({ label: `相对${benchName}（5日）：跑赢 ${relRet5.toFixed(1)}pp`, tone: 'up' })
    else tags.push({ label: `相对${benchName}（5日）：同步`, tone: 'flat' })
  }
  if (stats?.pos20 !== undefined) {
    if (stats.pos20 <= 20) tags.push({ label: `20日位置：底部区（${stats.pos20.toFixed(0)}%）`, tone: 'flat' })
    else if (stats.pos20 >= 80) tags.push({ label: `20日位置：顶部区（${stats.pos20.toFixed(0)}%）`, tone: 'flat' })
    else tags.push({ label: `20日位置：中位（${stats.pos20.toFixed(0)}%）`, tone: 'flat' })
  }

  const n2 = (x: number | undefined | null): string => x === undefined || x === null ? '—' : x.toFixed(2)
  const pct2 = (x: number | undefined | null): string =>
    x === undefined || x === null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(2)}%`
  const quoteTimeText = quote !== undefined ? formatQuoteTime(quote.time) : null
  const lines: string[] = [`## 个股诊断 · ${position?.name || quote?.name || ''}（${sym}）`]
  lines.push(`- 判定：${tags.map(t => t.label).join('；') || '（数据不足，无判定）'}`)
  lines.push(
    `- 关键数字：现价 ${n2(quote?.price ?? stats?.lastClose)}（${pct2(quote?.changePct)}）；` +
      `MA5 ${n2(stats?.ma5)} / MA20 ${n2(stats?.ma20)}；` +
      `20日区间 ${n2(stats?.low20)} ~ ${n2(stats?.high20)}；` +
      `5日收益 ${pct2(stats?.ret5)}（${benchName} ${pct2(benchStats?.ret5)}）；20日收益 ${pct2(stats?.ret20)}`,
  )
  if (row !== undefined) {
    const weightPct =
      summary.totalMarketValue !== null && row.marketValue !== null
        ? (row.marketValue / summary.totalMarketValue) * 100
        : null
    lines.push(
      `- 持仓上下文：持有 ${row.position.shares} 股，成本 ${n2(row.position.cost)}，` +
        `浮动盈亏 ${row.pnl === null ? '—' : row.pnl.toFixed(0)} 元（${pct2(row.pnlPct)}）` +
        `${weightPct === null ? '' : `，组合权重 ${weightPct.toFixed(1)}%`}`,
    )
  } else {
    lines.push('- 持仓上下文：未持有该标的')
  }
  if (quoteError !== null) lines.push(`- ⚠️ ${quoteError}`)
  if (klineError !== null) lines.push(`- ⚠️ ${klineError}（趋势/量能/位置判定不可用）`)
  else if (kline !== undefined) lines.push(`- K线：近 ${kline.bars.length} 根日K（前复权，来源 ${kline.source}）`)

  const payload: AnalyzePayload = {
    v: ANALYZE_PAYLOAD_VERSION,
    symbol: sym,
    name: position?.name || quote?.name || '',
    quoteTime: quoteTimeText,
    price: quote?.price ?? stats?.lastClose ?? null,
    changePct: quote?.changePct ?? null,
    bars:
      kline?.bars.map(
        b =>
          [
            b.date,
            Number(b.open.toFixed(3)),
            Number(b.close.toFixed(3)),
            Number(b.high.toFixed(3)),
            Number(b.low.toFixed(3)),
            Math.round(b.volume),
          ] as import('./dto.ts').AnalyzeBar,
      ) ?? [],
    klineSource: kline?.source ?? null,
    ma5: stats?.ma5 ?? null,
    ma20: stats?.ma20 ?? null,
    volRatio: stats?.volRatio ?? null,
    pos20: stats?.pos20 ?? null,
    low20: stats?.low20 ?? null,
    high20: stats?.high20 ?? null,
    ret5: stats?.ret5 ?? null,
    ret20: stats?.ret20 ?? null,
    benchName,
    benchRet5: benchStats?.ret5 ?? null,
    relRet5: relRet5 ?? null,
    tags,
    holding:
      row !== undefined
        ? {
            shares: row.position.shares,
            cost: row.position.cost,
            pnl: row.pnl,
            pnlPct: row.pnlPct,
            weightPct:
              summary.totalMarketValue !== null && row.marketValue !== null
                ? (row.marketValue / summary.totalMarketValue) * 100
                : null,
          }
        : null,
    klineError,
  }
  return `${lines.join('\n')}\n${encodeTag('analyze', payload)}`
}

// ---------- 插件入口 ----------

export const name = 'astock-workbench'

export const inject = ['tools', 'commands']

/** astock_show_html 的硬上限：图解是讲解页不是作品集，超了说明没做到「一页一概念」 */
const HTML_PREVIEW_MAX_CHARS = 200_000

/**
 * 图解存档：explainers/<本地时间戳>-<标题>.html。
 * 标题只保留文件名安全字符（中文保留，路径分隔符等剥掉），剥完为空退回「图解」。
 */
function saveExplainerHtml(dir: string, title: string, html: string): string {
  const safe = title.replace(/[\\/:*?"<>|\s#]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || '图解'
  const explainersDir = join(dir, 'explainers')
  mkdirSync(explainersDir, { recursive: true })
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const file = join(explainersDir, `${stamp}-${safe}.html`)
  writeFileSync(file, html, 'utf8')
  return file
}

export function apply(ctx: DshPluginContext): void {
  const store = new HoldingsStore(resolveDataDir())
  const trades = new TradesStore(store.dir)
  const decisionLogs = new DecisionLogStore(join(store.dir, 'decision-logs'))
  store.bootstrap()
  trades.bootstrap()
  decisionLogs.ensureDir()
  const log = ctx.logger?.info?.bind(ctx.logger)
  log?.(`[astock-workbench] 数据目录：${store.dir}`)

  // 持仓表有坏行/重复代码时拒绝写入：整文件重写会把这些行永久抹掉，
  // 宁可让用户先修 CSV（fail-closed），也不静默丢记账数据。
  const refuseWrite = (warnings: string[]): string =>
    [
      `⚠️ 持仓表有 ${warnings.length} 行无法解析，为避免覆盖丢失，本次未写入。请先修复 ${store.file}：`,
      ...warnings.map(w => `- ${w}`),
    ].join('\n')

  ctx.tools.register({
    name: 'astock_positions',
    description:
      '读取本地持仓表（holdings.csv）并拉取 A 股实时行情，返回每只持仓的现价、市值、累计盈亏、当日涨跌、' +
      '权重，以及总市值/总盈亏/当日参考盈亏（金额为 Σ(现价−昨收)×股数，百分比默认占总资产，与券商口径一致）的确定性汇总。' +
      '若用户用 astock_set_cash 记录过现金余额，总资产 = 持仓市值 + 现金（随行情变动）；若用 astock_set_total_assets 录入过手动总资产快照，' +
      '也会一并显示。有卖出流水（trades.csv）时还返回累计已实现盈亏（卖出落袋合计、笔数、胜率）。分析用户持仓前必须先调用本工具。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (_args, exec) => buildPositionsText(store, trades, exec?.signal),
  })

  // 手动总资产快照：用户说「更新我的总资产：XXX」时录入，是静态数字（行情波动不改变它）。
  // 金额原样写入 balance.json，不做任何换算（录入什么存什么，便于与券商对账）；
  // 与现金口径互斥，后写覆盖。
  ctx.tools.register({
    name: 'astock_set_total_assets',
    description:
      '记录券商口径的手动总资产快照（含现金与其他资产；静态数字，行情波动不改变它，直到再次录入）。' +
      '用户说「更新我的总资产：XXX」时调用。金额原样写入，不做任何计算。' +
      '若之后用 astock_set_cash 记录现金余额，总资产会改为「持仓市值 + 现金」的自动口径（后设置的生效）。' +
      '写入后建议再调用 astock_positions 让工作台刷新显示新总资产。',
    parameters: {
      type: 'object',
      properties: {
        totalAssets: { type: 'number', description: '总资产金额（元），正数' },
        date: { type: 'string', description: '截至日期 YYYY-MM-DD；省略时使用本地今天' },
        note: { type: 'string', description: '备注（可选）' },
      },
      required: ['totalAssets'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { totalAssets: number; date?: string; note?: string }) => {
      if (!Number.isFinite(args.totalAssets) || args.totalAssets <= 0) {
        throw new Error('总资产必须是正数')
      }
      const date = args.date?.trim() ? validateBalanceDate(args.date) : currentLocalDate()
      const file = writeBalance(store.dir, args.totalAssets, date, args.note)
      return [
        `已更新手动总资产：${args.totalAssets.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元（截至 ${date}）`,
        `存储文件：${file}`,
        '下次 astock_positions / 工作台刷新即显示该值（覆盖持仓市值口径）。',
      ].join('\n')
    },
  })

  // 现金余额：用户说「现金/可用资金有 XXX」时录入。设置后总资产切换为自动口径
  // （总资产 = 持仓市值 + 现金，随行情实时变动），并取代手动总资产快照（互斥，后写覆盖）。
  // 金额原样写入 balance.json，不做任何换算（录入什么存什么，便于与券商对账）。
  ctx.tools.register({
    name: 'astock_set_cash',
    description:
      '记录券商现金余额（元）。设置后总资产切换为自动口径：总资产 = 持仓市值 + 现金，随行情实时变动，' +
      '并取代之前的手动总资产快照。用户说「现金/可用资金/闲钱有 XXX」时调用。金额原样写入，不做任何计算。' +
      '写入后建议再调用 astock_positions 让工作台刷新显示。',
    parameters: {
      type: 'object',
      properties: {
        cash: { type: 'number', description: '现金金额（元），0 或正数' },
        date: { type: 'string', description: '截至日期 YYYY-MM-DD；省略时使用本地今天' },
        note: { type: 'string', description: '备注（可选）' },
      },
      required: ['cash'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { cash: number; date?: string; note?: string }) => {
      if (!Number.isFinite(args.cash) || args.cash < 0) {
        throw new Error('现金必须是 0 或正数')
      }
      const date = args.date?.trim() ? validateBalanceDate(args.date) : currentLocalDate()
      const file = writeCashBalance(store.dir, args.cash, date, args.note)
      return [
        `已记录现金余额：${args.cash.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元（截至 ${date}）`,
        `存储文件：${file}`,
        '总资产已切换为自动口径：总资产 = 持仓市值 + 现金（随行情变动，取代手动总资产快照）。',
        '下次 astock_positions / 工作台刷新即显示新总资产。',
      ].join('\n')
    },
  })

  ctx.tools.register({
    name: 'astock_log_decision',
    description:
      '按交易日追加一条投资决策日志（只做记录，绝不代替用户执行交易）。' +
      '调用纪律分两档：①用户已执行的买卖动作（买入/加仓/减仓/卖出/清仓，含对账、流水确认的成交）免问直记——' +
      '在完成持仓记账（astock_add_position / astock_remove_position / astock_reconcile）的同一轮回复里直接调用本工具补一条，' +
      'kind 用对应性质，summary 带标的/价格/股数，正文按写作规范写全成交记录、理由、风险与复核条件；' +
      '②未执行的内容（计划、观察、复盘、纪律提醒等）保持先问后写：最多在回复结尾问一句「要不要记入决策日志」，确认后才调用。' +
      '纯行情查询、体检等无决策内容的任务不写也不问。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '交易日，YYYY-MM-DD；省略时使用本地今天' },
        title: { type: 'string', description: '当天日志标题（可选，仅当天首次写入时生效）' },
        kind: {
          type: 'string',
          description: '本次动作性质：计划/买入/加仓/减仓/卖出/清仓/纪律/复盘/观察（可选，面板据此打性质徽标）',
        },
        summary: {
          type: 'string',
          description: '一句话摘要，如「28元×3手=300股，未成交」（强烈建议提供，作为面板条目标题）',
        },
        content: {
          type: 'string',
          description:
            '决策正文。写作规范（面板按此结构化渲染，必须遵守）：每个维度单独一行、以【标签】开头，' +
            '常用标签：决策/理由/执行/效果/操作/观察与依据/我的判断/计划/风险/止损纪律/复核条件/教训/买入记录/加仓记录；' +
            '复核条件与风险等多条内容一条一行、以 - 开头紧跟在对应【标签】行之后；不要把多个维度挤在同一段。',
        },
      },
      required: ['content'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { date?: string; title?: string; kind?: string; summary?: string; content: string }) => {
      const date = args.date?.trim() || currentLocalDate()
      const file = decisionLogs.append(
        { content: args.content, kind: args.kind, summary: args.summary },
        date,
        args.title,
      )
      return `已记录 ${date} 的决策日志：${file}`
    },
  })

  ctx.tools.register({
    name: 'astock_decision_logs',
    description: '读取本地交易日决策日志，支持指定日期或日期范围，供 AI 复盘与重新决策参考。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '指定日期 YYYY-MM-DD' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { date?: string; from?: string; to?: string }) => {
      if (args.date !== undefined) {
        const date = decisionLogs.read(args.date)
        return renderDecisionLogs(date === undefined ? [] : [{ date: args.date, text: date }])
      }
      return renderDecisionLogs(decisionLogs.list(args.from, args.to))
    },
  })

  ctx.tools.register({
    name: 'astock_quote',
    description:
      '查询 A 股实时行情（现价、涨跌、开高低、成交量额，股票含换手/PE/PB）。' +
      '数据源：同花顺 fuyao 为主、腾讯免费接口兜底其缺口（深市股票/深市 ETF/北交所）。' +
      '支持 6 位数字代码（自动识别沪/深/北）或带 sh/sz/bj 前缀的代码，一次最多 30 只。',
    parameters: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string', description: '股票代码，如 "600519" 或 "sh600519"' },
          description: '要查询的股票代码列表',
        },
      },
      required: ['symbols'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { symbols: string[] }, exec) => {
      if (!Array.isArray(args.symbols)) throw new Error('symbols 必须是字符串数组')
      const symbols = args.symbols.map(s => String(s))
      if (symbols.length > 30) throw new Error('一次最多查询 30 只')
      return buildQuoteText(symbols, exec?.signal)
    },
  })

  // 个股深度诊断：确定性数据层（60日K线 + 量比 + 相对基准 + 持仓上下文）出判定标签，
  // AI 在返回后按「诊断书」三段结构写解读（ADR-0002：直接给操作参考，挂数字、给反方、带免责）。
  ctx.tools.register({
    name: 'astock_analyze',
    description:
      '个股深度诊断：返回该标的的确定性分析骨架——趋势/量能/相对基准强弱的判定标签、60 日 K 线与关键数字' +
      '（MA5/MA20、20日区间与位置、5日/20日收益、量比、相对沪深300或创业板指的5日超额）、用户持仓上下文' +
      '（成本/浮亏/权重）。数据源：fuyao 日K为主、腾讯 K 线兜底，全部前复权。' +
      '用户问「XX 怎么样/能不能买/该不该卖/分析一下 XX」时调用本工具（一次一只）；' +
      '拿到返回后按「诊断书」结构续写三段：①发生了什么 ②对持仓意味着什么 ③接下来看什么（操作参考）；' +
      '操作参考必须直接给买卖/持有/减仓建议并引用上面的数字作依据，同时给一句「什么情况下判断作废」，' +
      '结尾固定带免责声明「以上为 AI 生成的分析参考，非投资建议；行情数据可能延迟或有误，据此操作风险自负」。' +
      '禁止改写或另算返回里的任何数字；判定标签（趋势/量能/相对强弱）以返回为准，只展开不推翻。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票/ETF 代码，如 "300285" 或 "sz300285"，一次一只' },
      },
      required: ['symbol'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { symbol: string }, exec) => {
      if (typeof args.symbol !== 'string' || args.symbol.trim() === '') {
        throw new Error('symbol 必须是非空字符串')
      }
      return buildAnalyzeText(store, args.symbol, exec?.signal)
    },
  })

  // 个股基本面：估值（PE/PB）+ 财务近4季。2026-09-07 收编 client 提示词里的模型
  // 自取数（shell 读 key + 裸 curl fuyao）——key 读取与「quarterly 实为累计值」的
  // 口径折算都极易翻车，取数与计算必须留在本地确定性层（K 线同日同因收编）。
  ctx.tools.register({
    name: 'astock_fundamentals',
    description:
      '个股基本面：返回估值（PE-TTM/PB-MRQ）与财务近 4 个单季（营收/归母净利润，含同比与环比）。' +
      '注意：fuyao 财务接口返回的是年初至今累计值，本工具已在本地折算成单季，数字可直接引用。' +
      '仅覆盖沪深股票；ETF/基金无基本面数据，北交所可能不可用（都会如实标注 ⚠️）。' +
      '用户问「估值/PE/市盈率/财务/业绩/基本面」，或个股深度分析需要估值财务佐证时调用（一次一只）。' +
      '禁止改写或另算返回里的数字；数据不可用时如实说明，禁止编造。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码，如 "600519" 或 "sz300285"，一次一只' },
      },
      required: ['symbol'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { symbol: string }, exec) => {
      if (typeof args.symbol !== 'string' || args.symbol.trim() === '') {
        throw new Error('symbol 必须是非空字符串')
      }
      return renderFundamentalsText(await fetchFundamentals(args.symbol, { signal: exec?.signal }))
    },
  })

  ctx.tools.register({
    name: 'astock_add_position',
    description:
      '向持仓表新增或合并一条持仓（记账，不是交易）。同一代码按股数加权合并成本。' +
      '用户说「我买了/加仓了 XX」时用本工具记录。' +
      '本笔是真实成交（而非补录已有的历史持仓）时必须传 tradeDate=成交日：' +
      '当日成交要进流水，当日盈亏才能跟券商「当日参考盈亏」对上。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '股票代码，如 600519' },
        shares: { type: 'number', description: '股数（正数）' },
        cost: { type: 'number', description: '每股成本（元）；本笔成交时即成交价' },
        name: { type: 'string', description: '股票名称（可选，新增时生效）' },
        sector: { type: 'string', description: '行业/板块（可选，新增时生效）' },
        note: { type: 'string', description: '备注，如买入理由（可选，新增时生效）' },
        tradeDate: {
          type: 'string',
          description:
            '本笔买入的成交日 YYYY-MM-DD（今天成交就传今天）。传了才会在 trades.csv 补记买入流水；' +
            '把已经持有的历史持仓录进表里时不要传，否则会被当成当日买入、算错当日盈亏。',
        },
      },
      required: ['code', 'shares', 'cost'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: {
      code: string
      shares: number
      cost: number
      name?: string
      sector?: string
      note?: string
      tradeDate?: string
    }) => {
      const doc = store.loadDoc()
      if (doc.warnings.length > 0) return refuseWrite(doc.warnings)
      const { doc: next, merged } = mergePositionInDoc(doc, args)
      store.writeDoc(next)
      const lines = [
        `已记账：${merged.code} ${args.name?.trim() || merged.name || ''} ${merged.shares} 股 @ 成本 ${merged.cost}`,
        `持仓表已更新：${store.file}`,
      ]
      // 买入流水只在明确给了成交日时补记：holdings 的加权成本已经把买入记全了，
      // 流水这份是给「当日盈亏」用的（当日买入的股份从成交价起算，不从昨收起算）。
      // 默认不记是 fail-safe——把首次建仓补录的历史持仓当成当日买入，当日盈亏会
      // 变成「浮动盈亏」量级的离谱数字；漏记只是退回昨收口径，错得小得多。
      const tradeDate = args.tradeDate?.trim()
      if (tradeDate !== undefined && tradeDate !== '') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
          lines.push(`⚠️ tradeDate「${tradeDate}」不是 YYYY-MM-DD，买入流水未补记（持仓表已更新）`)
          return lines.join('\n')
        }
        const { warning } = trades.appendAll([{
          date: tradeDate,
          code: merged.code,
          name: args.name?.trim() || merged.name || '',
          action: 'buy',
          shares: args.shares,
          price: args.cost,
          cost: null,
          pnl: null,
          note: args.note?.trim() || '加仓记账自动补记',
        }])
        lines.push(warning === undefined
          ? `买入流水已补记：${tradeDate} ${args.shares} 股 @ ${args.cost}（当日盈亏据此从成交价起算）`
          : `⚠️ ${warning}`)
      }
      return lines.join('\n')
    },
  })

  // 清仓记账：移除持仓行之外，同步在卖出流水（trades.csv）补记一笔——
  // 不然清仓的盈亏就从账上消失了（holdings 是快照表，删行即失忆）。
  // 卖出价优先用用户给的成交价，否则取当时行情快照；都拿不到就记空价（盈亏待补）。
  ctx.tools.register({
    name: 'astock_remove_position',
    description:
      '从持仓表清仓移除一条持仓（记账，不是交易），并自动在卖出流水补记该笔（trades.csv，计入已实现盈亏）。' +
      '用户说「清仓/卖光了 XX」时用本工具记录；用户提到实际成交价时传入 price，未提供则按当时行情记。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '股票代码，如 600519' },
        price: { type: 'number', description: '实际每股卖出价（可选；缺省按当时行情快照记）' },
        note: { type: 'string', description: '备注（可选，写入流水）' },
      },
      required: ['code'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { code: string; price?: number; note?: string }, exec) => {
      const doc = store.loadDoc()
      if (doc.warnings.length > 0) return refuseWrite(doc.warnings)
      const { doc: next, removed } = removePositionInDoc(doc, args.code)
      if (!removed) return `持仓表中没有 ${normalizeSymbol(args.code)}，未做修改。`
      let price = args.price ?? null
      if (price === null) {
        try {
          const quotes = await fetchQuotes([removed.code], { signal: exec?.signal })
          price = quotes.get(removed.code)?.price ?? null
        } catch {
          // 行情失败记空价：清仓仍生效，流水留痕、盈亏待补
        }
      }
      const record = makeSellRecord({
        date: currentLocalDate(),
        code: removed.code,
        name: removed.name,
        shares: removed.shares,
        price,
        cost: removed.cost,
        note: args.note?.trim() || '清仓记账自动补记',
      })
      store.writeDoc(next)
      const lines = [`已移除：${removed.code} ${removed.name || ''}（原 ${removed.shares} 股 @ 成本 ${removed.cost}）。持仓表已更新。`]
      const { warning } = trades.appendAll([record])
      if (warning === undefined) {
        lines.push(
          record.pnl !== null
            ? `卖出流水已补记：${record.shares} 股 @ ${record.price}（已实现 ${record.pnl > 0 ? '+' : ''}${record.pnl.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元）`
            : `卖出流水已补记：${record.shares} 股（未取到行情价，已实现盈亏待补 trades.csv）`,
        )
        const { stats } = readRealized(trades)
        lines.push(`累计已实现盈亏：${stats.pnl === null ? '—' : `${stats.pnl > 0 ? '+' : ''}${stats.pnl.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} 元（卖出 ${stats.trades} 笔）`)
      } else {
        lines.push(`⚠️ ${warning}`)
      }
      return lines.join('\n')
    },
  })

  // 手动补录流水：历史交易（清仓/减仓发生在启用流水之前）或修正自动补记的记录时用。
  // 与自动补记互不排斥但禁止重复记同一笔——流水是审计轨迹，重复会虚增已实现盈亏。
  ctx.tools.register({
    name: 'astock_record_trade',
    description:
      '手动补录一条卖出/买入流水到 trades.csv。仅在用户明确要记录某笔（历史）交易时调用：' +
      '清仓/减仓经 astock_reconcile 或 astock_remove_position 处理时会自动补记，同一笔不要重复录入。' +
      '卖出在价格与成本齐备时计入累计已实现盈亏与胜率；成本缺省时自动取当前持仓表该代码的成本；' +
      '买入记录仅留档备复盘，不进统计。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '交易日 YYYY-MM-DD；省略时使用本地今天' },
        code: { type: 'string', description: '股票/ETF 代码' },
        name: { type: 'string', description: '名称（可选）' },
        action: { type: 'string', enum: ['sell', 'buy'], description: 'sell 卖出（默认）/ buy 买入' },
        shares: { type: 'number', description: '成交股数（正整数）' },
        price: { type: 'number', description: '每股成交价；卖出建议必填（计盈亏用）' },
        cost: { type: 'number', description: '每股成本（可选；卖出缺省时自动取当前持仓表成本）' },
        note: { type: 'string', description: '备注（可选）' },
      },
      required: ['code', 'shares'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: {
      date?: string
      code: string
      name?: string
      action?: string
      shares: number
      price?: number
      cost?: number
      note?: string
    }) => {
      const date = args.date?.trim() ? validateLogDate(args.date) : currentLocalDate()
      const action = args.action === 'buy' ? 'buy' : 'sell'
      let record: TradeRecord
      if (action === 'sell') {
        // 成本缺省时取当前持仓表口径：减仓场景下那正是本地摊薄成本；已清仓的代码取不到则留空
        const cost = args.cost ?? store.loadDoc().positions.find(p => p.code === normalizeSymbol(args.code))?.cost ?? null
        record = makeSellRecord({
          date,
          code: args.code,
          name: args.name,
          shares: args.shares,
          price: args.price ?? null,
          cost,
          note: args.note?.trim() || '手动补录',
        })
      } else {
        if (!Number.isInteger(args.shares) || args.shares <= 0) throw new Error('股数必须是正整数')
        record = {
          date,
          code: normalizeSymbol(args.code),
          name: args.name?.trim() ?? '',
          action,
          shares: args.shares,
          price: args.price ?? null,
          cost: null,
          pnl: null,
          note: args.note?.trim() || '手动补录',
        }
      }
      const { warning } = trades.appendAll([record])
      if (warning !== undefined) return `⚠️ ${warning}`
      const { stats } = readRealized(trades)
      const lines = [
        `已记录${action === 'sell' ? '卖出' : '买入'}流水：${record.code} ${record.name || ''} ${record.shares} 股${record.price !== null ? ` @ ${record.price}` : ''}`,
        record.action === 'sell'
          ? record.pnl !== null
            ? `本笔已实现盈亏：${record.pnl > 0 ? '+' : ''}${record.pnl.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元`
            : '本笔缺卖出价/成本，暂不计入已实现盈亏统计（可补齐 trades.csv 或重新补录）'
          : '买入流水仅留档，不计入已实现盈亏统计',
        `累计已实现盈亏：${stats.pnl === null ? '—' : `${stats.pnl > 0 ? '+' : ''}${stats.pnl.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} 元（卖出 ${stats.trades} 笔，胜率 ${stats.winRate === null ? '—' : `${stats.winRate.toFixed(1)}%`}）`,
        `存储文件：${trades.file}`,
      ]
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'astock_trades',
    description:
      '读取卖出/买入流水（trades.csv）与累计已实现盈亏统计（合计、笔数、胜率）。' +
      '用户问「已实现盈亏 / 落袋了多少 / 最近卖了什么 / 胜率」或做交易复盘时调用；可按代码或日期范围过滤（统计口径始终是全量累计）。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '只看该代码的流水（可选）' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（含，可选）' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含，可选）' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { code?: string; from?: string; to?: string }) => {
      const doc = trades.loadDoc()
      let records = doc.records
      if (args.code !== undefined && args.code.trim() !== '') {
        const code = normalizeSymbol(args.code)
        records = records.filter(r => r.code === code)
      }
      if (args.from !== undefined && args.from.trim() !== '') {
        const from = validateLogDate(args.from)
        records = records.filter(r => r.date >= from)
      }
      if (args.to !== undefined && args.to.trim() !== '') {
        const to = validateLogDate(args.to)
        records = records.filter(r => r.date <= to)
      }
      // 统计给全量累计（headline 数字不该跟着筛选变）；列表按筛选给
      let text = renderTradesList(records, summarizeTrades(doc.records))
      if (doc.warnings.length > 0) {
        text += `\n${doc.warnings.map(w => `- ⚠️ ${w}`).join('\n')}`
      }
      return text
    },
  })

  // 内嵌 HTML 图解（astock-explain 技能的呈现通道）：模型生成的单文件 HTML
  // 存档到 explainers/，并以不可见注释 tag 捎回，client 半面在对话流里用
  // 沙箱 iframe 直接渲染——用户在聊天页内交互预览，不跳系统浏览器开文件。
  // HTML 转 base64 进 tag：字面 `-->` 会截断注释定界符（见 dto.ts decodeHtmlPreviewTag）。
  ctx.tools.register({
    name: 'astock_show_html',
    description:
      '把一张单文件交互式 HTML 图解（术语图解/概念演示/可动手的动画页）内嵌到对话消息里预览，' +
      '用户无需打开外部浏览器即可直接交互。HTML 必须已完整生成：单文件、内联全部 CSS/JS、' +
      '零外部依赖零网络请求；一个概念一页，全文控制在 60KB 以内。调用后用一两句话告诉用户' +
      '「可以动手操作什么、观察什么变化」，不要复述页面全部内容。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '图解标题（一句话结论式），如「市盈率 = 按现在的赚钱速度几年回本」' },
        html: { type: 'string', description: '完整 HTML 文档全文（<!DOCTYPE html> 开头，内联全部 CSS/JS）' },
      },
      required: ['title', 'html'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { title: string; html: string }) => {
      const html = args.html ?? ''
      if (html.trim() === '') throw new Error('html 不能为空')
      if (html.length > HTML_PREVIEW_MAX_CHARS) {
        throw new Error(
          `HTML 过大（约 ${Math.round(html.length / 1024)}KB，上限 ${Math.round(HTML_PREVIEW_MAX_CHARS / 1024)}KB）。`
            + '一个概念一页，砍掉装饰与重复示例后重试',
        )
      }
      const title = args.title?.trim() !== '' ? args.title.trim() : '互动图解'
      const file = saveExplainerHtml(store.dir, title, html)
      const payload: HtmlPreviewPayload = {
        v: HTML_PREVIEW_PAYLOAD_VERSION,
        title,
        file,
        htmlB64: Buffer.from(html, 'utf8').toString('base64'),
      }
      return [
        `图解「${title}」已在对话中内嵌预览（沙箱环境，可直接交互），存档：${file}`,
        '接下来用一两句话引导用户怎么玩、看什么变化（交互说法自由发挥，别每次都提滑杆按钮），并确认是否看懂；不要复述页面全部内容。',
        encodeTag('htmlpreview', payload),
      ].join('\n')
    },
  })

  // 持仓对账（券商App截图/文字 → 本地表）：模型只当「眼睛」抄录截图数字，
  // 校验/diff/写入全部本地确定性完成。两段式 fail-closed：预览发 token，
  // 确认后带同一 token 才写入；token 绑定「行集 + 持仓文件当前内容」，
  // 中途任何变化都会让 token 失效，防止把用户看过的差异写到已变化的文件上。
  ctx.tools.register({
    name: 'astock_reconcile',
    description:
      '持仓对账：把从券商App持仓页截图（或粘贴文字）读出的全部持仓行与本地持仓表对比同步。' +
      '第一次调用（不带 token）只做校验和差异预览，返回差异清单和对账 token，必须先展示给用户确认；' +
      '用户明确确认后，带同一 token 再次调用才写入（以券商数据覆盖本地股数/成本）。' +
      'token 不匹配会拒绝写入（行集或持仓表已变化，需重新预览）。' +
      '截图里没有的持仓默认保留（防截图不全误删），用户确认已清仓时加 removeMissing: true。' +
      '写入时会自动为清仓/减仓的持仓在卖出流水（trades.csv）补记一笔卖出（卖出价按当时行情、成本按本地记录，事后可修正）。',
    parameters: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          description: '读出的全部持仓行（一次给全，不要分批；只抄录，禁止换算/估算）',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: '股票/ETF 代码，6 位数字或带 sh/sz/bj 前缀' },
              name: { type: 'string', description: '名称（可选）' },
              shares: { type: 'number', description: '持仓股数（正整数，照抄截图）' },
              cost: { type: 'number', description: '每股成本价（券商页面口径，照抄截图）' },
            },
            required: ['code', 'shares', 'cost'],
          },
        },
        token: { type: 'string', description: '预览返回的对账 token；仅用户确认后写入时传入' },
        removeMissing: { type: 'boolean', description: '写入时是否同时清仓本地有、截图里没有的持仓（默认 false）' },
      },
      required: ['rows'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: { rows: unknown; token?: string; removeMissing?: boolean }, exec) => {
      const { valid, errors } = validateReconcileRows(args.rows)
      if (errors.length > 0) {
        return ['⚠️ 以下行校验失败，本次未做任何对账（请重新核对截图后重试）：', ...errors.map(e => `- ${e}`)].join('\n')
      }
      if (valid.length === 0) throw new Error('rows 不能为空')
      const raw = existsSync(store.file) ? readFileSync(store.file, 'utf8') : ''
      const doc = parseHoldingsDoc(raw)
      if (doc.warnings.length > 0) return refuseWrite(doc.warnings)
      const token = reconcileToken(valid, raw)
      const diff = diffReconcile(valid, doc.positions)
      if (args.token === undefined) {
        if (diff.added.length === 0 && diff.updated.length === 0 && diff.missing.length === 0) {
          return ['## 持仓对账（预览）', '', `与本地持仓表完全一致（${diff.unchanged.length} 只），无需写入。`].join('\n')
        }
        return renderReconcilePreview(diff, token)
      }
      if (args.token !== token) {
        throw new Error(
          '对账 token 不匹配：持仓行或持仓表在确认前后发生了变化，为防串写已拒绝。请重新调用（不带 token）生成新预览，再让用户确认。',
        )
      }
      const { doc: next, removed } = applyReconcile(doc, diff, args.removeMissing === true)
      // 只有 missing 且未开启 removeMissing 时无实际变更，不写文件（写了也是原样重渲染）
      if (diff.added.length === 0 && diff.updated.length === 0 && removed.length === 0) {
        return '对账完成：无新增/更新，截图未出现的持仓按默认保留（如需清仓请确认后带 removeMissing 重新写入）。'
      }
      store.writeDoc(next)
      // 清仓/减仓同步补记卖出流水：token 已校验过「用户看过的差异」，这里的补记是同一份
      // diff 的确定性推导，不会引入用户没确认过的写入
      const events = collectSellEvents(diff, args.removeMissing === true)
      let recorded: RecordedSell[] = []
      let sellWarning: string | undefined
      if (events.length > 0) {
        const res = await recordSellEvents(trades, events, '对账自动补记', exec?.signal)
        recorded = res.recorded
        sellWarning = res.warning
      }
      return [
        renderReconcileApplied(diff, removed, store.file, recorded),
        ...(sellWarning !== undefined ? [`- ⚠️ ${sellWarning}`] : []),
        '已同步。下次 astock_positions / 工作台刷新即显示新持仓。',
      ].join('\n')
    },
  })

  ctx.commands.register({
    name: 'portfolio',
    description: 'A股工作台：打印当前持仓与实时行情的确定性汇总（不经模型，纯本地计算）',
    handler: async invocation => {
      const signal = (invocation as { signal?: AbortSignal } | undefined)?.signal
      try {
        return { kind: 'success', text: await buildPositionsText(store, trades, signal) }
      } catch (e) {
        return { kind: 'error', text: `持仓汇总失败：${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })

  // 大盘概览的免对话直读通道：面板顶部行情条经 remote.commands 直接取。
  // 与持仓行情是两条独立链路——大盘挂了不影响持仓表，所以这里永远返回 success，
  // 失败信息装在载荷的 error 字段里由 UI 降级展示。
  ctx.commands.register({
    name: 'market',
    description: 'A股工作台：大盘概览（三大指数、涨跌家数、成交额、主力净流入；不经模型）',
    handler: async invocation => {
      const signal = (invocation as { signal?: AbortSignal } | undefined)?.signal
      const payload = await fetchMarketOverview(signal)
      return { kind: 'success', text: renderMarketText(payload) }
    },
  })

  // 投资者画像的读写通道：面板设置卡经 remote.commands 直接调（不经模型）。
  // 读写同一条命令：无参数=读，`set <base64(json)>`=写。命令行只能传字符串，
  // 中文 note 走 base64 避免引号/换行在命令行里被切碎。
  ctx.commands.register({
    name: 'profile',
    description: 'A股工作台：读取/设置投资者画像（回答详略、术语解释、结论位置）',
    input: { hint: '留空读取；`set <base64(json)>` 写入' },
    handler: invocation => {
      const rawInput = String((invocation as { rawInput?: string } | undefined)?.rawInput ?? '').trim()
      try {
        let profile: InvestorProfile | null
        if (rawInput === '') {
          profile = readProfile(store.dir)
        } else {
          const encoded = rawInput.startsWith('set ') ? rawInput.slice(4).trim() : ''
          if (encoded === '') return { kind: 'error', text: '用法：/profile 读取，/profile set <base64(json)> 写入' }
          const json = Buffer.from(encoded, 'base64').toString('utf8')
          profile = writeProfile(store.dir, JSON.parse(json), currentLocalDate())
        }
        return { kind: 'success', text: renderProfileText(profile) }
      } catch (e) {
        return { kind: 'error', text: `画像读写失败：${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })

  // 决策日志的免对话直读通道：工作台面板首屏/「刷新日志」经 remote.commands 直接取，
  // 不经模型（与 /portfolio 同款路径），保证日志列表不需要先发一条 AI 消息才出现。
  ctx.commands.register({
    name: 'decision-logs',
    description: 'A股工作台：读取交易日决策日志列表（不经模型，纯本地读取）',
    handler: async () => {
      try {
        return { kind: 'success', text: renderDecisionLogs(decisionLogs.list()) }
      } catch (e) {
        return { kind: 'error', text: `读取决策日志失败：${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}
