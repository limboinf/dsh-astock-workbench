/**
 * 当日盈亏口径 —— 现金流量法（format.ts summarize + trades.ts collectDayTurnover）。
 *
 * 数字全部取自 2026-09-07 的真实对账：老口径（Σ(现价−昨收)×现股数）在当日加仓的
 * 长江电力上少算 310 元、把当日清仓的国瓷材料整只丢掉 1,180 元，合计与券商差 1,490。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { summarize } from '../src/format.ts'
import { collectDayTurnover, parseTradesDoc } from '../src/trades.ts'
import type { Quote } from '../src/quotes.ts'

function quote(symbol: string, price: number, prevClose: number): [string, Quote] {
  return [symbol, {
    symbol, name: '', price, prevClose, change: price - prevClose,
    changePct: ((price - prevClose) / prevClose) * 100,
    open: price, high: price, low: price, volume: 0, amountWan: 0, time: '20260907135800',
  } as Quote]
}

const pos = (code: string, shares: number, cost: number) =>
  ({ code, name: '', shares, cost, sector: '', note: '' })

const TRADES = `date,code,name,action,shares,price,cost,pnl,note
2026-09-07,sz300285,国瓷材料,sell,500,62.75,61.161,794.5,清仓
2026-09-07,sh600900,长江电力,buy,500,27.80,,,加仓至 2300 股
2026-09-04,sh600900,长江电力,buy,300,28.70,,,前一交易日，不该进当日口径
`

const turnover = () => collectDayTurnover(parseTradesDoc(TRADES).records, '2026-09-07')

test('collectDayTurnover：只聚合指定交易日，买卖分列，缺成交价计 skipped', () => {
  const t = turnover()
  assert.equal(t.size, 2)
  assert.deepEqual(
    { ...t.get('sh600900')! },
    { code: 'sh600900', name: '长江电力', buyShares: 500, buyAmount: 13900, sellShares: 0, sellAmount: 0, skipped: 0 },
  )
  assert.equal(t.get('sz300285')!.sellAmount, 31375)
  // 9-04 那笔买入不在当日，聚合里查不到它的股数
  assert.equal(t.get('sh600900')!.buyShares, 500)

  const noPrice = collectDayTurnover(
    parseTradesDoc('date,code,name,action,shares,price,cost,pnl,note\n2026-09-07,sh600900,长电,buy,100,,,,\n').records,
    '2026-09-07',
  )
  assert.equal(noPrice.get('sh600900')!.skipped, 1)
  assert.equal(noPrice.get('sh600900')!.buyAmount, 0)
})

test('当日加仓：新买入的股份从成交价起算，不从昨收起算', () => {
  const positions = [pos('sh600900', 2300, 26.397)]
  const quotes = new Map([quote('sh600900', 27.84, 28.42)])
  // 老口径：2300 × (27.84 − 28.42) = −1334；券商口径：1800 段 + 500 段 = −1024
  assert.equal(summarize(positions, quotes).dayPnl!.toFixed(2), '-1334.00')
  const fixed = summarize(positions, quotes, turnover())
  assert.equal(fixed.dayPnl!.toFixed(2), '-1024.00')
  // 昨收持仓市值按昨日股数 1800 算，当日净投入 13900 记进 dayCashFlow
  assert.equal(fixed.dayPrevValue!.toFixed(2), (28.42 * 1800).toFixed(2))
  assert.equal(fixed.dayCashFlow, -13900)
})

test('当日清仓：标的已不在持仓表，当天赚的钱仍计入当日盈亏', () => {
  const positions = [pos('sh600900', 2300, 26.397)]
  const quotes = new Map([quote('sh600900', 27.84, 28.42), quote('sz300285', 62.75, 60.39)])
  const s = summarize(positions, quotes, turnover())
  // 国瓷：31375 卖出收入 − 60.39×500 昨收市值 = +1180，与券商当日 +1,180.00 一致
  assert.equal(s.dayPnl!.toFixed(2), (-1024 + 1180).toFixed(2))
  assert.equal(s.dayCashFlow, 31375 - 13900)
  // 已清仓标的不进市值/累计盈亏，只进当日口径
  assert.equal(s.totalMarketValue!.toFixed(2), (2300 * 27.84).toFixed(2))
  assert.equal(s.rows.length, 1)
})

test('当日清仓标的取不到行情时只出提示，不猜数', () => {
  const s = summarize([pos('sh600900', 2300, 26.397)], new Map([quote('sh600900', 27.84, 28.42)]), turnover())
  assert.equal(s.dayPnl!.toFixed(2), '-1024.00')
  assert.deepEqual(s.dayGaps, ['国瓷材料（当日有成交但未取到行情）'])
})

test('日内买卖（T+0）：昨日股数反推为 0，只留价差', () => {
  const doc = parseTradesDoc(
    'date,code,name,action,shares,price,cost,pnl,note\n' +
      '2026-09-07,sh513850,美国50ETF,buy,10000,1.42,,,\n' +
      '2026-09-07,sh513850,美国50ETF,sell,10000,1.45,,300,\n',
  )
  const s = summarize([], new Map([quote('sh513850', 1.45, 1.40)]), collectDayTurnover(doc.records, '2026-09-07'))
  assert.equal(s.dayPnl!.toFixed(2), '300.00')
  assert.equal(s.dayPrevValue!.toFixed(2), '0.00')
})
