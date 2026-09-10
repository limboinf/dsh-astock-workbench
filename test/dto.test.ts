import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeHtmlPreviewTag, decodePayloadTag, encodePayloadTag, encodeTag, HTML_PREVIEW_PAYLOAD_VERSION, stripPayloadTag } from '../src/dto.ts'
import { buildPortfolioPayload, renderSummaryText, summarize } from '../src/format.ts'
import type { Quote } from '../src/quotes.ts'

function quote(symbol: string, price: number, changePct: number): [string, Quote] {
  const prevClose = price / (1 + changePct / 100)
  return [symbol, {
    symbol, name: '测试', price, prevClose, changePct, change: price - prevClose,
    open: price, high: price, low: price, volume: 0, amountWan: 0, time: '',
    turnoverPct: 1.5,
  } as Quote]
}

const positions = [{ code: 'sh600519', name: '茅台', shares: 100, cost: 1000, sector: '', note: '' }]

test('载荷编解码往返；版本对不上、缺 tag、坏 JSON 都返回 null', () => {
  const payload = buildPortfolioPayload(summarize(positions, new Map([quote('sh600519', 1020, 2)])))
  const text = `## 持仓概览\n正文\n${encodePayloadTag(payload)}`
  const decoded = decodePayloadTag(text)
  assert.notEqual(decoded, null)
  assert.equal(decoded!.rows[0].code, 'sh600519')
  assert.equal(decoded!.rows[0].shares, 100)

  assert.equal(decodePayloadTag('没有载荷的纯文本'), null)
  assert.equal(decodePayloadTag('<!--astock:portfolio {坏的-->'), null)
  assert.equal(decodePayloadTag(encodePayloadTag({ ...payload, v: 99 } as never)), null)
})

test('stripPayloadTag 剥掉载荷且不动正文', () => {
  const payload = buildPortfolioPayload(summarize(positions, new Map([quote('sh600519', 1020, 2)])))
  const body = '## 持仓概览\n- 总市值：102,000.00 元'
  assert.equal(stripPayloadTag(`${body}\n${encodePayloadTag(payload)}`), body)
  assert.equal(stripPayloadTag(body), body)
})

test('载荷与文本同口径：当日盈亏分母跟着现金/手动总资产走', () => {
  const summary = summarize(positions, new Map([quote('sh600519', 1020, 2)]))
  // 昨收持仓市值 100,000，当日盈亏 +2,000

  // 无现金/手动值 → 退化为持仓口径 +2.00%
  const bare = buildPortfolioPayload(summary)
  assert.equal(bare.day.basis, 'market-value')
  assert.ok(Math.abs(bare.day.pct! - 2) < 1e-9)
  assert.equal(bare.totals.assetsBasis, 'holdings')

  // 现金口径：分母 = 昨收持仓市值 100,000 + 现金 100,000 → +1.00%
  const cash = { value: 100000, updatedAt: '2026-09-04' }
  const withCash = buildPortfolioPayload(summary, undefined, undefined, cash)
  assert.equal(withCash.day.basis, 'total-assets')
  assert.ok(Math.abs(withCash.day.pct! - 1) < 1e-9)
  assert.equal(withCash.totals.assetsBasis, 'cash')
  assert.equal(withCash.totals.assets, 102000 + 100000)

  // 手动快照口径：直接当昨收总资产 → 2,000 / 200,000 = +1.00%
  const manual = { value: 200000, updatedAt: '2026-09-04' }
  const withManual = buildPortfolioPayload(summary, undefined, manual)
  assert.equal(withManual.day.basis, 'total-assets')
  assert.ok(Math.abs(withManual.day.pct! - 1) < 1e-9)
  assert.equal(withManual.totals.assetsBasis, 'manual')
  assert.equal(withManual.totals.assets, 200000)

  // 与文本渲染同源：文本里的百分比和口径文案必须与载荷一致
  const text = renderSummaryText(summary, undefined, undefined, cash)
  assert.ok(text.includes('当日参考盈亏：+2,000.00 元（+1.00%，占总资产）'))
})

test('载荷覆盖缺行情：missingQuotes 入账，该行数值为 null，权重不炸', () => {
  const twoPositions = [
    ...positions,
    { code: 'sz000001', name: '平安', shares: 1000, cost: 12, sector: '', note: '' },
  ]
  const payload = buildPortfolioPayload(
    summarize(twoPositions, new Map([quote('sh600519', 1020, 2)])),
  )
  assert.deepEqual(payload.missingQuotes, ['sz000001'])
  const missing = payload.rows.find(r => r.code === 'sz000001')!
  assert.equal(missing.price, null)
  assert.equal(missing.marketValue, null)
  assert.equal(missing.weightPct, null)
  // 成本是全量口径，市值只算有行情的那只
  assert.equal(payload.totals.costBasis, 1000 * 100 + 12 * 1000)
  assert.equal(payload.totals.marketValue, 102000)
  assert.ok(Math.abs(payload.rows[0].weightPct! - 100) < 1e-9)
})

test('集合竞价时段与行情失败原因进载荷', () => {
  const summary = summarize(positions, new Map([quote('sh600519', 1020, 2)]))
  assert.equal(buildPortfolioPayload(summary, '2026-09-04 09:20:45').callAuction, true)
  assert.equal(buildPortfolioPayload(summary, '2026-09-04 15:00:00').callAuction, false)
  assert.equal(buildPortfolioPayload(summary).callAuction, false)
  const failed = buildPortfolioPayload(summary, undefined, undefined, undefined, '网络超时')
  assert.equal(failed.quoteError, '网络超时')
})

test('已实现盈亏只进汇总文本（2026-09-09 面板卡片已删，载荷不再携带）；不传时文本不出现该行', () => {
  const summary = summarize(positions, new Map([quote('sh600519', 1020, 2)]))
  const realized = { pnl: 1300, trades: 2, wins: 1, winRate: 50, skipped: 1 }

  const text = renderSummaryText(summary, undefined, undefined, undefined, realized)
  assert.ok(text.includes('- 已实现盈亏（卖出落袋）：+1,300.00 元（卖出 2 笔，胜率 50.0%）'))
  assert.ok(text.includes('另有 1 笔卖出缺卖出价/成本'))

  // 无卖出记录：保持既有输出不变（老调用方/测试不受影响）
  assert.ok(!renderSummaryText(summary).includes('已实现盈亏'))
})

test('htmlpreview 载荷：base64 往返还原全文，html 内字面 --> 不破坏定界', () => {
  const html = '<!DOCTYPE html><html><body><!-- 注释 --><script>i-->0;</script>中文✓</body></html>'
  const payload = { v: HTML_PREVIEW_PAYLOAD_VERSION, title: '市盈率', file: '/tmp/x.html', htmlB64: Buffer.from(html, 'utf8').toString('base64') }
  const text = encodeTag('htmlpreview', payload)

  const decoded = decodeHtmlPreviewTag(text)
  assert.notEqual(decoded, null)
  assert.equal(decoded!.title, '市盈率')
  assert.equal(decoded!.html, html)

  // 版本不符/空载荷回退 null（client 按「无法解析」降级，不白屏）
  assert.equal(decodeHtmlPreviewTag('<!--astock:htmlpreview {"v":999,"htmlB64":""}-->'), null)
  assert.equal(decodeHtmlPreviewTag('没有载荷'), null)
})
