/**
 * 卖出流水 —— trades.csv 的读写与已实现盈亏统计。
 *
 * 为什么需要这份文件：holdings.csv 是「快照表」，清仓/减仓后那部分持仓就从表里
 * 消失了，真实落袋的盈亏没有任何地方可查——面板只剩「幸存者」的浮动盈亏。
 * 本文件只记「卖掉的部分」（买入仍走 holdings 的加权成本，不在此重复记账），
 * 让「累计已实现盈亏 / 笔数 / 胜率」成为与浮动盈亏并列的确定性数字。
 *
 * CSV 列：date,code,name,action,shares,price,cost,pnl,note
 * - action：sell（卖出，含清仓与减仓，进统计）｜ buy（手动补录历史买入用，不进统计）
 * - price/cost/pnl 可留空：自动补记时缺行情 → price 空 → pnl 空 → 统计计入 skipped，
 *   事后手工补齐价格/成本即可（文档模型，直接编辑文件）
 *
 * 自动补记的口径（note 会标注来源，两处都可能与真实成交有出入，可手工修正）：
 * - 卖出价 = 对账/清仓记账当时的行为快照价，不是真实成交价；
 * - 成本 = 本地当时的每股摊薄成本（holdings.csv），不是券商截图的成本口径。
 * pnl 以文件里存的数字为准（不重算）：手工修正 pnl（比如计入手续费）会被尊重。
 *
 * 文档模型与 holdings.csv 同款：注释/空行/坏行原样保留、写回时逐字保留；
 * 坏行未清理前，写入工具拒绝写回（fail-closed 防覆盖丢数据）。
 */

import { normalizeSymbol } from './symbols.ts'
import type { RealizedStats } from './dto.ts'

export type TradeAction = 'sell' | 'buy'

export interface TradeRecord {
  /** 交易日 YYYY-MM-DD */
  date: string
  code: string
  name: string
  action: TradeAction
  /** 股/份 数（卖出记录里是卖出的数量，不是剩余持仓） */
  shares: number
  /** 每股卖出（买入）价；缺为 null */
  price: number | null
  /** 每股成本（本地口径）；缺为 null */
  cost: number | null
  /** 已实现盈亏 = (price − cost) × shares；不可计为 null */
  pnl: number | null
  note: string
}

/** 一行流水数据（只追加，不原地更新——流水是审计轨迹） */
interface RowLine {
  kind: 'row'
  record: TradeRecord
}

/** 原样保留的行：表头、# 注释、空行、坏行 */
interface RawLine {
  kind: 'raw'
  text: string
}

export type TradesLine = RowLine | RawLine

export interface TradesDoc {
  lines: TradesLine[]
  records: TradeRecord[]
  warnings: string[]
}

export const TRADES_HEADER = 'date,code,name,action,shares,price,cost,pnl,note'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 解析流水 CSV 为文档模型。规则同 holdings.ts：容忍空行与 # 注释行，
 * 坏行原样保留并返回警告（上层写入 fail-closed）。
 */
export function parseTradesDoc(text: string): TradesDoc {
  const lines: TradesLine[] = []
  const records: TradeRecord[] = []
  const warnings: string[] = []
  const rows = text.split(/\r?\n/)
  for (let i = 0; i < rows.length; i++) {
    const rawText = rows[i]
    const line = rawText.trim()
    const keepRaw = () => lines.push({ kind: 'raw', text: rawText })
    if (line === '' || line.startsWith('#')) {
      keepRaw()
      continue
    }
    if (/^date\s*,/i.test(line)) {
      keepRaw() // 表头
      continue
    }
    const fields = splitCsvLine(line)
    const bad = (msg: string) => {
      warnings.push(`第 ${i + 1} 行${msg}，已跳过：${line}`)
      keepRaw()
    }
    if (fields.length < 5) {
      bad('字段不足（至少 date,code,name,action,shares）')
      continue
    }
    if (!DATE_RE.test(fields[0].trim())) {
      bad('日期不合法（需 YYYY-MM-DD）')
      continue
    }
    let code: string
    try {
      code = normalizeSymbol(fields[1])
    } catch (e) {
      bad(e instanceof Error ? ` ${e.message}` : '代码不合法')
      continue
    }
    const action = fields[3].trim().toLowerCase()
    if (action !== 'sell' && action !== 'buy') {
      bad('action 不合法（需 sell 或 buy）')
      continue
    }
    const shares = Number(fields[4])
    if (!Number.isInteger(shares) || shares <= 0) {
      bad('股数不合法（需为正整数）')
      continue
    }
    const optNum = (raw: string): number | null => {
      const v = raw.trim()
      if (v === '') return null
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : NaN // NaN 触发下方坏行
    }
    const price = optNum(fields[5])
    const cost = optNum(fields[6])
    // pnl 可为负/零，单独解析：空为 null，非数字才坏行
    const pnlRaw = (fields[7] ?? '').trim()
    let pnl: number | null = null
    if (pnlRaw !== '') {
      const n = Number(pnlRaw)
      if (!Number.isFinite(n)) {
        bad('盈亏不合法（需数字或留空）')
        continue
      }
      pnl = n
    }
    if (Number.isNaN(price) || Number.isNaN(cost)) {
      bad('价格/成本不合法（需正数或留空）')
      continue
    }
    const record: TradeRecord = {
      date: fields[0].trim(),
      code,
      name: (fields[2] ?? '').trim(),
      action,
      shares,
      price,
      cost,
      pnl,
      note: (fields[8] ?? '').trim(),
    }
    records.push(record)
    lines.push({ kind: 'row', record })
  }
  return { lines, records, warnings }
}

/** 单行 CSV 分割（支持双引号包裹、"" 转义；与 holdings.ts 同款） */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function csvEscape(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function numOrEmpty(n: number | null): string {
  return n === null ? '' : String(n)
}

function tradeRowText(r: TradeRecord): string {
  return [
    r.date,
    r.code,
    csvEscape(r.name),
    r.action,
    String(r.shares),
    numOrEmpty(r.price),
    numOrEmpty(r.cost),
    numOrEmpty(r.pnl),
    csvEscape(r.note),
  ].join(',')
}

/** 按原行序回写文档：注释/空行/坏行逐字保留，数据行按当前记录重渲染 */
export function renderTradesDoc(doc: TradesDoc): string {
  const text = doc.lines.map(l => (l.kind === 'raw' ? l.text : tradeRowText(l.record))).join('\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

/** 追加一条流水到文档末尾（只追加不改既有行——流水是审计轨迹） */
export function appendTradeRecord(doc: TradesDoc, record: TradeRecord): TradesDoc {
  return {
    lines: [...doc.lines, { kind: 'row', record }],
    records: [...doc.records, record],
    warnings: doc.warnings,
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export interface SellInput {
  date: string
  code: string
  name?: string
  shares: number
  /** 卖出价；缺行情/未提供为 null（pnl 随之为 null，进统计的 skipped） */
  price: number | null
  /** 每股成本；缺为 null */
  cost: number | null
  note?: string
}

/** 构造一条卖出记录：价格与成本齐备时确定性算出已实现盈亏 */
export function makeSellRecord(input: SellInput): TradeRecord {
  if (!Number.isInteger(input.shares) || input.shares <= 0) throw new Error('股数必须是正整数')
  const positiveOrNull = (n: number | null): number | null => {
    if (n === null) return null
    if (!Number.isFinite(n) || n <= 0) throw new Error('价格/成本必须是正数')
    return n
  }
  const price = positiveOrNull(input.price)
  const cost = positiveOrNull(input.cost)
  return {
    date: input.date,
    code: normalizeSymbol(input.code),
    name: input.name?.trim() ?? '',
    action: 'sell',
    shares: input.shares,
    price,
    cost,
    pnl: price !== null && cost !== null ? round2((price - cost) * input.shares) : null,
    note: input.note?.trim() ?? '',
  }
}

/**
 * 已实现盈亏统计：只数 action=sell 的记录；pnl 非空的计入合计与胜率，
 * 为空的（缺卖出价/成本）计入 skipped——补齐文件后自动计入，不丢账。
 */
export function summarizeTrades(records: TradeRecord[]): RealizedStats {
  const sells = records.filter(r => r.action === 'sell')
  const counted = sells.filter(r => r.pnl !== null)
  const pnl = counted.length > 0 ? round2(counted.reduce((acc, r) => acc + r.pnl!, 0)) : null
  const wins = counted.filter(r => r.pnl! > 0).length
  return {
    pnl,
    trades: counted.length,
    wins,
    winRate: counted.length > 0 ? (wins / counted.length) * 100 : null,
    skipped: sells.length - counted.length,
  }
}

/** 流水列表文本（astock_trades 工具输出）：表 + 统计，按文件顺序（即时间序） */
export function renderTradesList(records: TradeRecord[], stats: RealizedStats): string {
  if (records.length === 0) {
    return [
      '## 交易流水',
      '',
      '暂无流水记录。清仓/减仓对账与清仓记账时会自动补记卖出流水；也可以用 astock_record_trade 补录历史交易。',
    ].join('\n')
  }
  const fmt = (n: number | null, digits = 2): string =>
    n === null ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  const fmtSigned = (n: number | null): string =>
    n === null ? '—' : `${n > 0 ? '+' : ''}${fmt(n)}`
  const lines = [
    '## 交易流水',
    '',
    '| 日期 | 代码 | 名称 | 动作 | 股数 | 价格 | 成本 | 已实现盈亏 | 备注 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...records.map(r =>
      `| ${r.date} | ${r.code} | ${r.name || '—'} | ${r.action === 'sell' ? '卖出' : '买入'} | ${r.shares} | ${fmt(r.price)} | ${fmt(r.cost)} | ${fmtSigned(r.pnl)} | ${r.note || '—'} |`,
    ),
    '',
    `- 累计已实现盈亏：${fmtSigned(stats.pnl)} 元（卖出 ${stats.trades} 笔，胜率 ${stats.winRate === null ? '—' : `${stats.winRate.toFixed(1)}%`}）`,
  ]
  if (stats.skipped > 0) {
    lines.push(`- ⚠️ 另有 ${stats.skipped} 笔卖出缺卖出价/成本，未计入上表统计（可在 trades.csv 补齐后自动计入）`)
  }
  return lines.join('\n')
}

/** 新账本模板 */
export function tradesTemplate(): string {
  return [
    '# 卖出流水 —— dsh-astock-workbench',
    '# 列：date,code,name,action,shares,price,cost,pnl,note',
    '# action：sell 卖出（进已实现盈亏统计）/ buy 买入（手动补录历史用，不进统计）',
    '# 清仓/减仓对账（astock_reconcile）与清仓记账（astock_remove_position）会自动追加卖出记录：',
    '# 卖出价是当时行情快照、成本是本地摊薄口径，均可手工修正（改 price/cost 时按 (价格−成本)×股数 同步改 pnl）',
    `# 以 # 开头的行和空行会被忽略；${TRADES_HEADER.split(',').length} 列中 price/cost/pnl 可留空`,
    TRADES_HEADER,
    '',
  ].join('\n')
}

/**
 * 当日成交按标的聚合 —— 当日盈亏改用现金流量法的输入（消费方见 format.ts summarize）。
 *
 * 为什么需要它：券商的「当日参考盈亏」对当日新买入的股份以成交价起算，对当日卖掉
 * 的股份仍把当天赚到的钱计在内。只按 Σ(现价−昨收)×现股数 算会错两处——加仓那部分
 * 被从昨收起算（凭空多担/多吃一段涨跌），当日清仓的标的整只从持仓表消失、当天的
 * 盈亏直接蒸发。2026-09-07 实测两处合计差 1,490 元。
 *
 * 缺 price 的记录进不了现金流（算不出金额），单独计 skipped 交上层出提示：
 * 静默按 0 处理会让当日盈亏错得毫无痕迹，比不算更糟。
 */
export interface DayTurnover {
  code: string
  /** 展示名（取当日首条记录的 name，可能为空） */
  name: string
  /** 当日买入股数（只累计有成交价的记录） */
  buyShares: number
  /** 当日买入支出 = Σ price×shares */
  buyAmount: number
  sellShares: number
  sellAmount: number
  /** 当日有成交但缺 price、未计入现金流的笔数 */
  skipped: number
}

/** 按标的聚合指定交易日的成交流水；当日无成交时返回空 Map */
export function collectDayTurnover(records: TradeRecord[], date: string): Map<string, DayTurnover> {
  const out = new Map<string, DayTurnover>()
  for (const r of records) {
    if (r.date !== date) continue
    let t = out.get(r.code)
    if (t === undefined) {
      t = { code: r.code, name: r.name, buyShares: 0, buyAmount: 0, sellShares: 0, sellAmount: 0, skipped: 0 }
      out.set(r.code, t)
    }
    if (t.name === '') t.name = r.name
    if (r.price === null) {
      t.skipped++
      continue
    }
    if (r.action === 'buy') {
      t.buyShares += r.shares
      t.buyAmount += r.price * r.shares
    } else {
      t.sellShares += r.shares
      t.sellAmount += r.price * r.shares
    }
  }
  return out
}
