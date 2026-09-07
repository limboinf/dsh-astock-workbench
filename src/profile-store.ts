/**
 * 投资者画像的落盘层 —— profile.json（与 balance.json 同目录）。
 * 契约与渲染在 profile.ts（纯模块，双端共享）；本文件带 fs，只给 host 用。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeProfile, type InvestorProfile } from './profile.ts'

function profileFile(dir: string): string {
  return join(dir, 'profile.json')
}

/**
 * 读取画像；文件不存在返回 null（面板按「未设置」展示默认档）。
 * 文件损坏时不抛错也不返回 null，而是走 normalizeProfile 退回默认值——
 * 画像坏掉不该让分析功能跟着挂。
 */
export function readProfile(dir: string): InvestorProfile | null {
  const file = profileFile(dir)
  if (!existsSync(file)) return null
  try {
    return normalizeProfile(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return normalizeProfile(null)
  }
}

/** 整文件覆盖写；返回落盘后的规范化结果（调用方拿它回显，不要自己拼） */
export function writeProfile(dir: string, input: unknown, updatedAt: string): InvestorProfile {
  const profile = normalizeProfile(input, updatedAt)
  writeFileSync(profileFile(dir), `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  return profile
}
