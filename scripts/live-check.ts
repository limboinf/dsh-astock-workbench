/**
 * 联网自检：真实拉取「沪市股票 + 深市股票 + 沪市 ETF + 深市 ETF」四类标的，
 * 验证 fuyao 主源路由、缺口兜底（腾讯）与字段解析全链路。
 * 用法：npm run live-check
 */
import { fetchQuotes } from '../src/quotes.ts'

// 深市两项正是 fuyao 当前缺口：应自动落到 tencent 兜底（看 source 列）
const quotes = await fetchQuotes(['sh600519', 'sz300750', 'sh510880', 'sz159883'], { enrich: true })
if (quotes.size === 0) {
  console.error('未取到任何行情，请检查网络与 FUYAO_API_KEY 配置')
  process.exit(1)
}
for (const [k, v] of quotes) {
  console.log(
    `${k} [${v.source ?? '?'}] ${v.name || '(无名)'} 现价=${v.price} 涨跌=${v.change}（${v.changePct}%）` +
      ` 量=${v.volume}手 额=${Math.round(v.amountWan)}万 PE=${v.pe ?? '-'} PB=${v.pb ?? '-'} 换手=${v.turnoverPct ?? '-'} 时间=${v.time}`,
  )
}
const sources = [...quotes.values()].map(q => q.source)
console.log(`\nOK：${quotes.size}/4 只取到（fuyao=${sources.filter(s => s === 'fuyao').length}，tencent=${sources.filter(s => s === 'tencent').length}）`)
