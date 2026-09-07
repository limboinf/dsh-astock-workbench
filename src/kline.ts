/**
 * 个股历史日 K —— 深度分析数据层：fuyao（同花顺金融数据）为主源、腾讯免费接口兜底。
 *
 * 路由规则（复用 quotes.ts 的分流纪律）：
 * - 股票 → fuyao /api/a-share/prices/historical（实测仅覆盖沪深**股票**，ETF 报 1002）；
 * - ETF / fuyao 失败的股票 → 腾讯 fqkline 兜底（股票/ETF/指数均可用，2026-09-06 实测）。
 *
 * 接口契约（2026-09-06 实测固化，与 quotes.ts 同源纪律：字段固化、样本进单测、失败逐标的降级）：
 * - fuyao：GET /api/a-share/prices/historical，参数 thscode=600522.SH（点分格式，links.ts 转换）、
 *   interval=1d、start/end=毫秒时间戳（**无 count 参数**，按窗口取数后截尾 N 根）、
 *   adjust=forward（前复权）。data.item[] 按日期升序，每根：
 *   { date_ms（北京时间零点）, volume（股）, turnover, open_price, high_price, low_price, close_price }。
 * - 腾讯：GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600522,day,,,60,qfq
 *   （param 五段：代码,周期,开始,结束,条数,复权）。data.<code>.qfqday[] 每行为字符串数组，
 *   下标 [0]日期 [1]开 [2]收 [3]高 [4]低 [5]成交量（手）——**收盘在下标 2、高在下标 3**，
 *   与常见 OHLC 顺序不同；不复权请求时键名为 day，指数无复权概念同样可能返回 day，两者都解析。
 * - 两源前复权口径一致（sh600522 同日开高低收实测逐位相同），volume 统一换算为「手」。
 *
 * 数据纪律同 quotes.ts：本模块只做确定性取数与解析，不做任何推断；
 * 拿不到的字段就是 undefined，坏行跳过，解析失败由上层 ⚠️ 标注。
 */

import { isLikelyFund, toThscode } from './links.ts'
import { normalizeSymbol } from './symbols.ts'
import { combinedFetchSignal, fetchFuyaoData } from './fuyao.ts'

export { normalizeSymbol, toThscode }

/** 一根日 K；volume 单位与全项目一致（手） */
export interface KBar {
  /** 交易日 YYYY-MM-DD */
  date: string
  open: number
  close: number
  high: number
  low: number
  /** 成交量（手） */
  volume: number
}

export interface Kline {
  symbol: string
  /** 按日期升序，最多 count 根 */
  bars: KBar[]
  /** 本序列由哪条链路取到（诊断用，展示层不消费） */
  source: 'fuyao' | 'tencent'
}

// ---------- fuyao 解析（仅股票） ----------

interface FuyaoKlineItem {
  date_ms?: number | null
  volume?: number | null
  open_price?: number | null
  high_price?: number | null
  low_price?: number | null
  close_price?: number | null
}

const num = (v: number | null | undefined): number | undefined =>
  v === null || v === undefined || !Number.isFinite(v) ? undefined : v

/**
 * fuyao K 线条目 → KBar。date_ms 是北京时间零点，转上海时区日期串
 * （复用 quotes.ts 的 formatShanghaiTime，避免再造一份时区逻辑）。
 * 量纲统一：volume 股→手 ÷100。字段无效返回 null 跳过。
 */
export function parseFuyaoKlineItem(
  item: FuyaoKlineItem,
  toShanghaiDate: (ms: number) => string,
): KBar | null {
  const o = num(item.open_price)
  const c = num(item.close_price)
  const h = num(item.high_price)
  const l = num(item.low_price)
  const d = num(item.date_ms)
  if (o === undefined || c === undefined || h === undefined || l === undefined || d === undefined) {
    return null
  }
  return {
    date: toShanghaiDate(d),
    open: o,
    close: c,
    high: h,
    low: l,
    volume: Math.round((num(item.volume) ?? 0) / 100),
  }
}

interface FuyaoKlineData {
  item?: FuyaoKlineItem[]
}

/** fuyao 历史价格响应 → KBar[]（升序原样返回，截尾由调用方负责） */
export function parseFuyaoKline(data: unknown, toShanghaiDate: (ms: number) => string): KBar[] {
  const d = data as FuyaoKlineData
  const bars: KBar[] = []
  for (const item of d?.item ?? []) {
    const bar = parseFuyaoKlineItem(item, toShanghaiDate)
    if (bar !== null) bars.push(bar)
  }
  return bars
}

/**
 * 取 fuyao 日 K：无 count 参数，按日历窗口换算（工作日 ≈ 5/7，再留 holidays 余量），
 * 返回后截尾最后 count 根。股票才走这条路（ETF/指数实测 1002）。
 */
export async function fetchFuyaoKline(
  symbol: string,
  count: number,
  options?: { signal?: AbortSignal },
): Promise<KBar[]> {
  const end = Date.now()
  const start = end - Math.ceil(count * 2.4 + 30) * 24 * 3600 * 1000
  const data = await fetchFuyaoData(
    '/api/a-share/prices/historical',
    { thscode: toThscode(symbol), interval: '1d', start, end, adjust: 'forward' },
    { signal: options?.signal },
  )
  return parseFuyaoKline(data, ms => formatShanghaiDate(ms)).slice(-count)
}

/** 毫秒时间戳 → 上海时区 "YYYY-MM-DD"（fuyao 的 date_ms 为北京时间零点） */
export function formatShanghaiDate(ms: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
  }).formatToParts(new Date(ms))
  const get = (t: string): string => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

// ---------- 腾讯兜底（股票/ETF/指数） ----------

/** 腾讯 K 线行下标（2026-09-06 实测样本固化；注意收在高前面） */
const KIDX = { date: 0, open: 1, close: 2, high: 3, low: 4, volume: 5 } as const

function ktnum(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 腾讯 fqkline 响应 → KBar[]。data.<code> 下 qfqday（前复权）或 day（不复权/指数）
 * 任一存在即解析；行内字段无效跳过该行，数组整体缺失返回 []。
 */
export function parseTencentKline(data: unknown, symbol: string): KBar[] {
  const entry = (data as { data?: Record<string, Record<string, unknown>> })?.data?.[symbol]
  const rows = (entry?.['qfqday'] ?? entry?.['day']) as unknown
  if (!Array.isArray(rows)) return []
  const bars: KBar[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const f = row as string[]
    const date = typeof f[KIDX.date] === 'string' ? f[KIDX.date] : ''
    const o = ktnum(f[KIDX.open])
    const c = ktnum(f[KIDX.close])
    const h = ktnum(f[KIDX.high])
    const l = ktnum(f[KIDX.low])
    if (date === '' || o === undefined || c === undefined || h === undefined || l === undefined) continue
    bars.push({ date, open: o, close: c, high: h, low: l, volume: ktnum(f[KIDX.volume]) ?? 0 })
  }
  return bars
}

/** 腾讯 K 线兜底：失败静默返回空序列（缺口由上层 ⚠️ 标注） */
async function fetchTencentKline(
  symbol: string,
  count: number,
  options?: { signal?: AbortSignal },
): Promise<KBar[]> {
  const s = combinedFetchSignal(options?.signal, 10_000)
  try {
    const url =
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` +
      `?param=${encodeURIComponent(`${symbol},day,,,${count},qfq`)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (dsh-astock-workbench)' },
      signal: s.signal,
    })
    if (!res.ok) return []
    const json = (await res.json()) as unknown
    return parseTencentKline(json, symbol)
  } catch {
    return []
  } finally {
    s.dispose()
  }
}

// ---------- 统一入口 ----------

/**
 * 拉取日 K：fuyao 主源（仅股票）+ 腾讯兜底其余（ETF/指数/fuyao 失败）。
 * 结果 Map 缺某代码即该标的失败，由上层决定如何标注；用户中止必须穿透降级逻辑。
 */
export async function fetchKlines(
  symbols: string[],
  options?: { count?: number; signal?: AbortSignal },
): Promise<Map<string, Kline>> {
  const count = options?.count ?? 60
  const aborted = (): boolean => options?.signal?.aborted === true
  if (aborted()) throw new Error('K 线请求已中止')

  const unique = [...new Set(symbols.map(normalizeSymbol))]
  const out = new Map<string, Kline>()
  const missing: string[] = []

  await Promise.all(
    unique.map(async symbol => {
      if (isLikelyFund(symbol)) {
        missing.push(symbol)
        return
      }
      try {
        const bars = await fetchFuyaoKline(symbol, count, options)
        if (bars.length > 0) {
          out.set(symbol, { symbol, bars, source: 'fuyao' })
          return
        }
        missing.push(symbol)
      } catch (e) {
        if (aborted()) throw e
        missing.push(symbol)
      }
    }),
  )

  await Promise.all(
    missing.map(async symbol => {
      const bars = await fetchTencentKline(symbol, count, options)
      if (bars.length > 0) out.set(symbol, { symbol, bars, source: 'tencent' })
    }),
  )

  return out
}

// ---------- 确定性派生指标（深度分析的原料，AI 只解读不计算） ----------

export interface KlineStats {
  /** 现价 = 最后一根收盘 */
  lastClose: number
  ma5: number | undefined
  ma20: number | undefined
  /** 量比：最新成交量 / 前 20 根均量（不足 20 根为 undefined） */
  volRatio: number | undefined
  /** 20 日区间位置：最新收盘在 [20日最低, 20日最高] 中的百分位（0=最低） */
  pos20: number | undefined
  /** 近 20 日最低/最高（支撑压力参考） */
  low20: number | undefined
  high20: number | undefined
  /** 区间收益率（%，正为涨）：n 根前的收盘 → 现价 */
  ret5: number | undefined
  ret20: number | undefined
}

export function computeKlineStats(bars: KBar[]): KlineStats {
  const n = bars.length
  const last = bars[n - 1]
  const closes = bars.map(b => b.close)
  const sma = (period: number): number | undefined => {
    if (n < period) return undefined
    let s = 0
    for (let i = n - period; i < n; i++) s += closes[i]
    return s / period
  }
  const ret = (period: number): number | undefined => {
    if (n < period + 1) return undefined
    const base = closes[n - 1 - period]
    return base > 0 ? (closes[n - 1] / base - 1) * 100 : undefined
  }
  const window = bars.slice(-20)
  const low20 = window.length > 0 ? Math.min(...window.map(b => b.low)) : undefined
  const high20 = window.length > 0 ? Math.max(...window.map(b => b.high)) : undefined
  // 量比分母是「前 20 根」（不含最新一根，否则今天巨量会被自己稀释）
  const volWindow = bars.slice(-21, -1)
  const avgVol = volWindow.length === 20 ? volWindow.reduce((s, b) => s + b.volume, 0) / 20 : undefined
  return {
    lastClose: last.close,
    ma5: sma(5),
    ma20: sma(20),
    volRatio:
      avgVol !== undefined && avgVol > 0 ? last.volume / avgVol : undefined,
    pos20:
      low20 !== undefined && high20 !== undefined && high20 > low20
        ? ((last.close - low20) / (high20 - low20)) * 100
        : undefined,
    low20,
    high20,
    ret5: ret(5),
    ret20: ret(20),
  }
}
