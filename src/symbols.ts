/**
 * 股票代码规范化 —— 全仓库唯一实现（持仓表、行情查询共用同一套规则）。
 * 规则：已带 sh/sz/bj 前缀的原样小写返回；纯 6 位数字按首位补前缀：
 * 6/5/9→sh，0/3/1/2→sz，4/8→bj（北交所）。
 * 已知限制：沪市可转债 11xxxx 首位是 1，会被归到 sz（MVP 只支持股票代码）。
 */
export function normalizeSymbol(input: string): string {
  const raw = input.trim().toLowerCase()
  if (/^(sh|sz|bj)\d{5,6}$/.test(raw)) return raw
  if (/^\d{6}$/.test(raw)) {
    const head = raw[0]
    if (head === '6' || head === '5' || head === '9') return `sh${raw}`
    if (head === '4' || head === '8') return `bj${raw}`
    return `sz${raw}`
  }
  throw new Error(`无法识别的股票代码：「${input}」，请用 6 位数字（如 600519）或带前缀（如 sh600519）`)
}
