/**
 * A股实时行情 —— fuyao（同花顺金融数据）为主源、腾讯免费接口兜底。
 *
 * 路由规则（代码前缀判基金，单一来源 links.ts 的 isLikelyFund）：
 * - 股票 → /api/a-share/prices/snapshot 批量（thscodes 逗号分隔）；
 * - ETF → /api/fund/market/snapshot 逐只（接口只收单个 thscode）。
 * fuyao 实测缺口（2026-09-04，详见 fuyao.ts 头注）：深市股票「有壳无价」、
 * 深市 ETF 报 3002、北交所报 1002——凡 fuyao 没给到有效价格的代码，
 * 整体回落腾讯（qt.gtimg.cn，GBK）补齐，保证持仓表全覆盖；fuyao 补齐后可删兜底。
 *
 * 数据纪律：本模块只做「确定性取数与解析」，不做任何推断；
 * 拿不到的字段就是 undefined，由上层决定如何展示。
 */

import { isLikelyFund, toThscode } from './links.ts'
import { normalizeSymbol } from './symbols.ts'
import { combinedFetchSignal, fetchFuyaoData, isFuyaoApiError } from './fuyao.ts'

// 规范化规则的单一来源在 symbols.ts；此处 re-export 供老调用方（index.ts/测试）继续引用
export { normalizeSymbol }
// thscode 转换的单一来源在 links.ts（client 提示词也要用）；re-export 供测试引用
export { toThscode }

export interface Quote {
  /** 规范化代码，如 sh600519 */
  symbol: string
  name: string
  code: string
  /** 现价 */
  price: number
  prevClose: number
  open: number
  high: number
  low: number
  /** 涨跌额 */
  change: number
  /** 涨跌幅（百分数，如 0.11 表示 +0.11%） */
  changePct: number
  /** 成交量（手） */
  volume: number
  /** 成交额（万元） */
  amountWan: number
  /** 行情时间：fuyao 为 "YYYY-MM-DD HH:MM:SS"（上海时区），腾讯兜底为 14 位数字串 */
  time: string
  /** 市盈率（TTM） */
  pe?: number
  /** 市净率 */
  pb?: number
  /** 换手率（%） */
  turnoverPct?: number
  /** 总市值（亿元） */
  totalMvYi?: number
  /** 本条行情由哪条链路取到（诊断用，展示层不消费） */
  source?: 'fuyao' | 'tencent'
}

// ---------- fuyao 解析 ----------

/** fuyao 快照条目（股票/ETF 共用字段；按官方文档 + 实测样本固化） */
interface FuyaoSnapshotItem {
  thscode?: string
  ticker?: string
  last_price?: number | null
  price_change?: number | null
  price_change_ratio_pct?: number | null
  open_price?: number | null
  high_price?: number | null
  low_price?: number | null
  prev_price?: number | null
  volume?: number | null
  turnover?: number | null
  /** 仅基金快照返回 */
  turnover_ratio_pct?: number | null
}

const num = (v: number | null | undefined): number | undefined =>
  v === null || v === undefined || !Number.isFinite(v) ? undefined : v

/**
 * fuyao 快照条目 → Quote。last_price 无效（深市缺口，以及盘前/上游重置窗口的
 * 快照清空，2026-09-04 实测）返回 null，由调用方记入缺失、走腾讯兜底。
 * 单位换算：volume 股→手、turnover 元→万。
 */
export function parseFuyaoItem(item: FuyaoSnapshotItem, time: string, fund: boolean): Quote | null {
  const price = num(item.last_price)
  const thscode = String(item.thscode ?? '')
  if (price === undefined || price <= 0 || thscode === '') return null
  // fuyao thscode（600519.SH）→ 本项目规范化 symbol（sh600519）：先剥交易所后缀
  const symbol = normalizeSymbol(thscode.replace(/\.(SH|SZ|BJ)$/i, ''))
  return {
    symbol,
    name: '', // 快照不返回名称：持仓展示用 CSV 名，astock_quote 走 valuations 补齐
    code: String(item.ticker ?? symbol.replace(/^[a-z]{2}/, '')),
    price,
    prevClose: num(item.prev_price) ?? price,
    open: num(item.open_price) ?? price,
    high: num(item.high_price) ?? price,
    low: num(item.low_price) ?? price,
    change: num(item.price_change) ?? 0,
    changePct: num(item.price_change_ratio_pct) ?? 0,
    volume: Math.round((num(item.volume) ?? 0) / 100),
    amountWan: (num(item.turnover) ?? 0) / 10000,
    time,
    turnoverPct: fund ? num(item.turnover_ratio_pct) : undefined,
    source: 'fuyao',
  }
}

/** 毫秒时间戳 → 上海时区 "YYYY-MM-DD HH:MM:SS"（fuyao 的 data.timestamp 用） */
export function formatShanghaiTime(ms: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms))
  const get = (t: string): string => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

interface FuyaoSnapshotData {
  timestamp?: number | null
  item?: FuyaoSnapshotItem[]
}

/** 从 fuyao 批量响应里取行情；返回 (symbol → Quote) 与该响应的行情时间 */
export function parseFuyaoSnapshot(data: unknown, fund: boolean): { quotes: Map<string, Quote>; time: string } {
  const d = data as FuyaoSnapshotData
  const time = d?.timestamp !== undefined && d.timestamp !== null ? formatShanghaiTime(d.timestamp) : ''
  const quotes = new Map<string, Quote>()
  for (const item of d?.item ?? []) {
    const quote = parseFuyaoItem(item, time, fund)
    if (quote !== null) quotes.set(quote.symbol, quote)
  }
  return { quotes, time }
}

/** fuyao 估值快照：给股票 Quote 补名称/PE/PB（快照本体不带这些字段） */
export function applyValuations(quotes: Map<string, Quote>, data: unknown): void {
  const items = (data as { item?: Array<Record<string, unknown>> })?.item ?? []
  for (const it of items) {
    const thscode = String(it['thscode'] ?? '')
    if (thscode === '') continue
    // fuyao thscode（600519.SH）→ 规范化 symbol：先剥交易所后缀
    const q = quotes.get(normalizeSymbol(thscode.replace(/\.(SH|SZ|BJ)$/i, '')))
    if (q === undefined) continue
    const name = typeof it['name'] === 'string' ? it['name'].trim() : ''
    if (name !== '') q.name = name
    const pe = num(it['pe_ttm'] as number | null | undefined)
    const pb = num(it['pb_mrq'] as number | null | undefined)
    if (pe !== undefined) q.pe = pe
    if (pb !== undefined) q.pb = pb
  }
}

// ---------- 腾讯兜底（fuyao 缺口补齐，契约与旧版一致） ----------

/**
 * 解析腾讯行情响应文本（GBK 已解码为 UTF-8）。
 * 返回 Map：key 为规范化 symbol（小写），value 为 Quote。
 * 单行解析失败只跳过该行，不抛错。
 */
export function parseTencentResponse(text: string): Map<string, Quote> {
  const result = new Map<string, Quote>()
  const re = /v_([A-Za-z]{2}\d{5,6})="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const symbol = m[1].toLowerCase()
    const fields = m[2].split('~')
    const quote = parseTencentFields(symbol, fields)
    if (quote) result.set(symbol, quote)
  }
  return result
}

/** 腾讯行情字段下标（依据 2026-09 实测样本固化） */
const IDX = {
  name: 1,
  code: 2,
  price: 3,
  prevClose: 4,
  open: 5,
  volume: 6,
  time: 30,
  change: 31,
  changePct: 32,
  high: 33,
  low: 34,
  amountWan: 37,
  turnoverPct: 38,
  pe: 39,
  totalMvYi: 45,
  pb: 46,
} as const

function tnum(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function parseTencentFields(symbol: string, f: string[]): Quote | null {
  const price = tnum(f[IDX.price])
  const name = (f[IDX.name] ?? '').trim()
  if (price === undefined || price <= 0 || name === '') return null
  return {
    symbol,
    name,
    code: (f[IDX.code] ?? symbol.replace(/^[a-z]{2}/, '')).trim(),
    price,
    prevClose: tnum(f[IDX.prevClose]) ?? price,
    open: tnum(f[IDX.open]) ?? price,
    high: tnum(f[IDX.high]) ?? price,
    low: tnum(f[IDX.low]) ?? price,
    change: tnum(f[IDX.change]) ?? 0,
    changePct: tnum(f[IDX.changePct]) ?? 0,
    volume: tnum(f[IDX.volume]) ?? 0,
    amountWan: tnum(f[IDX.amountWan]) ?? 0,
    time: (f[IDX.time] ?? '').trim(),
    pe: tnum(f[IDX.pe]),
    pb: tnum(f[IDX.pb]),
    turnoverPct: tnum(f[IDX.turnoverPct]),
    totalMvYi: tnum(f[IDX.totalMvYi]),
    source: 'tencent',
  }
}

/** 腾讯兜底：只为 fuyao 没取到的代码拉行情，失败静默返回空（缺口最终由上层 ⚠️ 标注） */
async function fetchTencentFallback(
  missing: string[],
  options?: { signal?: AbortSignal },
): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>()
  if (missing.length === 0) return out
  const s = combinedFetchSignal(options?.signal, 10_000)
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${missing.join(',')}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (dsh-astock-workbench)' },
      signal: s.signal,
    })
    if (!res.ok) throw new Error(`行情兜底接口 HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    const text = new TextDecoder('gbk').decode(buf)
    for (const [k, v] of parseTencentResponse(text)) out.set(k, v)
  } catch {
    return out
  } finally {
    s.dispose()
  }
  return out
}

// ---------- 统一入口 ----------

/** 股票批量快照单次上限（保守值；ETF 逐只不受此限） */
const CHUNK_SIZE = 30

/**
 * 拉取实时行情：fuyao 主源（股票批量 + ETF 逐只）+ 腾讯兜底 fuyao 缺口。
 * 网络失败或标的无效时抛错；单只失败不影响其余（结果 Map 中缺失即失败）。
 * enrich=true 时对 fuyao 取到的股票额外调一次估值快照补名称/PE/PB
 * （仅 astock_quote 人工查询用；/portfolio 轮询路径不需要，省请求）。
 */
export async function fetchQuotes(
  symbols: string[],
  options?: { signal?: AbortSignal; enrich?: boolean },
): Promise<Map<string, Quote>> {
  const unique = [...new Set(symbols.map(normalizeSymbol))]
  const stocks = unique.filter(s => !isLikelyFund(s))
  const funds = unique.filter(s => isLikelyFund(s))
  const all = new Map<string, Quote>()
  const missing: string[] = []
  // 用户中止会话必须立即停止取数（dsh 契约），不能被降级逻辑吞掉
  const aborted = (): boolean => options?.signal?.aborted === true
  if (aborted()) throw new Error('行情请求已中止')

  // 股票：批量快照。1002 Unknown thscode 会打崩整批——剔除该代码重试，
  // 被剔除的（如北交所）记入缺失走兜底；其他失败（网络/key 缺失/5xx）整批
  // 降级兜底，不让 /portfolio 因主源故障整体挂掉。
  for (let i = 0; i < stocks.length; i += CHUNK_SIZE) {
    let batch = stocks.slice(i, i + CHUNK_SIZE)
    let done = false
    while (batch.length > 0 && !done) {
      let data: unknown
      try {
        data = await fetchFuyaoData(
          '/api/a-share/prices/snapshot',
          { thscodes: batch.map(toThscode).join(',') },
          { signal: options?.signal },
        )
      } catch (e) {
        if (aborted()) throw e
        const badThs = isFuyaoApiError(e, 1002) ? /Unknown thscode:\s*([0-9A-Za-z.]+)/.exec(e.message) : null
        if (badThs !== null) {
          const dropped = batch.filter(s => toThscode(s) === badThs[1])
          if (dropped.length > 0) {
            missing.push(...dropped)
            batch = batch.filter(s => toThscode(s) !== badThs[1])
            continue // 只重试剩下的
          }
        }
        missing.push(...batch)
        done = true
        break
      }
      const { quotes } = parseFuyaoSnapshot(data, false)
      for (const [k, v] of quotes) all.set(k, v)
      for (const s of batch) if (!quotes.has(s)) missing.push(s)
      done = true
    }
  }

  // ETF：逐只快照（接口只收单个 thscode）；任何失败（3002 未开放/网络/key）记入缺失走兜底
  await Promise.all(
    funds.map(async symbol => {
      try {
        const data = await fetchFuyaoData(
          '/api/fund/market/snapshot',
          { thscode: toThscode(symbol) },
          { signal: options?.signal },
        )
        const { quotes } = parseFuyaoSnapshot(data, true)
        const q = quotes.get(symbol)
        if (q !== undefined) all.set(symbol, q)
        else missing.push(symbol)
      } catch (e) {
        if (aborted()) throw e
        missing.push(symbol)
      }
    }),
  )

  // 兜底：只为缺口代码调腾讯，不整表回退
  for (const [k, v] of await fetchTencentFallback(missing, options)) {
    if (!all.has(k)) all.set(k, v)
  }

  // 名称/PE/PB 补齐（可选）：只补 fuyao 链路取到的股票，腾讯链路自带这些字段
  if (options?.enrich === true) {
    const fuyaoStocks = [...all.values()].filter(
      q => q.source === 'fuyao' && !isLikelyFund(q.symbol) && q.name === '',
    )
    if (fuyaoStocks.length > 0) {
      try {
        const data = await fetchFuyaoData(
          '/api/a-share/valuations/snapshot',
          { thscodes: fuyaoStocks.map(q => toThscode(q.symbol)).join(',') },
          { signal: options?.signal },
        )
        applyValuations(all, data)
      } catch {
        // 名称补不齐不影响行情本体，静默降级
      }
    }
  }
  return all
}

/** 把行情时间格式化成可读文本：14 位数字串（腾讯）转格式，其余原样返回 */
export function formatQuoteTime(t: string): string {
  if (!/^\d{14}$/.test(t)) return t
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`
}
