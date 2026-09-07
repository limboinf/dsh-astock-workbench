/**
 * 大盘概览 —— 东方财富 push2 为主源、腾讯免费接口兜底。
 *
 * 与持仓行情（quotes.ts）是**两条独立链路**：大盘条挂了不该影响持仓表，反之亦然。
 * 所以这里所有失败都收敛成「payload.error + 数据为 null」，从不向上抛。
 *
 * 接口契约（2026-09-04 实测固化）：
 * - 东财 GET https://push2.eastmoney.com/api/qt/ulist.np/get
 *   ?fltt=2&secids=<市场.代码,...>&fields=f1,f2,f3,f4,f6,f12,f14,f62,f104,f105,f106,f124
 *   secid 前缀：1=沪市、0=深市（1.000001 上证指数 / 0.399001 深证成指 / 0.399006 创业板指）。
 *   fltt=2 让 f2/f3 直接返回带小数的数值（否则是放大 100 倍的整数）。
 *   字段：f2 现价、f3 涨跌幅%、f4 涨跌额、f6 成交额(元)、f12 代码、f14 名称、
 *        f62 主力净流入(元)、f104/f105/f106 涨/跌/平家数、f124 快照时间(秒级)。
 *   注意 rc=0 才算成功；缺字段返回 '-' 或 0，逐项当缺失处理。
 * - 腾讯兜底 GET https://qt.gtimg.cn/q=sh000001,sz399001,sz399006（GBK）：
 *   指数与股票的字段布局一致，可复用 quotes.ts 的下标口径；但**只有指数价格**，
 *   涨跌家数与主力净流入拿不到，兜底时这两项显示为「—」。
 *
 * 这两个都是非官方公开接口，无契约保证——与腾讯持仓兜底同款纪律：字段下标固化在
 * 常量里、实测样本进单测、解析失败逐项降级并在 UI 上标注数据源。
 */

import { combinedFetchSignal } from './fuyao.ts'
import { MARKET_PAYLOAD_VERSION, type MarketIndexRow, type MarketPayload } from './dto.ts'

/** 顶部大盘条固定跟这三个指数；secid 前缀 1=沪、0=深 */
const INDICES: { secid: string; symbol: string }[] = [
  { secid: '1.000001', symbol: 'sh000001' },
  { secid: '0.399001', symbol: 'sz399001' },
  { secid: '0.399006', symbol: 'sz399006' },
]

const EM_FIELDS = 'f1,f2,f3,f4,f6,f12,f14,f62,f104,f105,f106,f124'

/** 东财用 '-' 表示无值，0 在成交额/家数上也可能是「还没开盘」；统一收敛成 null */
function emNum(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 东财 f124 → 'HH:MM:SS'。两种形态都见过：当日秒数（<=86400）与 unix 秒。
 * 当日秒数是纯钟点算术，绝不能过 Date——Date.UTC + getHours() 会把它按本机时区
 * 偏移一次（东八区下 10:30 变成 18:30）。unix 秒才需要按本地时区渲染。
 */
function formatMarketTime(raw: unknown): string | null {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  if (n === null || n <= 0) return null
  if (n <= 86_400) return `${pad2(Math.floor(n / 3600) % 24)}:${pad2(Math.floor(n / 60) % 60)}:${pad2(n % 60)}`
  const date = new Date(n * 1000)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** 解析东财 ulist 响应（已 JSON.parse）；结构不符返回空数组，由调用方走兜底 */
export function parseEastmoneyOverview(body: unknown): { rows: MarketIndexRow[]; time: string | null } {
  const root = body as { rc?: number; data?: { diff?: unknown[] } } | null
  if (root === null || typeof root !== 'object' || root.rc !== 0) return { rows: [], time: null }
  const diff = root.data?.diff
  if (!Array.isArray(diff)) return { rows: [], time: null }
  const rows: MarketIndexRow[] = []
  let time: string | null = null
  for (const item of diff) {
    const r = item as Record<string, unknown>
    const code = typeof r.f12 === 'string' ? r.f12 : ''
    const name = typeof r.f14 === 'string' ? r.f14 : ''
    if (code === '') continue
    time ??= formatMarketTime(r.f124)
    rows.push({
      code,
      name,
      price: emNum(r.f2),
      change: emNum(r.f4),
      changePct: emNum(r.f3),
      amount: emNum(r.f6),
      up: emNum(r.f104),
      down: emNum(r.f105),
      flat: emNum(r.f106),
      netInflow: emNum(r.f62),
    })
  }
  return { rows, time }
}

/**
 * 腾讯兜底解析：指数与股票字段布局一致（下标口径与 quotes.ts 的 IDX 相同）。
 * 只填得出价格类字段，家数与资金流留 null——UI 据此显示「—」而不是编 0。
 */
export function parseTencentOverview(text: string): { rows: MarketIndexRow[]; time: string | null } {
  const rows: MarketIndexRow[] = []
  let time: string | null = null
  const re = /v_[A-Za-z]{2}(\d{6})="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const f = m[2].split('~')
    const num = (i: number): number | null => {
      const v = Number(f[i])
      return f[i] !== undefined && f[i].trim() !== '' && Number.isFinite(v) ? v : null
    }
    // 腾讯时间是 14 位 YYYYMMDDHHMMSS
    const raw = f[30] ?? ''
    if (time === null && raw.length === 14) time = `${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`
    const amountWan = num(37)
    rows.push({
      code: m[1],
      name: (f[1] ?? '').trim(),
      price: num(3),
      change: num(31),
      changePct: num(32),
      amount: amountWan === null ? null : amountWan * 10_000,
      up: null,
      down: null,
      flat: null,
      netInflow: null,
    })
  }
  return { rows, time }
}

/**
 * 汇总沪深两市合计。
 *
 * ⚠️ 只累加上证与深证，**不能把创业板算进去**：创业板指的成分股本就包含在深证
 * 成指所在的深市里，一并累加会把深市重复计一遍（家数、成交额、资金流都会虚高）。
 */
export function sumMarketTotals(rows: MarketIndexRow[]): MarketPayload['totals'] {
  const counted = rows.filter(r => r.code === '000001' || r.code === '399001')
  const add = (pick: (r: MarketIndexRow) => number | null): number | null => {
    const values = counted.map(pick).filter((v): v is number => v !== null)
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0)
  }
  return {
    up: add(r => r.up),
    down: add(r => r.down),
    flat: add(r => r.flat),
    amount: add(r => r.amount),
    netInflow: add(r => r.netInflow),
  }
}

function emptyPayload(error: string): MarketPayload {
  return {
    v: MARKET_PAYLOAD_VERSION,
    time: null,
    indices: [],
    totals: { up: null, down: null, flat: null, amount: null, netInflow: null },
    source: 'eastmoney',
    error,
  }
}

async function fetchEastmoney(signal?: AbortSignal): Promise<MarketPayload | null> {
  const s = combinedFetchSignal(signal, 8_000)
  try {
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2`
      + `&secids=${INDICES.map(i => i.secid).join(',')}&fields=${EM_FIELDS}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (dsh-astock-workbench)',
        Referer: 'https://quote.eastmoney.com/',
      },
      signal: s.signal,
    })
    if (!res.ok) return null
    const { rows, time } = parseEastmoneyOverview(await res.json())
    if (rows.length === 0) return null
    return {
      v: MARKET_PAYLOAD_VERSION,
      time,
      indices: rows,
      totals: sumMarketTotals(rows),
      source: 'eastmoney',
      error: null,
    }
  } catch {
    return null
  } finally {
    s.dispose()
  }
}

async function fetchTencent(signal?: AbortSignal): Promise<MarketPayload | null> {
  const s = combinedFetchSignal(signal, 8_000)
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${INDICES.map(i => i.symbol).join(',')}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (dsh-astock-workbench)' },
      signal: s.signal,
    })
    if (!res.ok) return null
    const text = new TextDecoder('gbk').decode(await res.arrayBuffer())
    const { rows, time } = parseTencentOverview(text)
    if (rows.length === 0) return null
    return {
      v: MARKET_PAYLOAD_VERSION,
      time,
      indices: rows,
      totals: sumMarketTotals(rows),
      source: 'tencent',
      error: null,
    }
  } catch {
    return null
  } finally {
    s.dispose()
  }
}

/** 取大盘概览：东财主源 → 腾讯兜底 → 全失败也返回结构完整的空载荷（从不抛错） */
export async function fetchMarketOverview(signal?: AbortSignal): Promise<MarketPayload> {
  return (await fetchEastmoney(signal))
    ?? (await fetchTencent(signal))
    ?? emptyPayload('大盘行情接口暂不可用（东财、腾讯均失败）')
}
