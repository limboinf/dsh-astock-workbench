import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEastmoneyOverview, parseTencentOverview, sumMarketTotals } from '../src/market.ts'
import { decodeMarketTag, encodeMarketTag, MARKET_PAYLOAD_VERSION, renderMarketContext, type MarketPayload } from '../src/dto.ts'

// 2026-09-04 实测样本（字段裁剪，保留解析用到的键）
const EM_SAMPLE = {
  rc: 0,
  data: {
    total: 3,
    diff: [
      { f2: 3964.45, f3: 0.57, f4: 22.36, f6: 449400000000, f12: '000001', f14: '上证指数', f62: 710000000, f104: 1768, f105: 536, f106: 52, f124: 37800 },
      { f2: 13680.2, f3: 0.4, f4: 55.08, f6: 545600000000, f12: '399001', f14: '深证成指', f62: 7540000000, f104: 2273, f105: 612, f106: 52, f124: 37800 },
      { f2: 3329.12, f3: 0.5, f4: 16.58, f6: 258300000000, f12: '399006', f14: '创业板指', f62: 4500000000, f104: 1064, f105: 322, f106: 13, f124: 37800 },
    ],
  },
}

test('东财解析：字段映射与快照时间', () => {
  const { rows, time } = parseEastmoneyOverview(EM_SAMPLE)
  assert.equal(rows.length, 3)
  const sh = rows[0]
  assert.equal(sh.name, '上证指数')
  assert.equal(sh.price, 3964.45)
  assert.equal(sh.changePct, 0.57)
  assert.equal(sh.up, 1768)
  assert.equal(sh.down, 536)
  assert.equal(sh.netInflow, 710000000)
  // f124 = 当日秒数 37800 → 10:30:00
  assert.equal(time, '10:30:00')
})

test('东财解析：rc 非 0 / 结构不符 → 空数组（由调用方走兜底）', () => {
  assert.deepEqual(parseEastmoneyOverview({ rc: 1, data: { diff: [] } }).rows, [])
  assert.deepEqual(parseEastmoneyOverview(null).rows, [])
  assert.deepEqual(parseEastmoneyOverview({ rc: 0 }).rows, [])
  // 缺字段的行降级成 null 而不是丢弃整行
  const partial = parseEastmoneyOverview({ rc: 0, data: { diff: [{ f12: '000001', f14: '上证指数', f2: '-' }] } })
  assert.equal(partial.rows.length, 1)
  assert.equal(partial.rows[0].price, null)
  assert.equal(partial.rows[0].up, null)
})

test('合计只累加沪深两市：创业板含在深市里，不能重复计', () => {
  const { rows } = parseEastmoneyOverview(EM_SAMPLE)
  const totals = sumMarketTotals(rows)
  // 1768 + 2273 = 4041（不含创业板的 1064）
  assert.equal(totals.up, 4041)
  assert.equal(totals.down, 536 + 612)
  assert.equal(totals.amount, 449400000000 + 545600000000)
  assert.equal(totals.netInflow, 710000000 + 7540000000)
})

test('合计：全部缺失时是 null 而不是 0（避免把「没数据」画成「零流入」）', () => {
  const totals = sumMarketTotals([
    { code: '000001', name: '上证指数', price: 1, change: null, changePct: null, amount: null, up: null, down: null, flat: null, netInflow: null },
  ])
  assert.equal(totals.up, null)
  assert.equal(totals.netInflow, null)
  assert.equal(totals.amount, null)
})

test('腾讯兜底解析：拿得到价格，家数与资金流为 null', () => {
  // 2026-09-04 实测样本（字段截断到 amountWan 之后即可）
  const text = 'v_sh000001="1~上证指数~000001~3965.72~3942.09~3955.55~258642913~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260904103648~23.63~0.60~3980.20~3955.55~x~258642913~44531042~0.53~17.22~";'
  const { rows, time } = parseTencentOverview(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].code, '000001')
  assert.equal(rows[0].name, '上证指数')
  assert.equal(rows[0].price, 3965.72)
  assert.equal(rows[0].changePct, 0.6)
  // amountWan 44531042 万 → 元
  assert.equal(rows[0].amount, 44531042 * 10000)
  assert.equal(rows[0].up, null)
  assert.equal(rows[0].netInflow, null)
  assert.equal(time, '10:36:48')
})

test('大盘载荷编解码往返；版本对不上返回 null', () => {
  const { rows, time } = parseEastmoneyOverview(EM_SAMPLE)
  const payload: MarketPayload = {
    v: MARKET_PAYLOAD_VERSION, time, indices: rows,
    totals: sumMarketTotals(rows), source: 'eastmoney', error: null,
  }
  const decoded = decodeMarketTag(`## 大盘概览\n${encodeMarketTag(payload)}`)
  assert.equal(decoded?.indices.length, 3)
  assert.equal(decoded?.totals.up, 4041)
  assert.equal(decodeMarketTag('没有载荷'), null)
  assert.equal(decodeMarketTag(encodeMarketTag({ ...payload, v: 99 } as unknown as MarketPayload)), null)
})

test('renderMarketContext：有数据时给出背景段，失败/空时返回空串', () => {
  const { rows, time } = parseEastmoneyOverview(EM_SAMPLE)
  const payload: MarketPayload = {
    v: MARKET_PAYLOAD_VERSION, time, indices: rows,
    totals: sumMarketTotals(rows), source: 'eastmoney', error: null,
  }
  const text = renderMarketContext(payload)
  assert.ok(text.includes('上证指数 3964.45（+0.57%）'))
  assert.ok(text.includes('涨 4041 / 跌 1148'))
  assert.ok(text.includes('两市成交 9950 亿'))
  assert.ok(text.includes('主力净流入：+82.5 亿'))
  // 防「先把大盘背一遍再答题」——这句必须在
  assert.ok(text.includes('不要复述这些数字'))

  // 取数失败 / 空数据不注入任何东西，绝不让模型对着空背景编
  assert.equal(renderMarketContext(null), '')
  assert.equal(renderMarketContext({ ...payload, error: '接口不可用' }), '')
  assert.equal(renderMarketContext({ ...payload, indices: [] }), '')
})

test('renderMarketContext：腾讯兜底缺家数与资金流时，只出指数行不编 0', () => {
  const { rows } = parseTencentOverview(
    'v_sh000001="1~上证指数~000001~3965.72~3942.09~3955.55~0~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260904103648~23.63~0.60~";',
  )
  const text = renderMarketContext({
    v: MARKET_PAYLOAD_VERSION, time: '10:36:48', indices: rows,
    totals: sumMarketTotals(rows), source: 'tencent', error: null,
  })
  assert.ok(text.includes('上证指数'))
  assert.ok(!text.includes('涨跌家数'))
  assert.ok(!text.includes('主力净流入'))
})
