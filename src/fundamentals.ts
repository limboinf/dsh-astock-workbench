/**
 * 个股基本面（估值 + 财务）—— fuyao REST 直连的确定性取数与折算层。
 *
 * 为什么收进工具面（2026-09-07 定案）：此前 client 深度分析提示词让模型 shell
 * 自读 key + 裸 curl fuyao，实测反复翻车——env 文件是 `export KEY=V` 格式、
 * 模型 grep `^KEY=` 锚定不到；K 线毫秒时间戳换算错（09-07 同日已改走
 * astock_analyze）。更隐蔽的是口径陷阱：quarterly 返回的是**年初至今累计值**，
 * 模型直接当「近4季单季」读必错。取数与折算必须留在本地。
 *
 * 接口契约（官方文档 + 2026-09-07 实测固化，样本进 test/fundamentals.test.ts）：
 * - /api/a-share/valuations/snapshot?thscodes=XXX：
 *   data{timestamp(ms), item[]{thscode,name,pe_ttm,pb_mrq,...}}（与行情 enrich 同端点）。
 * - /api/a-share/financials/income-statements?thscode=XXX&period=quarterly&limit=9：
 *   data{item[]} 按 period_end_ms 降序；⚠️ 数值为「年初至今累计」——实测 FY2025
 *   annual 与 quarterly Q4 逐一相等、且 2025Q3 累计 > Q4（年报重述会回撤累计值，
 *   差分出负单季是真实存在的脏数据）。单季 = 同年相邻季度做差，Q1 即单季。
 *   金额单位元，null 可出现在任意字段。limit=9（两年）让最新 4 个单季的
 *   同比/环比都差分得到；上市不足两年时按可得数据降级。
 * - 两次请求串行发（fuyao token-bucket，突发并发会 429）。
 */

import { isLikelyFund, toThscode } from './links.ts'
import { normalizeSymbol } from './symbols.ts'
import { fetchFuyaoData } from './fuyao.ts'
import { formatShanghaiTime } from './quotes.ts'

/** 一个季度的营收/归母净利（元）。累计与单季共用此形，语义由函数名区分 */
export interface Quarter {
  year: number
  /** 1~4 */
  quarter: number
  periodEndMs: number
  /** 营业收入 */
  income?: number
  /** 归母净利润 */
  netProfit?: number
}

/** 财务接口单季条目（实测字段；金额可 null） */
interface IncomeItem {
  fiscal_year?: number | null
  fiscal_period?: string | null
  period_end_ms?: number | null
  operating_income?: number | null
  parent_holder_net_profit?: number | null
}

const num = (v: number | null | undefined): number | undefined =>
  v === null || v === undefined || !Number.isFinite(v) ? undefined : v

/** 解析 income-statements 响应为累计季度序列（period_end_ms 降序，非法条目跳过） */
export function parseIncomeStatements(data: unknown): Quarter[] {
  const items = (data as { item?: IncomeItem[] })?.item ?? []
  const out: Quarter[] = []
  for (const it of items) {
    const year = it?.fiscal_year
    const quarter = it?.fiscal_period !== undefined && it.fiscal_period !== null ? Number(/^Q([1-4])$/.exec(it.fiscal_period)?.[1]) : NaN
    if (year === undefined || year === null || !Number.isInteger(year)) continue
    if (!Number.isInteger(quarter)) continue
    if (it?.period_end_ms === undefined || it.period_end_ms === null) continue
    out.push({
      year,
      quarter,
      periodEndMs: it.period_end_ms,
      income: num(it.operating_income),
      netProfit: num(it.parent_holder_net_profit),
    })
  }
  out.sort((a, b) => b.periodEndMs - a.periodEndMs)
  return out
}

/**
 * 累计值 → 单季值：同年相邻季度做差，Q1 即单季。
 * 逐字段独立降级（上季累计缺失只废对应字段）；两条都算不出的季度整条丢弃。
 */
export function computeSingleQuarters(cums: Quarter[]): Quarter[] {
  const byKey = new Map(cums.map(q => [`${q.year}Q${q.quarter}`, q]))
  const out: Quarter[] = []
  for (const q of cums) {
    const prev = q.quarter > 1 ? byKey.get(`${q.year}Q${q.quarter - 1}`) : undefined
    const single: Quarter = { year: q.year, quarter: q.quarter, periodEndMs: q.periodEndMs }
    if (q.quarter === 1) {
      if (q.income !== undefined) single.income = q.income
      if (q.netProfit !== undefined) single.netProfit = q.netProfit
    } else if (prev !== undefined) {
      if (q.income !== undefined && prev.income !== undefined) single.income = q.income - prev.income
      if (q.netProfit !== undefined && prev.netProfit !== undefined) single.netProfit = q.netProfit - prev.netProfit
    }
    if (single.income !== undefined || single.netProfit !== undefined) out.push(single)
  }
  return out
}

export interface FundamentalsResult {
  symbol: string
  /** 估值快照给的名称（估值失败时为 ''） */
  name: string
  pe?: number
  pb?: number
  /** 估值快照时间（上海时区可读文本；无则为 ''） */
  valuationTime: string
  /** 单季序列（period_end_ms 降序） */
  quarters: Quarter[]
  fund: boolean
  valuationError: string | null
  financialsError: string | null
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface ValuationData {
  timestamp?: number | null
  item?: Array<Record<string, unknown>>
}

/**
 * 取一只股票的估值 + 财务单季。失败不抛（用户中止除外），逐项收敛成
 * xxxError 由渲染层标 ⚠️——与 buildAnalyzeText 同一降级纪律。
 */
export async function fetchFundamentals(
  rawSymbol: string,
  options?: { signal?: AbortSignal },
): Promise<FundamentalsResult> {
  const symbol = normalizeSymbol(rawSymbol)
  const result: FundamentalsResult = {
    symbol,
    name: '',
    valuationTime: '',
    quarters: [],
    fund: isLikelyFund(symbol),
    valuationError: null,
    financialsError: null,
  }
  if (result.fund) return result
  const aborted = (): boolean => options?.signal?.aborted === true

  try {
    const data = await fetchFuyaoData(
      '/api/a-share/valuations/snapshot',
      { thscodes: toThscode(symbol) },
      { signal: options?.signal },
    )
    const d = data as ValuationData
    if (d?.timestamp !== undefined && d.timestamp !== null) {
      result.valuationTime = formatShanghaiTime(d.timestamp)
    }
    const it = (d?.item ?? []).find(i => String(i['thscode'] ?? '') === toThscode(symbol))
    if (it !== undefined) {
      if (typeof it['name'] === 'string' && it['name'].trim() !== '') result.name = it['name'].trim()
      const pe = num(it['pe_ttm'] as number | null | undefined)
      const pb = num(it['pb_mrq'] as number | null | undefined)
      if (pe !== undefined) result.pe = pe
      if (pb !== undefined) result.pb = pb
    }
  } catch (e) {
    if (aborted()) throw e
    result.valuationError = errMsg(e)
  }

  try {
    const data = await fetchFuyaoData(
      '/api/a-share/financials/income-statements',
      { thscode: toThscode(symbol), period: 'quarterly', limit: 9 },
      { signal: options?.signal },
    )
    result.quarters = computeSingleQuarters(parseIncomeStatements(data))
  } catch (e) {
    if (aborted()) throw e
    result.financialsError = errMsg(e)
  }
  return result
}

// ---------- 渲染（纯函数，单测覆盖） ----------

const yi = (v: number | undefined): string => (v === undefined ? '—' : `${(v / 1e8).toFixed(1)}亿`)

/**
 * 增速文本：基数为正给百分比；基数为零/负时百分比无意义，改口径词
 * （扭亏为盈/亏损收窄/亏损扩大）——负单季是年报重述的真实产物（见头注）。
 */
function growthText(cur: number | undefined, prev: number | undefined): string {
  if (cur === undefined || prev === undefined) return '—'
  if (prev > 0) {
    const pct = (cur / prev - 1) * 100
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
  }
  if (cur > 0) return '扭亏为盈'
  if (prev < 0 && cur < 0) {
    if (cur > prev) return '亏损收窄'
    if (cur < prev) return '亏损扩大'
    return '持平'
  }
  return '—'
}

/** 单季文本：`2026Q2：营收 155.1亿（同比 +25.0%｜环比 +84.3%）；归母净利 …` */
function quarterLine(q: Quarter, byKey: Map<string, Quarter>): string {
  const yoy = byKey.get(`${q.year - 1}Q${q.quarter}`)
  const qoq = byKey.get(q.quarter > 1 ? `${q.year}Q${q.quarter - 1}` : `${q.year - 1}Q4`)
  const label = `${q.year}Q${q.quarter}`
  return (
    `  - ${label}：营收 ${yi(q.income)}（同比 ${growthText(q.income, yoy?.income)}｜环比 ${growthText(q.income, qoq?.income)}）；` +
    `归母净利 ${yi(q.netProfit)}（同比 ${growthText(q.netProfit, yoy?.netProfit)}｜环比 ${growthText(q.netProfit, qoq?.netProfit)}）`
  )
}

/** 渲染成给 AI 引用的确定性文本（数字全部算死，AI 只解读不重算） */
export function renderFundamentalsText(r: FundamentalsResult): string {
  const lines: string[] =
    r.fund
      ? [`## 基本面 · ${r.symbol}`]
      : [`## 基本面 · ${r.name === '' ? r.symbol : r.name}（${r.symbol}）`]
  if (r.fund) {
    lines.push('- 该代码按基金/ETF 处理：估值与财务接口仅覆盖股票，无基本面数据（行情请走 astock_quote）。')
    return lines.join('\n')
  }
  const pe = r.pe === undefined ? '—' : r.pe.toFixed(2)
  const pb = r.pb === undefined ? '—' : r.pb.toFixed(2)
  lines.push(`- 估值：PE(TTM) ${pe} / PB(MRQ) ${pb}${r.valuationTime === '' ? '' : `（fuyao ${r.valuationTime}）`}`)
  if (r.quarters.length > 0) {
    lines.push('- 单季营收与归母净利（fuyao 累计值已折算单季，本地确定性计算）：')
    const byKey = new Map(r.quarters.map(q => [`${q.year}Q${q.quarter}`, q]))
    for (const q of r.quarters.slice(0, 4)) lines.push(quarterLine(q, byKey))
  } else if (r.financialsError === null) {
    lines.push('- ⚠️ 财务：接口未返回任何季度数据')
  }
  if (r.valuationError !== null) lines.push(`- ⚠️ 估值不可用：${r.valuationError}`)
  if (r.financialsError !== null) lines.push(`- ⚠️ 财务不可用：${r.financialsError}`)
  return lines.join('\n')
}
