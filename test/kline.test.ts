/**
 * kline 解析层单测 —— fixture 为 2026-09-06 实抓样本（fuyao historical + 腾讯 fqkline，
 * sh600522 同日开高低收两源逐位一致，见 src/kline.ts 头注契约）。网络层不打真网，
 * 只测「已中止的 signal 立即抛错」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeKlineStats,
  fetchKlines,
  formatShanghaiDate,
  parseFuyaoKline,
  parseTencentKline,
  type KBar,
} from '../src/kline.ts'

// fuyao /api/a-share/prices/historical 实测样本（sh600522，前 2 根，字段原样）
const FUYAO_SAMPLE = {
  item: [
    {
      date_ms: 1781193600000,
      volume: 330123533,
      turnover: 16532537299.14,
      open_price: 50.46,
      high_price: 51.940000000000005,
      low_price: 48.330000000000005,
      close_price: 48.34,
    },
    {
      date_ms: 1781452800000,
      volume: 309924242,
      turnover: 15423309740.08,
      open_price: 49.71,
      high_price: 51.21,
      low_price: 46.620000000000005,
      close_price: 51.09,
    },
  ],
}

// 腾讯 fqkline 实测样本（sh600522 qfqday 前 2 行，原样；注意收在下标 2、高在下标 3）
const TENCENT_ROWS = [
  ['2026-06-12', '50.460', '48.340', '51.940', '48.330', '3301235.000'],
  ['2026-06-15', '49.710', '51.090', '51.210', '46.620', '3099242.000'],
]
const TENCENT_SAMPLE = { data: { sh600522: { qfqday: TENCENT_ROWS, qt: {}, prec: '3' } } }
const TENCENT_INDEX_SAMPLE = { data: { sh000300: { day: TENCENT_ROWS } } }

test('fuyao K 线解析：字段映射、量纲股→手、北京时间日期', () => {
  const bars = parseFuyaoKline(FUYAO_SAMPLE, formatShanghaiDate)
  assert.equal(bars.length, 2)
  assert.deepEqual(bars[0], {
    date: '2026-06-12',
    open: 50.46,
    close: 48.34,
    high: 51.940000000000005,
    low: 48.330000000000005,
    volume: 3301235, // 330123533 股 → 手
  })
})

test('fuyao K 线解析：坏行（缺字段）跳过，item 缺失返回空', () => {
  const bars = parseFuyaoKline(
    { item: [{ ...FUYAO_SAMPLE.item[0], close_price: null }, FUYAO_SAMPLE.item[1]] },
    formatShanghaiDate,
  )
  assert.equal(bars.length, 1)
  assert.equal(bars[0].date, '2026-06-15')
  assert.deepEqual(parseFuyaoKline({}, formatShanghaiDate), [])
})

test('腾讯 K 线解析：qfqday 键、下标固化（收在下标 2、高在下标 3）', () => {
  const bars = parseTencentKline(TENCENT_SAMPLE, 'sh600522')
  assert.equal(bars.length, 2)
  assert.deepEqual(bars[0], {
    date: '2026-06-12',
    open: 50.46,
    close: 48.34,
    high: 51.94,
    low: 48.33,
    volume: 3301235,
  })
  // 两源交叉验证：同日开高低收逐位一致（2026-09-06 实测，复权口径相同）
  const fuyao = parseFuyaoKline(FUYAO_SAMPLE, formatShanghaiDate)
  for (const key of ['open', 'close', 'high', 'low', 'volume'] as const) {
    // fuyao 带浮点尾差（51.940000000000005），按价格精度比较
    assert.equal(Math.abs(bars[0][key] - fuyao[0][key]) < 1e-9, true, key)
  }
})

test('腾讯 K 线解析：不复权/指数走 day 键；坏行与整体缺失返回空', () => {
  const byDay = parseTencentKline(TENCENT_INDEX_SAMPLE, 'sh000300')
  assert.equal(byDay.length, 2)
  assert.equal(byDay[1].close, 51.09)
  const withBadRow = parseTencentKline(
    { data: { sh600522: { qfqday: [['2026-06-12', 'x', '48.34', '51.94', '48.33', '1'], ...TENCENT_ROWS] } } },
    'sh600522',
  )
  assert.equal(withBadRow.length, 2) // 首行开价无效被跳过
  assert.deepEqual(parseTencentKline({ data: { sh600522: {} } }, 'sh600522'), [])
  assert.deepEqual(parseTencentKline({}, 'sh600522'), [])
})

test('computeKlineStats：均线/量比/20日位置/区间收益', () => {
  // 22 根构造数据：前 21 根收 10（量 100），末根收 11（量 300，20日最高冲 12）
  const bars: KBar[] = Array.from({ length: 21 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, '0')}`,
    open: 10, close: 10, high: 10, low: 10, volume: 100,
  }))
  bars.push({ date: '2026-08-22', open: 10.5, close: 11, high: 12, low: 10.2, volume: 300 })
  const s = computeKlineStats(bars)
  assert.equal(s.lastClose, 11)
  assert.equal(s.ma5, (10 + 10 + 10 + 10 + 11) / 5)
  assert.equal(s.ma20, (19 * 10 + 11) / 20) // 前 19 根 10 + 末根 11
  assert.equal(s.volRatio, 3) // 300 / 100
  assert.equal(s.high20, 12)
  assert.equal(s.low20, 10)
  // (11 − 10) / (12 − 10) = 50%
  assert.equal(s.pos20, 50)
  assert.equal(Math.abs(s.ret5! - (11 / 10 - 1) * 100) < 1e-9, true)
  assert.equal(Math.abs(s.ret20! - (11 / 10 - 1) * 100) < 1e-9, true)
})

test('computeKlineStats：数据不足 20 根时 20 日指标为 undefined，不推断', () => {
  const bars: KBar[] = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, '0')}`,
    open: 10, close: 10, high: 10.5, low: 9.5, volume: 100,
  }))
  const s = computeKlineStats(bars)
  assert.equal(s.ma5, 10)
  assert.equal(s.ma20, undefined)
  assert.equal(s.volRatio, undefined)
  assert.equal(s.ret20, undefined)
  // 10 根也当 20 日窗口用（不足即全部），位置仍可算
  assert.equal(s.pos20, 50) // 收 10 在 [9.5, 10.5] 的中位
})

test('fetchKlines：已中止的 signal 立即抛错（穿透降级逻辑）', async () => {
  const ctrl = new AbortController()
  ctrl.abort(new Error('用户中止'))
  await assert.rejects(() => fetchKlines(['sh600519'], { signal: ctrl.signal }))
})
