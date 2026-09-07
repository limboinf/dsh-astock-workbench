/**
 * 持仓管理 —— holdings.csv 的读写与合并。
 *
 * CSV 列：code,name,shares,cost,sector,note
 * - code：6 位数字或带 sh/sz/bj 前缀（读入时统一规范化为带前缀小写）
 * - shares：股数（A股一手=100股，这里存股数，必须是正整数）
 * - cost：每股成本（摊薄后）
 * - name/sector/note 可留空；name 缺失时展示层用行情名称兜底
 *
 * holdings.csv 是用户手写的记账数据：解析按「文档模型」保留原始行序——
 * 注释/空行/坏行原样带回，写回时逐字保留、只重渲染数据行；
 * 坏行或重复代码未清理前，上层记账必须拒绝写回（fail-closed），防止覆盖丢数据。
 */

import { normalizeSymbol } from './symbols.ts'

export interface Position {
  code: string
  name: string
  /** 持股数（股） */
  shares: number
  /** 每股成本 */
  cost: number
  sector: string
  note: string
}

/** 一行持仓数据（记账时原位更新、清仓时整行移除） */
interface RowLine {
  kind: 'row'
  position: Position
}

/** 原样保留的行：表头、# 注释、空行、无法解析的坏行（写回时逐字保留） */
interface RawLine {
  kind: 'raw'
  text: string
}

export type HoldingsLine = RowLine | RawLine

/** 解析后的持仓文件：行结构 + 派生的持仓列表 + 坏行警告 */
export interface HoldingsDoc {
  lines: HoldingsLine[]
  positions: Position[]
  warnings: string[]
}

export const HOLDINGS_HEADER = 'code,name,shares,cost,sector,note'

/**
 * 解析持仓 CSV 为文档模型。容忍空行、# 注释行、引号包裹字段；
 * 坏行作为 RawLine 原样保留并返回警告（不清除即触发上层 fail-closed）。
 */
export function parseHoldingsDoc(text: string): HoldingsDoc {
  const lines: HoldingsLine[] = []
  const positions: Position[] = []
  const warnings: string[] = []
  const seen = new Map<string, number>()
  const rows = text.split(/\r?\n/)
  for (let i = 0; i < rows.length; i++) {
    const rawText = rows[i]
    const line = rawText.trim()
    const keepRaw = () => lines.push({ kind: 'raw', text: rawText })
    if (line === '' || line.startsWith('#')) {
      keepRaw()
      continue
    }
    if (/^code\s*,/i.test(line)) {
      keepRaw() // 表头
      continue
    }
    const fields = splitCsvLine(line)
    if (fields.length < 4) {
      warnings.push(`第 ${i + 1} 行字段不足（至少 code,name,shares,cost），已跳过：${line}`)
      keepRaw()
      continue
    }
    let code: string
    try {
      code = normalizeSymbol(fields[0])
    } catch (e) {
      warnings.push(`第 ${i + 1} 行${e instanceof Error ? e.message : '代码不合法'}，已跳过`)
      keepRaw()
      continue
    }
    const shares = Number(fields[2])
    const cost = Number(fields[3])
    if (!Number.isInteger(shares) || shares <= 0) {
      warnings.push(`第 ${i + 1} 行股数不合法（需为正整数）：「${fields[2]}」，已跳过`)
      keepRaw()
      continue
    }
    if (!Number.isFinite(cost) || cost <= 0) {
      warnings.push(`第 ${i + 1} 行成本不合法：「${fields[3]}」，已跳过`)
      keepRaw()
      continue
    }
    const dupAt = seen.get(code)
    if (dupAt !== undefined) {
      warnings.push(`第 ${i + 1} 行代码 ${code} 与第 ${dupAt} 行重复，请先手动合并为一行，已跳过`)
      keepRaw()
      continue
    }
    seen.set(code, i + 1)
    const position: Position = {
      code,
      name: (fields[1] ?? '').trim(),
      shares,
      cost,
      sector: (fields[4] ?? '').trim(),
      note: (fields[5] ?? '').trim(),
    }
    positions.push(position)
    lines.push({ kind: 'row', position })
  }
  return { lines, positions, warnings }
}

/** 轻量视图：只要持仓与警告时用（文档模型的投影） */
export function parseHoldingsCsv(text: string): { positions: Position[]; warnings: string[] } {
  const doc = parseHoldingsDoc(text)
  return { positions: doc.positions, warnings: doc.warnings }
}

/** 单行 CSV 分割（支持双引号包裹、"" 转义） */
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

function positionRowText(p: Position): string {
  return [p.code, csvEscape(p.name), String(p.shares), String(p.cost), csvEscape(p.sector), csvEscape(p.note)].join(',')
}

/** 从零渲染一份持仓表（无注释行），解析 ⇄ 渲染往返一致 */
export function renderHoldingsCsv(positions: Position[]): string {
  return [HOLDINGS_HEADER, ...positions.map(positionRowText)].join('\n') + '\n'
}

/** 按原行序回写文档：注释/空行/坏行逐字保留，数据行按当前持仓重渲染 */
export function renderHoldingsDoc(doc: HoldingsDoc): string {
  const text = doc.lines.map(l => (l.kind === 'raw' ? l.text : positionRowText(l.position))).join('\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

export interface MergeInput {
  code: string
  shares: number
  cost: number
  name?: string
  sector?: string
  note?: string
}

/**
 * 新增/合并一条持仓：同代码则加权合并成本（数量、成本摊薄），
 * 新代码则追加。name/sector/note 仅在新增时生效。
 */
export function mergePosition(
  positions: Position[],
  input: MergeInput,
): { positions: Position[]; merged: Position } {
  if (!Number.isInteger(input.shares) || input.shares <= 0) throw new Error('股数必须是正整数')
  if (!Number.isFinite(input.cost) || input.cost <= 0) throw new Error('成本必须是正数')
  const code = normalizeSymbol(input.code)
  const existing = positions.find(p => p.code === code)
  if (!existing) {
    const merged: Position = {
      code,
      name: input.name?.trim() ?? '',
      shares: input.shares,
      cost: input.cost,
      sector: input.sector?.trim() ?? '',
      note: input.note?.trim() ?? '',
    }
    return { positions: [...positions, merged], merged }
  }
  const totalShares = existing.shares + input.shares
  const avgCost = (existing.shares * existing.cost + input.shares * input.cost) / totalShares
  const merged: Position = {
    ...existing,
    shares: totalShares,
    cost: Math.round(avgCost * 1000) / 1000,
  }
  return { positions: positions.map(p => (p.code === code ? merged : p)), merged }
}

/**
 * 文档级记账：同代码的数据行原位更新（加权成本），新代码追加到文件末尾；
 * 注释等原样行不受影响。调用前须确认 doc.warnings 为空（fail-closed）。
 */
export function mergePositionInDoc(doc: HoldingsDoc, input: MergeInput): { doc: HoldingsDoc; merged: Position } {
  const { positions, merged } = mergePosition(doc.positions, input)
  const lines = [...doc.lines]
  const idx = lines.findIndex(l => l.kind === 'row' && l.position.code === merged.code)
  if (idx >= 0) lines[idx] = { kind: 'row', position: merged }
  else lines.push({ kind: 'row', position: merged })
  return { doc: { lines, positions, warnings: doc.warnings }, merged }
}

export function removePosition(positions: Position[], code: string): { positions: Position[]; removed?: Position } {
  const target = normalizeSymbol(code)
  const removed = positions.find(p => p.code === target)
  return { positions: positions.filter(p => p.code !== target), removed }
}

export interface SetPositionInput {
  code: string
  shares: number
  cost: number
  name?: string
}

/**
 * 文档级覆盖写（对账用）：同代码的数据行原位覆盖股数/成本——券商数字是事实，
 * 不做加权合并；name 传入非空时一并更新（本地名缺漏时从截图补全）。
 * 新代码追加到文件末尾；注释等原样行不受影响。
 * 与 mergePositionInDoc 的区别：合并面向「又买了一笔」，覆盖面向「以外部口径对账」。
 * 调用前须确认 doc.warnings 为空（fail-closed）。
 */
export function setPositionInDoc(doc: HoldingsDoc, input: SetPositionInput): { doc: HoldingsDoc; position: Position } {
  if (!Number.isInteger(input.shares) || input.shares <= 0) throw new Error('股数必须是正整数')
  if (!Number.isFinite(input.cost) || input.cost <= 0) throw new Error('成本必须是正数')
  const code = normalizeSymbol(input.code)
  const existing = doc.positions.find(p => p.code === code)
  const position: Position = existing
    ? {
        ...existing,
        shares: input.shares,
        cost: input.cost,
        ...(input.name !== undefined && input.name.trim() !== '' ? { name: input.name.trim() } : {}),
      }
    : {
        code,
        name: input.name?.trim() ?? '',
        shares: input.shares,
        cost: input.cost,
        sector: '',
        note: '',
      }
  const positions = existing
    ? doc.positions.map(p => (p.code === code ? position : p))
    : [...doc.positions, position]
  const lines = [...doc.lines]
  const idx = lines.findIndex(l => l.kind === 'row' && l.position.code === code)
  if (idx >= 0) lines[idx] = { kind: 'row', position }
  else lines.push({ kind: 'row', position })
  return { doc: { lines, positions, warnings: doc.warnings }, position }
}

/** 文档级清仓：整行移除该数据行，注释等原样行不受影响 */
export function removePositionInDoc(doc: HoldingsDoc, code: string): { doc: HoldingsDoc; removed?: Position } {
  const { positions, removed } = removePosition(doc.positions, code)
  if (!removed) return { doc, removed }
  const lines = doc.lines.filter(l => !(l.kind === 'row' && l.position.code === removed.code))
  return { doc: { lines, positions, warnings: doc.warnings }, removed }
}

/** 新账户模板 */
export function holdingsTemplate(): string {
  return [
    '# A股持仓表 —— dsh-astock-workbench',
    '# 列：code,name,shares,cost,sector,note',
    '# code 用 6 位数字（自动识别沪深北）或带前缀；shares 是股数；cost 是每股摊薄成本',
    '# 以 # 开头的行和空行会被忽略；也可以直接让 AI 用 astock_add_position 工具帮你记账',
    HOLDINGS_HEADER,
    '# 示例（删掉行首 # 生效）：',
    '# 600519,贵州茅台,100,1700,白酒,长期',
    '# 300750,宁德时代,200,260,电池,波段',
    '',
  ].join('\n')
}
