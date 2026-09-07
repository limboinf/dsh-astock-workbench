/**
 * fundamentals（估值+财务）解析与折算单测。
 *
 * 契约样本为 2026-09-07 实测固化（002128 电投能源，period=quarterly&limit=9）：
 * 数值是年初至今累计（FY2025 annual 与 quarterly Q4 相等），单季须同年做差；
 * 2025Q4 累计被年报重述回撤（< Q3），差分出负单季是真实脏数据——渲染层的
 * 「扭亏为盈/亏损收窄」口径词就是为它准备的。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseIncomeStatements,
  computeSingleQuarters,
  renderFundamentalsText,
  type FundamentalsResult,
  type Quarter,
} from '../src/fundamentals.ts'

// 实测样本（只保留本模块消费的字段；金额单位元，累计值）
const SAMPLE_002128 = {
  code: 0,
  message: 'success',
  request_id: 'fixture',
  data: {
    timestamp: 1782748800000,
    item: [
      { thscode: '002128.SZ', period: 'quarterly', fiscal_year: 2026, fiscal_period: 'Q2', period_end_ms: 1782748800000, operating_income: 23922904002.14, parent_holder_net_profit: 5292682830.65 },
      { thscode: '002128.SZ', period: 'quarterly', fiscal_year: 2026, fiscal_period: 'Q1', period_end_ms: 1774886400000, operating_income: 8413266224.26, parent_holder_net_profit: 2001108276.43 },
      { thscode: '002128.SZ', period: 'quarterly', fiscal_year: 2025, fiscal_period: 'Q4', period_end_ms: 1767110400000, operating_income: 30114958327.31, parent_holder_net_profit: 5419089199.76 },
      { thscode: '002128.SZ', period: 'quarterly', fiscal_year: 2025, fiscal_period: 'Q3', period_end_ms: 1759161600000, operating_income: 31029585021.56, parent_holder_net_profit: 5352444240.65 },
      { thscode: '002128.SZ', period: 'quarterly', fiscal_year: 2025, fiscal_period: 'Q2', period_end_ms: 1751212800000, operating_income: 19942313524.35, parent_holder_net_profit: 3548957356.3 },
      { thscode: '002128.SZ', period: 'quarterly', fiscal_year: 2025, fiscal_period: 'Q1', period_end_ms: 1743350400000, operating_income: 7537446747.69, parent_holder_net_profit: 1559048223.47 },
      { thscode: '002128.SZ', period: 'quarterly', fiscal_year: 2024, fiscal_period: 'Q4', period_end_ms: 1735574400000, operating_income: 29859051547.04, parent_holder_net_profit: 5341613309.3 },
      { thscode: '002128.SZ', period: 'quarterly', fiscal_year: 2024, fiscal_period: 'Q3', period_end_ms: 1727625600000, operating_income: 21809510749.24, parent_holder_net_profit: 4399653791.11 },
      { thscode: '002128.SZ', period: 'quarterly', fiscal_year: 2024, fiscal_period: 'Q2', period_end_ms: 1719676800000, operating_income: 14126830108.55, parent_holder_net_profit: 2944243533 },
    ],
  },
}

test('parseIncomeStatements：降序排列、字段提取、非法条目跳过', () => {
  const withJunk = {
    item: [
      SAMPLE_002128.data.item[1],
      { fiscal_year: 2026, fiscal_period: 'Q13', period_end_ms: 1 }, // 季度非法
      { fiscal_year: null, fiscal_period: 'Q1', period_end_ms: 2 }, // 年份 null
      { fiscal_year: 2025, fiscal_period: 'Q2', period_end_ms: null, operating_income: 1 }, // 无时间戳
      SAMPLE_002128.data.item[0],
    ],
  }
  const qs = parseIncomeStatements(withJunk)
  assert.deepEqual(qs.map(q => `${q.year}Q${q.quarter}`), ['2026Q2', '2026Q1'])
  assert.equal(qs[0].income, 23922904002.14)
  assert.equal(qs[0].netProfit, 5292682830.65)
})

test('computeSingleQuarters：累计折单季（Q1 即单季、跨季差分、缺上季降级）', () => {
  const cums = parseIncomeStatements(SAMPLE_002128.data)
  const singles = computeSingleQuarters(cums)
  const byKey = new Map(singles.map(q => [`${q.year}Q${q.quarter}`, q]))

  // Q1 即单季
  assert.equal(byKey.get('2026Q1')?.income, 8413266224.26)
  // Q2 = 累计Q2 - 累计Q1
  assert.ok(Math.abs((byKey.get('2026Q2')?.income ?? 0) - (23922904002.14 - 8413266224.26)) < 1e-6)
  assert.ok(Math.abs((byKey.get('2026Q2')?.netProfit ?? 0) - (5292682830.65 - 2001108276.43)) < 1e-6)
  // 年报重述回撤：2025Q4 单季为负（真实脏数据）
  assert.ok(Math.abs((byKey.get('2025Q4')?.income ?? 0) - (30114958327.31 - 31029585021.56)) < 1e-6)
  assert.ok((byKey.get('2025Q4')?.income ?? 0) < 0)
  // 2024Q2 缺上季（2024Q1 不在样本里）：整条被丢弃
  assert.equal(byKey.has('2024Q2'), false)
})

test('computeSingleQuarters：逐字段独立降级（上季累计字段缺失只废对应字段）', () => {
  const cums: Quarter[] = [
    { year: 2026, quarter: 2, periodEndMs: 200, income: 300, netProfit: 30 },
    { year: 2026, quarter: 1, periodEndMs: 100, income: 100 }, // netProfit 缺失
  ]
  const singles = computeSingleQuarters(cums)
  // Q2 的 netProfit 因上季缺失降级；Q1 自身是合法单季（income 有、netProfit 无）
  assert.equal(singles.length, 2)
  assert.equal(singles[0].income, 200)
  assert.equal(singles[0].netProfit, undefined)
  assert.equal(singles[1].income, 100)
  assert.equal(singles[1].netProfit, undefined)
})

function baseResult(over: Partial<FundamentalsResult>): FundamentalsResult {
  return {
    symbol: 'sz002128',
    name: '',
    valuationTime: '',
    quarters: [],
    fund: false,
    valuationError: null,
    financialsError: null,
    ...over,
  }
}

test('renderFundamentalsText：估值行 + 近4季单季 + 同比环比（实测口径）', () => {
  const text = renderFundamentalsText(
    baseResult({
      name: '电投能源',
      pe: 12.287115,
      pb: 1.665453,
      valuationTime: '2026-09-07 15:14:36',
      quarters: computeSingleQuarters(parseIncomeStatements(SAMPLE_002128.data)),
    }),
  )
  assert.ok(text.startsWith('## 基本面 · 电投能源（sz002128）'))
  assert.ok(text.includes('- 估值：PE(TTM) 12.29 / PB(MRQ) 1.67（fuyao 2026-09-07 15:14:36）'))
  // 期望串由实测样本独立计算（python）固化
  assert.ok(text.includes('2026Q2：营收 155.1亿（同比 +25.0%｜环比 +84.3%）；归母净利 32.9亿（同比 +65.4%｜环比 +64.5%）'))
  assert.ok(text.includes('2026Q1：营收 84.1亿（同比 +11.6%｜环比 扭亏为盈）；归母净利 20.0亿（同比 +28.4%｜环比 +2902.6%）'))
  assert.ok(text.includes('2025Q4：营收 -9.1亿（同比 -111.4%｜环比 -108.2%）；归母净利 0.7亿（同比 -92.9%｜环比 -96.3%）'))
  assert.ok(text.includes('2025Q3：营收 110.9亿（同比 +44.3%｜环比 -10.6%）；归母净利 18.0亿（同比 +23.9%｜环比 -9.4%）'))
  // 只展示最新 4 个单季
  assert.ok(!text.includes('2025Q2：'))
  assert.ok(!text.includes('⚠️'))
})

test('renderFundamentalsText：亏损收窄/扩大口径词', () => {
  const quarters: Quarter[] = [
    { year: 2026, quarter: 2, periodEndMs: 200, income: -100, netProfit: -100 },
    { year: 2026, quarter: 1, periodEndMs: 100, income: -300, netProfit: -50 },
  ]
  const text = renderFundamentalsText(baseResult({ quarters }))
  assert.ok(text.includes('2026Q2：营收 -0.0亿（同比 —｜环比 亏损收窄）；归母净利 -0.0亿（同比 —｜环比 亏损扩大）'))
})

test('renderFundamentalsText：估值/财务失败逐项 ⚠️，不外抛', () => {
  const text = renderFundamentalsText(
    baseResult({ valuationError: 'fuyao HTTP 429', financialsError: 'fuyao 业务错误 code=1002：Unknown thscode' }),
  )
  assert.ok(text.includes('- 估值：PE(TTM) — / PB(MRQ) —'))
  assert.ok(text.includes('- ⚠️ 估值不可用：fuyao HTTP 429'))
  assert.ok(text.includes('- ⚠️ 财务不可用：fuyao 业务错误 code=1002：Unknown thscode'))
})

test('renderFundamentalsText：基金直接说明无基本面', () => {
  const text = renderFundamentalsText(baseResult({ symbol: 'sh588000', fund: true }))
  assert.ok(text.includes('按基金/ETF 处理'))
  assert.ok(!text.includes('估值：'))
})

test('renderFundamentalsText：接口空返回（code=0 无 item）如实标注', () => {
  const text = renderFundamentalsText(baseResult({ quarters: parseIncomeStatements({}) }))
  assert.ok(text.includes('- ⚠️ 财务：接口未返回任何季度数据'))
})
