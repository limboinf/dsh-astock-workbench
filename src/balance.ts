/**
 * 手动资产口径 —— balance.json。
 * 两种互斥口径，整文件重写、后录入的覆盖先录入的：
 * - 现金口径 { cash }：总资产 = 持仓市值 + 现金，随行情实时变动（贴合长期使用）；
 * - 快照口径 { totalAssets }：用户录入的券商口径「总资产」（含现金与其他资产），
 *   是静态数字，行情波动不改变它，直到再次录入。
 * 金额由工具确定性写入/读取——这是账本数据，必须可对账、可复现。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Balance {
  /** 快照口径：券商总资产（含现金与其他资产）。与 cash 互斥，cash 优先。 */
  totalAssets?: number
  /** 现金口径：券商现金余额；设置后总资产 = 持仓市值 + cash，随行情变动 */
  cash?: number
  updatedAt: string
  note?: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function validateBalanceDate(value: string): string {
  const date = value.trim()
  if (!DATE_RE.test(date)) throw new Error('日期必须是 YYYY-MM-DD 格式')
  return date
}

/** 读取资产口径；文件不存在或损坏返回 null（不抛错，工作台降级为持仓口径） */
export function readBalance(dir: string): Balance | null {
  const file = join(dir, 'balance.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (typeof parsed.updatedAt !== 'string') return null
    const balance: Balance = { updatedAt: parsed.updatedAt }
    if (typeof parsed.note === 'string' && parsed.note !== '') balance.note = parsed.note
    // 两口径互斥；文件被手改出现两者时以 cash（自动口径）优先
    if (typeof parsed.cash === 'number' && Number.isFinite(parsed.cash) && parsed.cash >= 0) {
      balance.cash = parsed.cash
    } else if (typeof parsed.totalAssets === 'number' && Number.isFinite(parsed.totalAssets)) {
      balance.totalAssets = parsed.totalAssets
    } else {
      return null
    }
    return balance
  } catch {
    return null
  }
}

/** 写入快照口径（整文件重写，同时清除现金口径——互斥，后写覆盖） */
export function writeBalance(dir: string, totalAssets: number, updatedAt: string, note?: string): string {
  const file = join(dir, 'balance.json')
  const payload: Record<string, unknown> = { totalAssets, updatedAt }
  if (note !== undefined && note !== '') payload.note = note
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return file
}

/** 写入现金口径（整文件重写，同时清除快照口径——互斥，后写覆盖） */
export function writeCashBalance(dir: string, cash: number, updatedAt: string, note?: string): string {
  const file = join(dir, 'balance.json')
  const payload: Record<string, unknown> = { cash, updatedAt }
  if (note !== undefined && note !== '') payload.note = note
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return file
}
