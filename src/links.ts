/**
 * 外部行情/F10 链接与基金识别 —— 展示层与 AI 上下文注入共用的纯函数。
 * 与 src/symbols.ts 的 normalizeSymbol 保持单一来源：前缀推断不在此处复制规则。
 */

import { normalizeSymbol } from './symbols.ts'

/** 去掉 sh/sz/bj 前缀，得到 6 位裸代码（同花顺 F10 等第三方站点用裸代码） */
export function stripPrefix(code: string): string {
  return code.trim().toLowerCase().replace(/^(sh|sz|bj)/, '')
}

/** 东方财富行情页：需要带 sh/sz/bj 前缀（如 sz002128）；裸 6 位代码自动补前缀 */
export function marketUrl(code: string): string {
  return `https://quote.eastmoney.com/${normalizeSymbol(code)}.html`
}

/** 同花顺 F10 公司资料页：用 6 位裸代码（如 002128） */
export function f10Url(code: string): string {
  return `https://basic.10jqka.com.cn/${stripPrefix(code)}/`
}

/** 规范化 symbol（sh600519）→ fuyao thscode（600519.SH）；client/host 两半共用，勿复制规则 */
export function toThscode(code: string): string {
  const s = normalizeSymbol(code)
  const suffix = s.startsWith('sh') ? 'SH' : s.startsWith('sz') ? 'SZ' : 'BJ'
  return `${s.slice(2)}.${suffix}`
}

/**
 * 无资产类型字段时的保守基金识别（README 已知限制）：
 * 5/15/16/18 开头的 6 位代码通常为基金/ETF/LOF。
 * 注意必须按 6 位匹配：5 开头是「5 + 5 位」（510880/560860/513850…），
 * 15/16/18 开头是「前缀 + 4 位」（159883/16xxxx/18xxxx…）。
 */
export function isLikelyFund(code: string): boolean {
  const raw = stripPrefix(code)
  return /^(?:5\d{5}|15\d{4}|16\d{4}|18\d{4})$/.test(raw)
}
