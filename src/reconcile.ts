/**
 * 持仓对账 —— 把外部输入（券商 App 截图经模型读出的行，或手工整理的文本）
 * 与本地 holdings.csv 做差异对比与覆盖式同步。
 *
 * 两段式（fail-closed）：
 * 1) 预览：本地校验 + diff，返回差异清单与 token（token = 行集摘要 + 当前持仓文件摘要）；
 * 2) 写入：带同一 token 再调；token 不匹配（行集变了 / 持仓表在两步之间被改过）
 *    即拒绝写入，要求重新对账——防止把「用户看过的差异」写到「已变化的文件」上。
 *
 * 纪律：模型只当「眼睛」（从截图抄数字、原样传递），校验、diff、写入全部本地确定性完成；
 * 截图里没有的持仓默认不删（removeMissing 显式开启才清仓），防止「截了半屏」误清仓。
 */

import { createHash } from 'node:crypto'
import {
  removePositionInDoc,
  setPositionInDoc,
  type HoldingsDoc,
  type Position,
} from './holdings.ts'
import { normalizeSymbol } from './symbols.ts'

/** 外部输入的一行（字段由模型从截图/文本原样抄录，未校验） */
export interface ReconcileInputRow {
  code: string
  shares: number
  cost: number
  name?: string
}

/** 校验通过的行（code 已规范化、数字已过校验） */
export interface ReconcileRow {
  code: string
  name: string
  shares: number
  cost: number
}

export function validateReconcileRows(rows: unknown): { valid: ReconcileRow[]; errors: string[] } {
  const valid: ReconcileRow[] = []
  const errors: string[] = []
  if (!Array.isArray(rows)) return { valid, errors: ['rows 必须是数组'] }
  const seen = new Set<string>()
  rows.forEach((raw, i) => {
    const label = `第 ${i + 1} 行`
    if (raw === null || typeof raw !== 'object') {
      errors.push(`${label} 不是对象`)
      return
    }
    const r = raw as Record<string, unknown>
    let code: string
    try {
      code = normalizeSymbol(String(r.code ?? ''))
    } catch (e) {
      errors.push(`${label}代码不合法：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const shares = Number(r.shares)
    if (!Number.isInteger(shares) || shares <= 0) {
      errors.push(`${label} ${code} 股数不合法（需为正整数）：${String(r.shares)}`)
      return
    }
    const cost = Number(r.cost)
    if (!Number.isFinite(cost) || cost <= 0) {
      errors.push(`${label} ${code} 成本不合法（需为正数）：${String(r.cost)}`)
      return
    }
    if (seen.has(code)) {
      errors.push(`${label} ${code} 与前面的行重复，已跳过（请先合并为一行）`)
      return
    }
    seen.add(code)
    valid.push({ code, name: typeof r.name === 'string' ? r.name.trim() : '', shares, cost })
  })
  return { valid, errors }
}

export interface ReconcileDiff {
  /** 本地没有、外部新增 */
  added: ReconcileRow[]
  /** 股数或成本与本地不同（old 供展示旧值） */
  updated: Array<{ row: ReconcileRow; local: Position }>
  /** 与本地一致 */
  unchanged: ReconcileRow[]
  /** 本地有、外部没有（默认保留，removeMissing 时才清仓） */
  missing: Position[]
}

/** 成本按 4 位小数归一后比较（ETF 三位小数价、外部文本的小数尾差不算差异） */
function sameCost(a: number, b: number): boolean {
  return Math.round(a * 10000) === Math.round(b * 10000)
}

export function diffReconcile(valid: ReconcileRow[], positions: Position[]): ReconcileDiff {
  const localByCode = new Map(positions.map(p => [p.code, p]))
  const externalCodes = new Set(valid.map(r => r.code))
  const diff: ReconcileDiff = { added: [], updated: [], unchanged: [], missing: [] }
  for (const row of valid) {
    const local = localByCode.get(row.code)
    if (local === undefined) {
      diff.added.push(row)
    } else if (local.shares !== row.shares || !sameCost(local.cost, row.cost)) {
      diff.updated.push({ row, local })
    } else {
      diff.unchanged.push(row)
    }
  }
  for (const p of positions) {
    if (!externalCodes.has(p.code)) diff.missing.push(p)
  }
  return diff
}

/** 行集与持仓文件绑定的一次性凭证：任一变化即失效，写入前必须原样匹配 */
export function reconcileToken(valid: ReconcileRow[], holdingsText: string): string {
  const rowsPart = valid.map(r => `${r.code}|${r.shares}|${r.cost.toFixed(4)}|${r.name}`).join(';')
  return createHash('sha256').update(`${rowsPart}\n@@\n${holdingsText}`).digest('hex').slice(0, 16)
}

/**
 * 按 diff 覆盖写入：新增/更新逐行 setPosition，missing 仅在 removeMissing 时清仓
 */
export function applyReconcile(
  doc: HoldingsDoc,
  diff: ReconcileDiff,
  removeMissing: boolean,
): { doc: HoldingsDoc; removed: Position[] } {
  let next = doc
  for (const row of [...diff.added, ...diff.updated.map(u => u.row)]) {
    next = setPositionInDoc(next, row).doc
  }
  const removed: Position[] = []
  if (removeMissing) {
    for (const p of diff.missing) {
      const res = removePositionInDoc(next, p.code)
      next = res.doc
      if (res.removed !== undefined) removed.push(res.removed)
    }
  }
  return { doc: next, removed }
}

/** diff 里能确定「卖掉了」的事件（清仓/减仓）；卖出价由上层补行情 */
export interface SellEvent {
  code: string
  name: string
  shares: number
  /** 本地当时的每股摊薄成本（不是券商截图的成本口径） */
  cost: number
  reason: '清仓' | '减仓'
}

/**
 * 提取卖出事件：removeMissing 时 missing 即清仓；updated 里股数变少即减仓
 * （股数变多/不变不产生事件——买入仍走 holdings 的加权成本，不在流水里重复记账）。
 * 返回的是「事件」而非成品记录：价格取当时行情快照，由调用方补齐后写 trades.csv。
 */
export function collectSellEvents(diff: ReconcileDiff, removeMissing: boolean): SellEvent[] {
  const events: SellEvent[] = []
  if (removeMissing) {
    for (const p of diff.missing) {
      events.push({ code: p.code, name: p.name, shares: p.shares, cost: p.cost, reason: '清仓' })
    }
  }
  for (const { row, local } of diff.updated) {
    if (local.shares > row.shares) {
      events.push({
        code: local.code,
        name: row.name || local.name,
        shares: local.shares - row.shares,
        cost: local.cost,
        reason: '减仓',
      })
    }
  }
  return events
}

/** 预览文本：差异表 + 统计 + 确认指引（token 由调用方传回） */
export function renderReconcilePreview(diff: ReconcileDiff, token: string): string {
  const lines: string[] = []
  lines.push('## 持仓对账（预览）')
  lines.push('')
  lines.push('与本地持仓表对比（写入时以你提供的券商数据覆盖股数/成本）：')
  lines.push('')
  lines.push('| 代码 | 名称 | 对比 | 股数 | 成本 |')
  lines.push('|---|---|---|---|---|')
  for (const r of diff.added) {
    lines.push(`| ${r.code} | ${r.name || '—'} | 🆕 新增 | ${r.shares} | ${r.cost} |`)
  }
  for (const { row, local } of diff.updated) {
    lines.push(`| ${row.code} | ${row.name || local.name || '—'} | ✏️ 更新 | ${local.shares} → ${row.shares} | ${local.cost} → ${row.cost} |`)
  }
  for (const r of diff.unchanged) {
    lines.push(`| ${r.code} | ${r.name || '—'} | ✓ 一致 | ${r.shares} | ${r.cost} |`)
  }
  for (const p of diff.missing) {
    lines.push(`| ${p.code} | ${p.name || '—'} | ⚠️ 截图未出现 | ${p.shares} | ${p.cost} |`)
  }
  lines.push('')
  lines.push(
    `- 新增 ${diff.added.length}、更新 ${diff.updated.length}、一致 ${diff.unchanged.length}、截图未出现 ${diff.missing.length}`,
  )
  if (diff.missing.length > 0) {
    lines.push('- ⚠️ 截图未出现的持仓默认保留（可能是截图不全）；如确认已清仓，回复时说明「没有的是清仓」，写入时会一并移除')
  }
  // 预先告知会动第二个文件（trades.csv）：写入范围必须让用户在确认前就知道
  if (diff.missing.length > 0 || diff.updated.some(u => u.local.shares > u.row.shares)) {
    lines.push('- 📒 写入时会自动为清仓/减仓的持仓在卖出流水（trades.csv）补记一笔：卖出价按当时行情、成本按本地记录，事后可修正')
  }
  lines.push(`- 确认无误请回复「确认」，我带对账 token 写入：\`${token}\``)
  return lines.join('\n')
}

/** 写入结果文本；recordedSells 为本次自动补记的卖出流水（可为空） */
export function renderReconcileApplied(
  diff: ReconcileDiff,
  removed: Position[],
  file: string,
  recordedSells: Array<{ code: string; name: string; shares: number; reason: string; price: number | null; pnl: number | null }> = [],
): string {
  const lines: string[] = []
  lines.push('## 持仓对账（已写入）')
  lines.push('')
  for (const r of diff.added) {
    lines.push(`- 新增：${r.code} ${r.name || ''} ${r.shares} 股 @ ${r.cost}`)
  }
  for (const { row, local } of diff.updated) {
    lines.push(`- 更新：${row.code} ${row.name || local.name || ''} → ${row.shares} 股 @ ${row.cost}（原 ${local.shares} 股 @ ${local.cost}）`)
  }
  for (const p of removed) {
    lines.push(`- 清仓移除：${p.code} ${p.name || ''}（原 ${p.shares} 股 @ ${p.cost}）`)
  }
  for (const s of recordedSells) {
    const pnl = s.pnl === null ? '盈亏待补（未取到行情价）' : `已实现 ${s.pnl > 0 ? '+' : ''}${s.pnl.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元`
    const price = s.price === null ? '—' : String(s.price)
    lines.push(`- 📒 卖出流水已补记：${s.code} ${s.name || ''} ${s.reason} ${s.shares} 股 @ 行情 ${price}（${pnl}）`)
  }
  lines.push(`- 持仓表已更新：${file}`)
  return lines.join('\n')
}
