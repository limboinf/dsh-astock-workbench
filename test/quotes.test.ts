import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyValuations,
  fetchQuotes,
  formatQuoteTime,
  formatShanghaiTime,
  normalizeSymbol,
  parseFuyaoSnapshot,
  parseTencentResponse,
  toThscode,
} from '../src/quotes.ts'

// 2026-09-03 从 qt.gtimg.cn 实抓的样本（截取）
const FIXTURE = [
  'v_sh600519="1~贵州茅台~600519~1298.88~1297.50~1297.50~17748~8284~9464~1298.71~4~1298.62~2~1298.60~14~1298.56~18~1298.42~2~1298.88~298~1298.89~1~1298.99~2~1299.00~6~1299.19~1~~20260903161447~1.38~0.11~1305.00~1293.02~1298.88/17748/2305193119~17748~230519~0.14~19.94~~1305.00~1293.02~0.92~16237.06~16237.06~6.46~1427.25~1167.75~0.76~-268~1298.87~18.24~19.72~~~0.10~230519.3119~207.8208~16~   A~GP-A~-3.73~0.51~4.01~32.41~27.30~1539.98~1151.01~0.57~-0.74~4.09~1250081601~1250081601~-77.01~-4.93~1250081601~~~-9.08~-0.09~~CNY~0~___D__F__N~1298.41~9~";',
  'v_sz000001="51~平安银行~000001~11.88~11.91~11.88~1105134~574216~530918~11.88~423~11.87~978~11.86~901~11.85~6032~11.84~944~11.89~5346~11.90~3320~11.91~1924~11.92~1215~11.93~2117~~20260903161424~-0.03~-0.25~12.08~11.83~11.88/1105134/1324230286~1105134~132423~0.57~5.30~~12.08~11.83~2.10~2305.40~2305.42~0.49~13.10~10.72~1.08~-4644~11.98~4.49~5.41~~~0.19~132423.0286~79.7148~671~   A~GP-A~7.51~2.50~5.02~7.93~0.72~12.08~9.99~4.21~5.41~8.39~19405684991~19405918198~-20.02~6.45~19405684991~~~6.51~0.08~~CNY~0~~11.80~4498~";',
  'v_sz300750="51~宁德时代~300750~349.50~348.29~349.99~262864~143147~119717~349.50~199~349.49~84~349.48~459~349.47~1~349.46~1~349.51~2~349.52~3~349.53~2~349.54~3~349.55~8~~20260903161439~1.21~0.35~354.80~348.10~349.50/262864/9235577474~262864~923558~0.62~19.02~~354.80~348.10~1.92~14888.98~16170.16~4.34~417.95~278.63~1.06~726~351.34~18.68~22.40~~~1.09~923557.7474~118.8300~34~ A A~GP-A-CYB~-2.63~-6.30~2.35~22.41~8.03~467.35~291.51~-9.22~-9.60~-9.71~4260081019~4626654919~95.28~-9.03~4260081019~~~16.23~0.03~~CNY~0~~349.58~-76~";',
].join('\n')

test('normalizeSymbol：纯数字自动补前缀', () => {
  assert.equal(normalizeSymbol('600519'), 'sh600519')
  assert.equal(normalizeSymbol('000001'), 'sz000001')
  assert.equal(normalizeSymbol('300750'), 'sz300750')
  assert.equal(normalizeSymbol('830799'), 'bj830799')
  assert.equal(normalizeSymbol('SH600519'), 'sh600519')
  assert.equal(normalizeSymbol('  sz000001 '), 'sz000001')
})

test('normalizeSymbol：非法输入抛错', () => {
  assert.throws(() => normalizeSymbol('AAPL'))
  assert.throws(() => normalizeSymbol('12345'))
})

test('parseTencentResponse：解析实抓样本', () => {
  const quotes = parseTencentResponse(FIXTURE)
  assert.equal(quotes.size, 3)

  const mt = quotes.get('sh600519')!
  assert.equal(mt.name, '贵州茅台')
  assert.equal(mt.price, 1298.88)
  assert.equal(mt.prevClose, 1297.5)
  assert.equal(mt.changePct, 0.11)
  assert.equal(mt.high, 1305.0)
  assert.equal(mt.low, 1293.02)
  assert.equal(mt.pe, 19.94)
  assert.equal(mt.pb, 6.46)
  assert.equal(mt.turnoverPct, 0.14)
  assert.equal(mt.totalMvYi, 16237.06)
  assert.equal(mt.time, '20260903161447')

  const pa = quotes.get('sz000001')!
  assert.equal(pa.name, '平安银行')
  assert.equal(pa.changePct, -0.25)
})

test('parseTencentResponse：坏行跳过不抛错', () => {
  const text = `${FIXTURE}\nv_baddx="garbage";\nv_sz000001="broken line"\n`
  const quotes = parseTencentResponse(text)
  // 坏行不影响其余解析
  assert.ok(quotes.has('sh600519'))
  assert.ok(quotes.has('sz300750'))
})

test('parseTencentResponse：空响应返回空 Map', () => {
  assert.equal(parseTencentResponse('').size, 0)
  assert.equal(parseTencentResponse('v_sz000001=""').size, 0)
})

test('fetchQuotes：外部取消信号已触发时立即中止，不等待超时', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(fetchQuotes(['600519'], { signal: ctrl.signal }))
})

// ---------- fuyao 主源（2026-09-04 实抓样本） ----------

// 沪市股票（全字段）；300750 为深市「有壳无价」样本（last_price=null，上游缺口）
const STOCK_SNAPSHOT = {
  timestamp: 1788481935000,
  total: 2,
  item: [
    {
      thscode: '600519.SH', ticker: '600519', volume: 1774765, turnover: 2305193100,
      last_price: 1298.88, price_change: 1.38, price_change_ratio_pct: 0.106358,
      open_price: 1297.5, high_price: 1305, low_price: 1293.02, prev_price: 1297.5,
    },
    {
      thscode: '300750.SZ', ticker: '300750', volume: 0, turnover: 0,
      last_price: null, price_change: null, price_change_ratio_pct: null,
      open_price: null, high_price: null, low_price: null, prev_price: 349.5,
    },
  ],
}

// 沪市 ETF（含 turnover_ratio_pct；深市 ETF 报 3002 不进解析层）
const FUND_SNAPSHOT = {
  timestamp: 1788481935000,
  item: [
    {
      thscode: '510880.SH', ticker: '510880', last_price: 3.436, open_price: 3.426,
      high_price: 3.483, low_price: 3.426, prev_price: 3.428,
      price_change: 0.008, price_change_ratio_pct: 0.233372,
      price_amplitude_ratio_pct: 1.662777, volume: 140828430, turnover: 486470850,
      turnover_ratio_pct: 0.5438,
    },
  ],
}

test('toThscode：规范化 symbol → fuyao thscode', () => {
  assert.equal(toThscode('sh600519'), '600519.SH')
  assert.equal(toThscode('300750'), '300750.SZ')
  assert.equal(toThscode('bj830799'), '830799.BJ')
})

test('parseFuyaoSnapshot：股票快照——单位换算与空价剔除', () => {
  const { quotes, time } = parseFuyaoSnapshot(STOCK_SNAPSHOT, false)
  assert.equal(quotes.size, 1) // 深市空价条目剔除，走腾讯兜底
  assert.equal(time, formatShanghaiTime(1788481935000))
  const mt = quotes.get('sh600519')!
  assert.equal(mt.name, '') // 快照不带名称
  assert.equal(mt.price, 1298.88)
  assert.equal(mt.prevClose, 1297.5)
  assert.equal(mt.changePct, 0.106358)
  assert.equal(mt.volume, 17748) // 股 → 手：1774765/100 四舍五入
  assert.ok(Math.abs(mt.amountWan - 230519.31) < 0.01) // 元 → 万
  assert.equal(mt.turnoverPct, undefined) // 股票快照无换手
  assert.equal(mt.source, 'fuyao')
})

test('parseFuyaoSnapshot：ETF 快照——含换手率', () => {
  const { quotes } = parseFuyaoSnapshot(FUND_SNAPSHOT, true)
  const etf = quotes.get('sh510880')!
  assert.equal(etf.price, 3.436)
  assert.equal(etf.turnoverPct, 0.5438)
  assert.equal(etf.volume, 1408284) // 股 → 手
})

test('applyValuations：补名称/PE/PB', () => {
  const { quotes } = parseFuyaoSnapshot(STOCK_SNAPSHOT, false)
  applyValuations(quotes, {
    item: [{ thscode: '600519.SH', ticker: '600519', name: '贵州茅台', pe_ttm: 19.938923, pb_mrq: 6.462419 }],
  })
  const mt = quotes.get('sh600519')!
  assert.equal(mt.name, '贵州茅台')
  assert.equal(mt.pe, 19.938923)
  assert.equal(mt.pb, 6.462419)
})

test('formatShanghaiTime / formatQuoteTime：两种时间格式', () => {
  // 1788481935000 = 2026-09-04T00:32:15Z = 上海 2026-09-04 08:32:15（盘前）
  assert.equal(formatShanghaiTime(1788481935000), '2026-09-04 08:32:15')
  // 腾讯 14 位串转格式；已是可读格式则原样返回
  assert.equal(formatQuoteTime('20260903161447'), '2026-09-03 16:14:47')
  assert.equal(formatQuoteTime('2026-09-04 16:32:15'), '2026-09-04 16:32:15')
})
