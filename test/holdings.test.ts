import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HOLDINGS_HEADER,
  holdingsTemplate,
  mergePosition,
  mergePositionInDoc,
  parseHoldingsCsv,
  parseHoldingsDoc,
  removePosition,
  removePositionInDoc,
  renderHoldingsCsv,
  renderHoldingsDoc,
  setPositionInDoc,
} from '../src/holdings.ts'
import { summarize, renderSummaryText, renderQuotesText } from '../src/format.ts'
import type { Quote } from '../src/quotes.ts'

function quote(symbol: string, price: number, changePct: number): [string, Quote] {
  // 昨收与涨跌幅自洽（当日盈亏按「现价−昨收」精确计算，依赖两个字段一致）
  const prevClose = price / (1 + changePct / 100)
  return [
    symbol,
    {
      symbol,
      name: `股${symbol}`,
      code: symbol.replace(/^[a-z]{2}/, ''),
      price,
      prevClose,
      open: price,
      high: price,
      low: price,
      change: price - prevClose,
      changePct,
      volume: 0,
      amountWan: 0,
      time: '20260903150000',
    },
  ]
}

test('parseHoldingsCsv：注释/表头/空行/引号', () => {
  const csv = [
    '# 注释行',
    '',
    HOLDINGS_HEADER,
    '600519,贵州茅台,100,1700,白酒,"含,逗号备注"',
    'sz000001,,1000,11.5,银行,',
  ].join('\n')
  const { positions, warnings } = parseHoldingsCsv(csv)
  assert.equal(warnings.length, 0)
  assert.equal(positions.length, 2)
  assert.equal(positions[0].code, 'sh600519')
  assert.equal(positions[0].name, '贵州茅台')
  assert.equal(positions[0].shares, 100)
  assert.equal(positions[0].cost, 1700)
  assert.equal(positions[0].note, '含,逗号备注')
  assert.equal(positions[1].code, 'sz000001')
  assert.equal(positions[1].name, '')
})

test('parseHoldingsCsv：坏行产生警告并跳过', () => {
  const csv = [HOLDINGS_HEADER, '600519,贵州茅台,100,1700,,', 'BADCODE,x,1,1,,', '300750,,0,10,,', '000001,,,11,,'].join('\n')
  const { positions, warnings } = parseHoldingsCsv(csv)
  // 第一行是合法行（sector/note 可空），其余三行分别因代码/股数/股数不合法被跳过
  assert.equal(positions.length, 1)
  assert.equal(warnings.length, 3)
})

test('parseHoldingsCsv：负数/非整数股数不合法', () => {
  const csv = [HOLDINGS_HEADER, '600519,茅台,-100,1700,,', '300750,宁德,100.5,260,,'].join('\n')
  const { positions, warnings } = parseHoldingsCsv(csv)
  assert.equal(positions.length, 0)
  assert.equal(warnings.length, 2)
})

test('parseHoldingsCsv：重复代码产生警告（记账将拒绝写回）', () => {
  const csv = [HOLDINGS_HEADER, '600519,贵州茅台,100,1700,,', 'sh600519,茅台,100,1700,,'].join('\n')
  const { positions, warnings } = parseHoldingsCsv(csv)
  assert.equal(positions.length, 1)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('重复'))
})

test('parseHoldingsDoc/renderHoldingsDoc：注释/空行/坏行原样保留', () => {
  const text = [
    '# 我的持仓',
    '',
    HOLDINGS_HEADER,
    '600519,贵州茅台,100,1700,白酒,长期底仓',
    '# 手写备注：打新底仓别动',
    'BADCODE,x,1,1,,',
    '300750,宁德时代,200,260,,',
  ].join('\n') + '\n'
  const doc = parseHoldingsDoc(text)
  assert.equal(doc.positions.length, 2)
  assert.equal(doc.warnings.length, 1)
  const roundtrip = renderHoldingsDoc(doc)
  assert.ok(roundtrip.includes('# 我的持仓'))
  assert.ok(roundtrip.includes('# 手写备注：打新底仓别动'))
  assert.ok(roundtrip.includes('BADCODE,x,1,1,,'))
  assert.ok(roundtrip.includes('sh600519,贵州茅台,100,1700,白酒,长期底仓'))
})

test('mergePositionInDoc：同代码原位更新，注释保留；新代码追加到末尾', () => {
  const doc = parseHoldingsDoc(
    ['# 手写备注', HOLDINGS_HEADER, '600519,贵州茅台,100,1700,白酒,'].join('\n') + '\n',
  )
  const { doc: d1 } = mergePositionInDoc(doc, { code: '600519', shares: 100, cost: 1300 })
  const text1 = renderHoldingsDoc(d1)
  assert.ok(text1.includes('# 手写备注'))
  assert.ok(text1.includes('sh600519,贵州茅台,200,1500,白酒,'))
  assert.ok(d1.positions[0]!.shares === 200)

  const { doc: d2, merged } = mergePositionInDoc(d1, { code: '000001', shares: 1000, cost: 11.5 })
  assert.equal(merged.code, 'sz000001')
  assert.ok(renderHoldingsDoc(d2).endsWith('sz000001,,1000,11.5,,\n'))
  assert.equal(d2.positions.length, 2)
})

test('removePositionInDoc：移除数据行，注释保留', () => {
  const doc = parseHoldingsDoc(
    ['# 底仓', HOLDINGS_HEADER, '600519,贵州茅台,100,1700,白酒,'].join('\n') + '\n',
  )
  const { doc: next, removed } = removePositionInDoc(doc, '600519')
  assert.equal(removed?.code, 'sh600519')
  const text = renderHoldingsDoc(next)
  assert.ok(text.includes('# 底仓'))
  assert.ok(!text.includes('sh600519,'))
  assert.equal(next.positions.length, 0)
})

test('mergePosition：新代码追加', () => {
  const { positions, merged } = mergePosition([], { code: '600519', shares: 100, cost: 1700, name: '贵州茅台' })
  assert.equal(positions.length, 1)
  assert.equal(merged.code, 'sh600519')
  assert.equal(merged.name, '贵州茅台')
})

test('mergePosition：同代码加权合并成本', () => {
  const { positions } = mergePosition([], { code: '600519', shares: 100, cost: 1700 })
  const { positions: next, merged } = mergePosition(positions, { code: 'sh600519', shares: 100, cost: 1300 })
  assert.equal(next.length, 1)
  assert.equal(merged.shares, 200)
  assert.equal(merged.cost, 1500)
})

test('mergePosition：非法输入抛错', () => {
  assert.throws(() => mergePosition([], { code: '600519', shares: 0, cost: 10 }))
  assert.throws(() => mergePosition([], { code: '600519', shares: -100, cost: 10 }))
  assert.throws(() => mergePosition([], { code: '600519', shares: 100.5, cost: 10 }))
  assert.throws(() => mergePosition([], { code: '600519', shares: 100, cost: -1 }))
})

test('removePosition：按代码移除', () => {
  const { positions } = mergePosition([], { code: '600519', shares: 100, cost: 1700 })
  const { positions: next, removed } = removePosition(positions, '600519')
  assert.equal(next.length, 0)
  assert.equal(removed?.code, 'sh600519')
  assert.equal(removePosition([], '600519').removed, undefined)
})

test('renderHoldingsCsv ↔ parseHoldingsCsv 往返一致', () => {
  const a = mergePosition([], { code: '600519', shares: 100, cost: 1700, name: '贵,茅', sector: '白酒', note: '"引号"备注' })
  const csv = renderHoldingsCsv(a.positions)
  const { positions, warnings } = parseHoldingsCsv(csv)
  assert.equal(warnings.length, 0)
  assert.equal(positions.length, 1)
  assert.equal(positions[0].name, '贵,茅')
  assert.equal(positions[0].note, '"引号"备注')
})

test('holdingsTemplate：首行是注释且包含表头', () => {
  const t = holdingsTemplate()
  assert.ok(t.startsWith('#'))
  assert.ok(t.includes(HOLDINGS_HEADER))
})

test('summarize：市值/盈亏/当日（较昨收口径）', () => {
  const positions = [
    { code: 'sh600519', name: '茅台', shares: 100, cost: 1000, sector: '', note: '' },
    { code: 'sz000001', name: '平安', shares: 1000, cost: 12, sector: '', note: '' },
  ]
  const quotes = new Map([quote('sh600519', 1100, 2), quote('sz000001', 10, -1)])
  const s = summarize(positions, quotes)
  assert.equal(s.totalMarketValue, 1100 * 100 + 10 * 1000)
  assert.equal(s.totalAssets, s.totalMarketValue)
  assert.equal(s.totalCostBasis, 1000 * 100 + 12 * 1000)
  assert.equal(s.totalPnl, (1100 - 1000) * 100 + (10 - 12) * 1000)
  // 总成本 100×1000 + 12×1000 = 112000，盈亏 8000
  assert.ok(Math.abs(s.totalPnlPct! - (8000 / 112000) * 100) < 1e-9)
  // 当日：Σ(现价−昨收)×股数，与券商「当日参考盈亏」同口径；百分比 = 金额 / Σ(昨收×股数)
  const prev1 = 1100 / 1.02
  const prev2 = 10 / 0.99
  const dayPnl = (1100 - prev1) * 100 + (10 - prev2) * 1000
  assert.ok(Math.abs(s.dayPnl! - dayPnl) < 1e-6)
  assert.ok(Math.abs(s.dayPnlPct! - (dayPnl / (prev1 * 100 + prev2 * 1000)) * 100) < 1e-9)
  assert.equal(s.missingQuotes.length, 0)
})

test('summarize：部分缺行情时按覆盖口径合计，持仓成本保持全量', () => {
  const positions = [
    { code: 'sh600519', name: '茅台', shares: 100, cost: 1000, sector: '', note: '' },
    { code: 'sz000001', name: '平安', shares: 1000, cost: 12, sector: '', note: '' },
  ]
  const quotes = new Map([quote('sh600519', 1100, 1)])
  const s = summarize(positions, quotes)
  // 市值/盈亏只算有行情的茅台；成本是全量（10 万 + 1.2 万）
  assert.equal(s.totalMarketValue, 1100 * 100)
  assert.equal(s.totalCostBasis, 1000 * 100 + 12 * 1000)
  assert.equal(s.totalPnl, (1100 - 1000) * 100)
  // 盈亏率与 totalPnl 同口径：1 万 / 覆盖部分成本 10 万
  assert.ok(Math.abs(s.totalPnlPct! - 10) < 1e-9)
  // 当日只有茅台的 +1%（较昨收口径下单标的精确等于其涨跌幅）
  assert.ok(Math.abs(s.dayPnlPct! - 1) < 1e-9)
  assert.deepEqual(s.missingQuotes, ['sz000001'])
  const text = renderSummaryText(s)
  assert.ok(text.includes('sz000001'))
  assert.ok(text.includes('未取到行情'))
  assert.ok(text.includes('112,000'))
  assert.ok(text.includes('总资产（持仓口径，不含现金）'))
})

test('summarize：完全离线时市值类合计为空，持仓成本仍可算', () => {
  const positions = [
    { code: 'sh600519', name: '茅台', shares: 100, cost: 1000, sector: '', note: '' },
    { code: 'sz000001', name: '平安', shares: 1000, cost: 12, sector: '', note: '' },
  ]
  const s = summarize(positions, new Map())
  assert.equal(s.totalMarketValue, null)
  assert.equal(s.totalPnl, null)
  assert.equal(s.totalPnlPct, null)
  assert.equal(s.dayPnl, null)
  assert.equal(s.dayPnlPct, null)
  assert.equal(s.totalCostBasis, 1000 * 100 + 12 * 1000)
  assert.deepEqual(s.missingQuotes, ['sh600519', 'sz000001'])
})

test('渲染：换手率出现在汇总表格与行情文本中', () => {
  const positions = [{ code: 'sh600519', name: '茅台', shares: 100, cost: 1000, sector: '', note: '' }]
  const [sym, base] = quote('sh600519', 1100, 2)
  const q: Quote = { ...base, turnoverPct: 1.23 }
  const text = renderSummaryText(summarize(positions, new Map([[sym, q]])))
  assert.ok(text.includes('换手'))
  assert.ok(text.includes('1.23%'))
  const quoteText = renderQuotesText([q])
  assert.ok(quoteText.includes('换手 1.23%'))
  // 无换手数据时不渲染该字段
  assert.ok(!renderQuotesText([base]).includes('换手'))
})

test('renderSummaryText：手动总资产覆盖行', () => {
  const positions = [{ code: 'sh600519', name: '茅台', shares: 100, cost: 1000, sector: '', note: '' }]
  const [sym, q] = quote('sh600519', 1100, 2)
  const text = renderSummaryText(summarize(positions, new Map([[sym, q]])), undefined, { value: 528306.88, updatedAt: '2026-09-03' })
  assert.ok(text.includes('手动总资产：528,306.88 元（截至 2026-09-03）'))
  // 不传手动值时不含该行
  assert.ok(!renderSummaryText(summarize(positions, new Map([[sym, q]]))).includes('手动总资产'))
})

test('renderSummaryText：现金口径总资产 = 持仓市值 + 现金', () => {
  const positions = [{ code: 'sh600519', name: '茅台', shares: 100, cost: 1000, sector: '', note: '' }]
  const [sym, q] = quote('sh600519', 1100, 2)
  const cash = { value: 50000, updatedAt: '2026-09-04' }
  // 市值 110,000 + 现金 50,000 = 160,000
  const text = renderSummaryText(summarize(positions, new Map([[sym, q]])), undefined, undefined, cash)
  assert.ok(text.includes('总资产（持仓市值 + 现金）：160,000.00 元（现金 50,000.00，截至 2026-09-04）'))
  assert.ok(!text.includes('持仓口径'))
  // 完全缺行情时总资产无法合成显示 —，现金仍显示
  const offline = renderSummaryText(summarize(positions, new Map()), undefined, undefined, cash)
  assert.ok(offline.includes('总资产（持仓市值 + 现金）：— 元（现金 50,000.00，截至 2026-09-04）'))
})

test('renderSummaryText：当日参考盈亏百分比按总资产口径（对齐券商），集合竞价时段带提示', () => {
  const positions = [{ code: 'sh600519', name: '茅台', shares: 100, cost: 1000, sector: '', note: '' }]
  // 现价 1020 较昨收 1000 = +2% → 当日盈亏 +2,000 元
  const [sym, q] = quote('sh600519', 1020, 2)
  const text = renderSummaryText(summarize(positions, new Map([[sym, q]])))
  // 无现金/手动总资产 → 降级为持仓口径，文案写明分母
  assert.ok(text.includes('当日参考盈亏：+2,000.00 元（+2.00%，占持仓市值）'))
  // 现金口径：分母是昨收总资产 = 昨收持仓市值 100,000 + 现金 100,000 → +1.00%
  const withCash = renderSummaryText(
    summarize(positions, new Map([[sym, q]])), undefined, undefined,
    { value: 100000, updatedAt: '2026-09-04' },
  )
  assert.ok(withCash.includes('当日参考盈亏：+2,000.00 元（+1.00%，占总资产）'))
  // 手动总资产口径：快照直接当昨收总资产用 → 2,000 / 200,000 = +1.00%
  const withManual = renderSummaryText(
    summarize(positions, new Map([[sym, q]])), undefined,
    { value: 200000, updatedAt: '2026-09-04' },
  )
  assert.ok(withManual.includes('当日参考盈亏：+2,000.00 元（+1.00%，占总资产）'))
  // 集合竞价（9:15–9:25）内的行情时间要提示价格未定盘
  const auction = renderSummaryText(summarize(positions, new Map([[sym, q]])), '2026-09-04 09:20:45')
  assert.ok(auction.includes('集合竞价'))
  // 收盘后的行情时间不提示
  const closed = renderSummaryText(summarize(positions, new Map([[sym, q]])), '2026-09-04 15:00:00')
  assert.ok(!closed.includes('集合竞价'))
})

test('setPositionInDoc：对账覆盖写——原位覆盖股数成本、保留注释、新增追加', () => {
  const csv = ['# 底仓', HOLDINGS_HEADER, '600519,贵州茅台,100,1700,白酒,长期持有', '300750,宁德时代,200,260,电池,'].join('\n')
  const doc = parseHoldingsDoc(csv)
  // 覆盖已有行：股数/成本以外部为准，name 传入时更新，sector/note 保留
  const r1 = setPositionInDoc(doc, { code: '300750', shares: 300, cost: 273.333, name: '宁德时代' })
  const text1 = renderHoldingsDoc(r1.doc)
  assert.ok(text1.includes('sz300750,宁德时代,300,273.333,电池,'))
  assert.ok(text1.includes('sh600519,贵州茅台,100,1700,白酒,长期持有'))
  assert.ok(text1.includes('# 底仓'))
  // 不传 name 时本地名不动
  const r2 = setPositionInDoc(doc, { code: '600519', shares: 200, cost: 1500 })
  assert.ok(renderHoldingsDoc(r2.doc).includes('sh600519,贵州茅台,200,1500,白酒,长期持有'))
  // 新代码追加到末尾
  const r3 = setPositionInDoc(doc, { code: '600036', shares: 500, cost: 38.5, name: '招商银行' })
  const text3 = renderHoldingsDoc(r3.doc)
  assert.ok(text3.includes('sh600036,招商银行,500,38.5,,'))
  assert.ok(text3.trim().endsWith('sh600036,招商银行,500,38.5,,'))
  // 非法参数拒绝
  assert.throws(() => setPositionInDoc(doc, { code: '600519', shares: 1.5, cost: 1700 }))
  assert.throws(() => setPositionInDoc(doc, { code: '600519', shares: 100, cost: 0 }))
})
