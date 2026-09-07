import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRADES_HEADER,
  appendTradeRecord,
  makeSellRecord,
  parseTradesDoc,
  renderTradesDoc,
  renderTradesList,
  summarizeTrades,
  tradesTemplate,
  type TradeRecord,
} from '../src/trades.ts'

function sell(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    date: '2026-09-05',
    code: 'sz159883',
    name: '医疗器械ETF',
    action: 'sell',
    shares: 10000,
    price: 0.5,
    cost: 0.477,
    pnl: 230,
    note: '',
    ...over,
  }
}

test('parseTradesDoc：注释/空行原样保留，坏行进 warnings，解析⇄渲染往返一致', () => {
  const csv = [
    '# 手写说明：只记卖出',
    TRADES_HEADER,
    '2026-09-04,sh510880,红利ETF,sell,1000,3.0,2.683,317,对账自动补记（清仓）',
    '',
    '坏日期,600519,x,sell,100,10,9,100,',
    '2026-09-05,300750,宁德时代,sell,-5,260,270,-50,股数不合法',
  ].join('\n')
  const doc = parseTradesDoc(csv)
  assert.equal(doc.records.length, 1)
  assert.equal(doc.records[0].code, 'sh510880')
  assert.equal(doc.records[0].pnl, 317)
  assert.equal(doc.warnings.length, 2)
  // 文档模型：注释/空行/坏行逐字保留，写回不丢
  const out = renderTradesDoc(doc)
  assert.ok(out.includes('# 手写说明：只记卖出'))
  assert.ok(out.includes('坏日期,600519,x,sell,100,10,9,100,'))
  // 往返：再解析结果一致（数据行重渲染后仍是同一批记录）
  const again = parseTradesDoc(out)
  assert.deepEqual(again.records, doc.records)
  assert.deepEqual(again.warnings, doc.warnings)
})

test('parseTradesDoc：price/cost/pnl 可留空（自动补记缺行情的记录）', () => {
  const csv = [TRADES_HEADER, '2026-09-05,sz300285,国瓷材料,sell,100,,,,' ].join('\n')
  const doc = parseTradesDoc(csv)
  assert.deepEqual(
    { ...doc.records[0], date: doc.records[0].date },
    { date: '2026-09-05', code: 'sz300285', name: '国瓷材料', action: 'sell', shares: 100, price: null, cost: null, pnl: null, note: '' },
  )
})

test('makeSellRecord：价格成本齐备算 pnl，缺失记 null；非法输入抛错', () => {
  const full = makeSellRecord({ date: '2026-09-05', code: '159883', name: '医疗器械ETF', shares: 10000, price: 0.5, cost: 0.477, note: 'x' })
  assert.equal(full.code, 'sz159883')
  assert.equal(full.pnl, 230) // (0.5 − 0.477) × 10000
  const noPrice = makeSellRecord({ date: '2026-09-05', code: 'sh510880', shares: 1000, price: null, cost: 2.683 })
  assert.equal(noPrice.pnl, null)
  assert.throws(() => makeSellRecord({ date: '2026-09-05', code: 'sh510880', shares: 0, price: 1, cost: 1 }), /正整数/)
  assert.throws(() => makeSellRecord({ date: '2026-09-05', code: 'sh510880', shares: 100, price: -1, cost: 1 }), /正数/)
})

test('appendTradeRecord：只追加不改既有行，注释保留', () => {
  const csv = ['# 底部注释别动', TRADES_HEADER].join('\n')
  const doc = parseTradesDoc(csv)
  const next = appendTradeRecord(doc, sell())
  const out = renderTradesDoc(next)
  assert.ok(out.includes('# 底部注释别动'))
  assert.ok(out.includes('2026-09-05,sz159883,医疗器械ETF,sell,10000,0.5,0.477,230,'))
  assert.equal(next.records.length, 1)
  // 原文档不受影响（不可变）
  assert.equal(doc.records.length, 0)
})

test('summarizeTrades：只统计卖出；胜率、盈亏合计、skipped 各就各位', () => {
  const records = [
    sell({ pnl: 230 }),                    // 计入：盈
    sell({ pnl: -50 }),                    // 计入：亏
    sell({ pnl: 0 }),                      // 计入：打平（不算盈）
    sell({ price: null, cost: null, pnl: null }), // 缺价：skipped
    { ...sell(), action: 'buy' as const, pnl: null, note: '历史买入' }, // 买入不进统计
  ]
  const stats = summarizeTrades(records)
  assert.equal(stats.pnl, 180)
  assert.equal(stats.trades, 3)
  assert.equal(stats.wins, 1)
  assert.ok(Math.abs(stats.winRate! - (1 / 3) * 100) < 1e-9)
  assert.equal(stats.skipped, 1)
  // 空账本
  const empty = summarizeTrades([])
  assert.deepEqual(empty, { pnl: null, trades: 0, wins: 0, winRate: null, skipped: 0 })
})

test('renderTradesList：空账本给引导；有记录给表格 + 统计 + skipped 提示', () => {
  assert.ok(renderTradesList([], summarizeTrades([])).includes('暂无流水记录'))
  const stats = summarizeTrades([sell(), sell({ pnl: null, price: null, cost: null })])
  const text = renderTradesList([sell(), sell({ pnl: null, price: null, cost: null })], stats)
  assert.ok(text.includes('| 日期 | 代码 | 名称 | 动作 | 股数 | 价格 | 成本 | 已实现盈亏 | 备注 |'))
  assert.ok(text.includes('| 2026-09-05 | sz159883 | 医疗器械ETF | 卖出 | 10000 | 0.50 | 0.48 | +230.00 | — |'))
  assert.ok(text.includes('累计已实现盈亏：+230.00 元（卖出 1 笔，胜率 100.0%）'))
  assert.ok(text.includes('另有 1 笔卖出缺卖出价/成本'))
})

test('tradesTemplate：可被解析且零记录', () => {
  const doc = parseTradesDoc(tradesTemplate())
  assert.deepEqual(doc.warnings, [])
  assert.equal(doc.records.length, 0)
})
