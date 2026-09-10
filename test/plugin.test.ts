import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { decodeHtmlPreviewTag } from '../src/dto.ts'
import { HOLDINGS_HEADER, parseHoldingsCsv } from '../src/holdings.ts'

interface Registered {
  tools: Array<{ name: string; execute: (args: any, exec?: unknown) => Promise<unknown> }>
  commands: Array<{ name: string; handler: () => Promise<{ kind: string; text?: string }> }>
}

function setupWithData(csv: string): { reg: Registered; dataDir: string; restore: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'astock-test-'))
  writeFileSync(join(dataDir, 'holdings.csv'), csv, 'utf8')
  const prev = process.env.ASTOCK_DATA_DIR
  process.env.ASTOCK_DATA_DIR = dataDir
  const tools: Registered['tools'] = []
  const commands: Registered['commands'] = []
  const ctx = {
    tools: { register: (d: any) => void tools.push(d) },
    commands: { register: (c: any) => void commands.push(c) },
    logger: { info() {}, warn() {}, error() {} },
  }
  apply(ctx as any)
  return {
    reg: { tools, commands },
    dataDir,
    restore: () => {
      if (prev === undefined) delete process.env.ASTOCK_DATA_DIR
      else process.env.ASTOCK_DATA_DIR = prev
    },
  }
}

const SEED = [HOLDINGS_HEADER, '600519,贵州茅台,100,1700,白酒,', '300750,宁德时代,200,260,电池,'].join('\n')

test('apply：注册 14 个工具和 4 个命令', () => {
  const { reg, restore } = setupWithData(SEED)
  try {
    assert.deepEqual(
      reg.tools.map(t => t.name).sort(),
      ['astock_add_position', 'astock_analyze', 'astock_decision_logs', 'astock_fundamentals', 'astock_log_decision', 'astock_positions', 'astock_quote', 'astock_reconcile', 'astock_record_trade', 'astock_remove_position', 'astock_set_cash', 'astock_set_total_assets', 'astock_show_html', 'astock_trades'],
    )
    assert.deepEqual(reg.commands.map(c => c.name).sort(), ['decision-logs', 'market', 'portfolio', 'profile'])
  } finally {
    restore()
  }
})

test('apply：启动即自举数据目录与模板', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'astock-boot-'))
  const prev = process.env.ASTOCK_DATA_DIR
  process.env.ASTOCK_DATA_DIR = dataDir
  try {
    apply({ tools: { register() {} }, commands: { register() {} } } as any)
    assert.ok(existsSync(join(dataDir, 'holdings.csv')))
    assert.ok(readFileSync(join(dataDir, 'holdings.csv'), 'utf8').includes(HOLDINGS_HEADER))
  } finally {
    process.env.ASTOCK_DATA_DIR = prev === undefined ? '' : prev
    if (prev === undefined) delete process.env.ASTOCK_DATA_DIR
  }
})

test('astock_positions：离线也能给出成本口径汇总', async () => {
  const { reg, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_positions')!
    const text = (await tool.execute({})) as string
    assert.ok(text.includes('持仓概览'))
    assert.ok(text.includes('sh600519'))
    assert.ok(text.includes('总市值'))
  } finally {
    restore()
  }
})

test('astock_add_position：同代码加权合并成本并写回', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_add_position')!
    const text = (await tool.execute({ code: '300750', shares: 100, cost: 300 })) as string
    assert.ok(text.includes('已记账'))
    const { positions } = parseHoldingsCsv(readFileSync(join(dataDir, 'holdings.csv'), 'utf8'))
    const cat = positions.find(p => p.code === 'sz300750')!
    assert.equal(cat.shares, 300)
    assert.equal(cat.cost, 273.333) // (200×260 + 100×300) / 300
  } finally {
    restore()
  }
})

test('astock_remove_position：移除不存在的代码不动文件', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_remove_position')!
    const text = (await tool.execute({ code: '600000' })) as string
    assert.ok(text.includes('没有'))
    assert.equal(parseHoldingsCsv(readFileSync(join(dataDir, 'holdings.csv'), 'utf8')).positions.length, 2)
  } finally {
    restore()
  }
})

test('astock_add_position：注释行写回后原样保留', async () => {
  const csv = ['# 手写备注：打新底仓别动', HOLDINGS_HEADER, '600519,贵州茅台,100,1700,白酒,'].join('\n') + '\n'
  const { reg, dataDir, restore } = setupWithData(csv)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_add_position')!
    await tool.execute({ code: '600519', shares: 100, cost: 1300 })
    const after = readFileSync(join(dataDir, 'holdings.csv'), 'utf8')
    assert.ok(after.includes('# 手写备注：打新底仓别动'))
    assert.ok(after.includes('sh600519,贵州茅台,200,1500,白酒,'))
  } finally {
    restore()
  }
})

test('astock_add_position：持仓表有坏行时拒绝写入（防止覆盖丢数据）', async () => {
  const csv = [HOLDINGS_HEADER, 'BADCODE,x,1,1,,', '600519,贵州茅台,100,1700,白酒,'].join('\n')
  const { reg, dataDir, restore } = setupWithData(csv)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_add_position')!
    const text = String(await tool.execute({ code: '000001', shares: 100, cost: 10 }))
    assert.ok(text.includes('未写入'))
    assert.equal(readFileSync(join(dataDir, 'holdings.csv'), 'utf8'), csv)
  } finally {
    restore()
  }
})

test('astock_remove_position：清仓时注释行保留', async () => {
  const csv = ['# 底仓', HOLDINGS_HEADER, '600519,贵州茅台,100,1700,白酒,'].join('\n') + '\n'
  const { reg, dataDir, restore } = setupWithData(csv)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_remove_position')!
    await tool.execute({ code: '600519' })
    const after = readFileSync(join(dataDir, 'holdings.csv'), 'utf8')
    assert.ok(after.includes('# 底仓'))
    assert.ok(!after.includes('sh600519,'))
  } finally {
    restore()
  }
})

test('portfolio 命令：返回 success 与汇总文本', async () => {
  const { reg, restore } = setupWithData(SEED)
  try {
    const result = await reg.commands[0].handler()
    assert.equal(result.kind, 'success')
    assert.ok(result.text?.includes('持仓概览'))
  } finally {
    restore()
  }
})

test('决策日志：按日期追加并读取', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const writeTool = reg.tools.find(t => t.name === 'astock_log_decision')!
    const readTool = reg.tools.find(t => t.name === 'astock_decision_logs')!
    await writeTool.execute({ date: '2026-09-03', content: '观察：能源板块强势\n决策：继续持有' })
    await writeTool.execute({ date: '2026-09-03', content: '风险：成交量未确认' })
    const text = String(await readTool.execute({ date: '2026-09-03' }))
    assert.ok(text.includes('### 2026-09-03'))
    assert.ok(text.includes('继续持有'))
    assert.ok(text.includes('成交量未确认'))
    assert.ok(existsSync(join(dataDir, 'decision-logs', '2026-09-03.md')))
  } finally {
    restore()
  }
})

test('decision-logs 命令：免对话直读本地决策日志', async () => {
  const { reg, restore } = setupWithData(SEED)
  try {
    const writeTool = reg.tools.find(t => t.name === 'astock_log_decision')!
    await writeTool.execute({ date: '2026-09-03', content: '观察：能源板块强势' })
    const cmd = reg.commands.find(c => c.name === 'decision-logs')!
    const result = await cmd.handler()
    assert.equal(result.kind, 'success')
    assert.ok(result.text?.includes('### 2026-09-03'))
    assert.ok(result.text?.includes('能源板块强势'))
  } finally {
    restore()
  }
})

test('astock_set_total_assets：写入 balance.json 并在汇总中显示', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const setTool = reg.tools.find(t => t.name === 'astock_set_total_assets')!
    const text = String(await setTool.execute({ totalAssets: 528306.88, date: '2026-09-03' }))
    assert.ok(text.includes('528,306.88'))
    assert.ok(existsSync(join(dataDir, 'balance.json')))
    const posTool = reg.tools.find(t => t.name === 'astock_positions')!
    const posText = String(await posTool.execute({}))
    assert.ok(posText.includes('手动总资产：528,306.88 元（截至 2026-09-03）'))
  } finally {
    restore()
  }
})

test('astock_set_cash：现金口径取代快照并在汇总中显示', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const setTotal = reg.tools.find(t => t.name === 'astock_set_total_assets')!
    await setTotal.execute({ totalAssets: 528306.88, date: '2026-09-03' })
    const setCash = reg.tools.find(t => t.name === 'astock_set_cash')!
    const text = String(await setCash.execute({ cash: 50000, date: '2026-09-04' }))
    assert.ok(text.includes('50,000.00'))
    assert.ok(text.includes('自动口径'))
    // balance.json 整文件重写：只剩现金口径，快照被清除
    const raw = JSON.parse(readFileSync(join(dataDir, 'balance.json'), 'utf8'))
    assert.equal(raw.cash, 50000)
    assert.equal(raw.totalAssets, undefined)
    const posTool = reg.tools.find(t => t.name === 'astock_positions')!
    const posText = String(await posTool.execute({}))
    assert.ok(posText.includes('总资产（持仓市值 + 现金）'))
    assert.ok(posText.includes('现金 50,000.00，截至 2026-09-04'))
    assert.ok(!posText.includes('手动总资产'))
  } finally {
    restore()
  }
})

test('astock_set_cash：负数与非法值拒绝写入', async () => {
  const { reg, restore } = setupWithData(SEED)
  try {
    const setCash = reg.tools.find(t => t.name === 'astock_set_cash')!
    await assert.rejects(() => setCash.execute({ cash: -1 }))
    await assert.rejects(() => setCash.execute({ cash: Number.NaN }))
    await assert.rejects(() => setCash.execute({ cash: 100, date: '2026/09/04' }))
  } finally {
    restore()
  }
})

test('astock_reconcile：两段式对账——预览发 token，确认后写入', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_reconcile')!
    const rows = [
      { code: '600519', shares: 100, cost: 1700 },            // 一致
      { code: '300750', shares: 300, cost: 273.333 },         // 更新
      { code: '600036', shares: 500, cost: 38.5 },            // 新增
    ]
    const before = readFileSync(join(dataDir, 'holdings.csv'), 'utf8')
    const preview = String(await tool.execute({ rows }))
    assert.ok(preview.includes('持仓对账（预览）'))
    assert.ok(preview.includes('✏️ 更新'))
    assert.ok(preview.includes('🆕 新增'))
    assert.equal(readFileSync(join(dataDir, 'holdings.csv'), 'utf8'), before) // 预览不写文件
    const token = /`([0-9a-f]{16})`/.exec(preview)![1]

    const applied = String(await tool.execute({ rows, token }))
    assert.ok(applied.includes('持仓对账（已写入）'))
    const { positions } = parseHoldingsCsv(readFileSync(join(dataDir, 'holdings.csv'), 'utf8'))
    assert.equal(positions.find(p => p.code === 'sz300750')?.shares, 300)
    assert.equal(positions.find(p => p.code === 'sz300750')?.cost, 273.333)
    assert.ok(positions.some(p => p.code === 'sh600036'))
  } finally {
    restore()
  }
})

test('astock_reconcile：token 防串写——行集或持仓表变化后拒绝', async () => {
  const { reg, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_reconcile')!
    const rows = [{ code: '600036', shares: 500, cost: 38.5 }]
    const preview = String(await tool.execute({ rows }))
    const token = /`([0-9a-f]{16})`/.exec(preview)![1]

    // 行集变了（哪怕 token 是新预览的）
    await assert.rejects(() => tool.execute({ rows: [{ code: '600036', shares: 600, cost: 38.5 }], token }))
    // 持仓表在预览与确认之间被别的工具写过 → 旧 token 失效
    const addTool = reg.tools.find(t => t.name === 'astock_add_position')!
    await addTool.execute({ code: '000001', shares: 100, cost: 10 })
    await assert.rejects(() => tool.execute({ rows, token }))
  } finally {
    restore()
  }
})

test('astock_reconcile：截图未出现的持仓默认保留，removeMissing 才清仓', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED) // 600519 + 300750
  try {
    const tool = reg.tools.find(t => t.name === 'astock_reconcile')!
    const rows = [{ code: '600519', shares: 100, cost: 1700 }]
    const preview = String(await tool.execute({ rows }))
    assert.ok(preview.includes('截图未出现'))
    assert.ok(preview.includes('默认保留'))
    const token = /`([0-9a-f]{16})`/.exec(preview)![1]

    const kept = String(await tool.execute({ rows, token }))
    assert.ok(!kept.includes('清仓移除'))
    assert.ok(parseHoldingsCsv(readFileSync(join(dataDir, 'holdings.csv'), 'utf8')).positions.some(p => p.code === 'sz300750'))

    // 重来一次，这次明确 removeMissing
    const preview2 = String(await tool.execute({ rows }))
    const token2 = /`([0-9a-f]{16})`/.exec(preview2)![1]
    const purged = String(await tool.execute({ rows, token: token2, removeMissing: true }))
    assert.ok(purged.includes('清仓移除：sz300750'))
    assert.ok(!parseHoldingsCsv(readFileSync(join(dataDir, 'holdings.csv'), 'utf8')).positions.some(p => p.code === 'sz300750'))
  } finally {
    restore()
  }
})

test('astock_reconcile：校验失败的行原样报错、不写文件', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_reconcile')!
    const before = readFileSync(join(dataDir, 'holdings.csv'), 'utf8')
    const text = String(await tool.execute({ rows: [{ code: 'BAD', shares: 100, cost: 10 }] }))
    assert.ok(text.includes('校验失败'))
    assert.equal(readFileSync(join(dataDir, 'holdings.csv'), 'utf8'), before)
  } finally {
    restore()
  }
})

test('astock_reconcile：完全一致时无需写入', async () => {
  const { reg, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_reconcile')!
    const rows = [
      { code: '600519', shares: 100, cost: 1700 },
      { code: '300750', shares: 200, cost: 260 },
    ]
    const text = String(await tool.execute({ rows }))
    assert.ok(text.includes('完全一致'))
    assert.ok(!text.includes('token'))
  } finally {
    restore()
  }
})

test('astock_remove_position：清仓自动补记卖出流水（显式成交价计盈亏）', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_remove_position')!
    const text = String(await tool.execute({ code: '600519', price: 1800 }))
    assert.ok(text.includes('已移除'))
    assert.ok(text.includes('已实现 +10,000.00 元')) // (1800 − 1700) × 100
    const tradesCsv = readFileSync(join(dataDir, 'trades.csv'), 'utf8')
    assert.ok(tradesCsv.includes('sh600519'))
    assert.ok(tradesCsv.includes(',sell,100,1800,1700,10000,'))
  } finally {
    restore()
  }
})

test('astock_record_trade + astock_trades：手动补录、成本缺省取持仓、统计全量', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const record = reg.tools.find(t => t.name === 'astock_record_trade')!
    // 减仓补录：cost 缺省 → 取持仓表 260；盈亏 = (273 − 260) × 100
    const text = String(await record.execute({ date: '2026-09-01', code: '300750', shares: 100, price: 273 }))
    assert.ok(text.includes('本笔已实现盈亏：+1,300.00 元'))
    assert.ok(text.includes('累计已实现盈亏：+1,300.00 元（卖出 1 笔，胜率 100.0%）'))
    // 买入补录：仅留档不进统计
    const buyText = String(await record.execute({ date: '2026-09-02', code: '510880', shares: 1000, price: 2.7, action: 'buy' }))
    assert.ok(buyText.includes('不计入已实现盈亏'))
    // 缺价格/成本的卖出：计入 skipped，不进合计
    const noPrice = String(await record.execute({ date: '2026-09-03', code: '600519', shares: 100, cost: 1700 }))
    assert.ok(noPrice.includes('暂不计入已实现盈亏统计'))

    const read = reg.tools.find(t => t.name === 'astock_trades')!
    const list = String(await read.execute({}))
    assert.ok(list.includes('| 2026-09-01 | sz300750 |'))
    assert.ok(list.includes('累计已实现盈亏：+1,300.00 元（卖出 1 笔，胜率 100.0%）'))
    assert.ok(list.includes('另有 1 笔卖出缺卖出价/成本'))
    // 按代码过滤：列表只剩该代码，统计仍是全量累计
    const filtered = String(await read.execute({ code: '300750' }))
    assert.ok(filtered.includes('sz300750'))
    assert.ok(!filtered.includes('sh600519'))
    assert.ok(filtered.includes('累计已实现盈亏：+1,300.00 元'))
    // 汇总输出带上已实现盈亏行
    const posTool = reg.tools.find(t => t.name === 'astock_positions')!
    const posText = String(await posTool.execute({}))
    assert.ok(posText.includes('已实现盈亏（卖出落袋）：+1,300.00 元（卖出 1 笔，胜率 100.0%）'))
    assert.ok(existsSync(join(dataDir, 'trades.csv')))
  } finally {
    restore()
  }
})

test('astock_reconcile：removeMissing 清仓与减仓都自动补记卖出流水', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED) // 600519 + 300750
  try {
    const tool = reg.tools.find(t => t.name === 'astock_reconcile')!
    // 600519 减仓到 50 股；300750 缺席 → removeMissing 清仓
    const rows = [{ code: '600519', shares: 50, cost: 1700 }]
    const preview = String(await tool.execute({ rows }))
    assert.ok(preview.includes('自动为清仓/减仓'))
    const token = /`([0-9a-f]{16})`/.exec(preview)![1]
    const applied = String(await tool.execute({ rows, token, removeMissing: true }))
    assert.ok(applied.includes('清仓移除：sz300750'))
    assert.ok(applied.includes('卖出流水已补记：sz300750'))
    assert.ok(applied.includes('卖出流水已补记：sh600519'))

    const tradesCsv = readFileSync(join(dataDir, 'trades.csv'), 'utf8')
    // 清仓 200 股 @ 本地成本 260；减仓 50 股 @ 本地成本 1700（价格来自行情，离线时留空）
    assert.ok(tradesCsv.includes(',sz300750,宁德时代,sell,200,'))
    assert.ok(tradesCsv.includes(',sh600519,贵州茅台,sell,50,'))
    assert.ok(tradesCsv.includes('对账自动补记（清仓）'))
    assert.ok(tradesCsv.includes('对账自动补记（减仓）'))
  } finally {
    restore()
  }
})

test('决策日志：非法日期拒绝写入', async () => {
  const { reg, restore } = setupWithData(SEED)
  try {
    const writeTool = reg.tools.find(t => t.name === 'astock_log_decision')!
    await assert.rejects(() => writeTool.execute({ date: '2026-02-30', content: 'x' }))
  } finally {
    restore()
  }
})

test('astock_show_html：存档 explainers/ 并捎回可解码的内嵌预览载荷', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_show_html')!
    // html 里故意带字面 `-->`（网页自身注释），证明 base64 载荷不会被注释定界符截断
    const html = '<!DOCTYPE html><html><body><h1>市盈率</h1><!-- 说明 --><script>1</script></body></html>'
    const text = (await tool.execute({ title: '市盈率 图解', html })) as string
    const preview = decodeHtmlPreviewTag(text)
    assert.notEqual(preview, null)
    assert.equal(preview!.title, '市盈率 图解')
    assert.equal(preview!.html, html)
    // 存档文件落盘且内容原样
    assert.ok(preview!.file.startsWith(join(dataDir, 'explainers') + '/'))
    assert.equal(readFileSync(preview!.file, 'utf8'), html)
  } finally {
    restore()
  }
})

test('astock_show_html：空 html 拒收、超大 html 拒收且不落盘', async () => {
  const { reg, dataDir, restore } = setupWithData(SEED)
  try {
    const tool = reg.tools.find(t => t.name === 'astock_show_html')!
    await assert.rejects(() => tool.execute({ title: 'x', html: '   ' }))
    await assert.rejects(() => tool.execute({ title: 'x', html: 'a'.repeat(200_001) }))
    const explainers = join(dataDir, 'explainers')
    if (existsSync(explainers)) {
      assert.equal(readdirSync(explainers).length, 0, '拒收后不应有存档文件')
    }
  } finally {
    restore()
  }
})
