import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyReconcile,
  collectSellEvents,
  diffReconcile,
  reconcileToken,
  renderReconcileApplied,
  renderReconcilePreview,
  validateReconcileRows,
} from '../src/reconcile.ts'
import { HOLDINGS_HEADER, parseHoldingsDoc, renderHoldingsDoc, type Position } from '../src/holdings.ts'

function pos(code: string, shares: number, cost: number, name = ''): Position {
  return { code, name, shares, cost, sector: '', note: '' }
}

test('validateReconcileRows：合法行规范化、非法行报错', () => {
  const { valid, errors } = validateReconcileRows([
    { code: '600519', shares: 100, cost: 1700, name: ' 贵州茅台 ' },
    { code: 'sz300750', shares: 200.5, cost: 260 },
    { code: 'BAD', shares: 100, cost: 10 },
    { code: '000001', shares: 1000, cost: 0 },
    { code: '600519', shares: 300, cost: 1600 },
  ])
  assert.deepEqual(valid, [{ code: 'sh600519', name: '贵州茅台', shares: 100, cost: 1700 }])
  assert.equal(errors.length, 4)
  assert.ok(errors[0].includes('股数不合法'))
  assert.ok(errors[1].includes('代码不合法'))
  assert.ok(errors[2].includes('成本不合法'))
  assert.ok(errors[3].includes('重复'))
})

test('diffReconcile：新增/更新/一致/缺失四分类，成本按 4 位小数容差', () => {
  const local = [pos('sh600519', 100, 1700, '茅台'), pos('sz300750', 200, 260, '宁德'), pos('sh510880', 1000, 1.02)]
  const { valid } = validateReconcileRows([
    { code: 'sh600519', shares: 100, cost: 1700 },           // 一致
    { code: 'sz300750', shares: 300, cost: 273.333 },        // 股数+成本都变
    { code: 'sh600036', shares: 500, cost: 38.5 },           // 新增
    { code: 'sh510880', shares: 1000, cost: 1.0200 },        // 1.02 vs 1.0200 视为一致
  ])
  const diff = diffReconcile(valid, local)
  assert.deepEqual(diff.unchanged.map(r => r.code), ['sh600519', 'sh510880'])
  assert.deepEqual(diff.updated.map(u => u.row.code), ['sz300750'])
  assert.equal(diff.updated[0].local.shares, 200)
  assert.deepEqual(diff.added.map(r => r.code), ['sh600036'])
  // 510880 在外部列表里，不算 missing；只有本地独有才算
  assert.deepEqual(diff.missing.map(p => p.code), [])
})

test('diffReconcile：本地独有的持仓进 missing', () => {
  const local = [pos('sh600519', 100, 1700), pos('sz300750', 200, 260)]
  const { valid } = validateReconcileRows([{ code: '600519', shares: 100, cost: 1700 }])
  const diff = diffReconcile(valid, local)
  assert.deepEqual(diff.missing.map(p => p.code), ['sz300750'])
})

test('reconcileToken：绑定行集与持仓文件，任一变化即失效', () => {
  const { valid } = validateReconcileRows([{ code: '600519', shares: 100, cost: 1700 }])
  const csv = [HOLDINGS_HEADER, '600519,贵州茅台,100,1700,白酒,'].join('\n')
  const t0 = reconcileToken(valid, csv)
  assert.equal(reconcileToken(valid, csv), t0) // 确定性
  const { valid: other } = validateReconcileRows([{ code: '600519', shares: 200, cost: 1700 }])
  assert.notEqual(reconcileToken(other, csv), t0) // 行集变化
  assert.notEqual(reconcileToken(valid, csv + '\n# 手改了一行'), t0) // 持仓文件变化
})

test('applyReconcile：覆盖写 + 注释保留；missing 默认保留、removeMissing 才清仓', () => {
  const csv = ['# 底仓注释', HOLDINGS_HEADER, '600519,贵州茅台,100,1700,白酒,', '300750,宁德时代,200,260,电池,'].join('\n')
  const doc = parseHoldingsDoc(csv)
  const { valid } = validateReconcileRows([
    { code: '600519', shares: 100, cost: 1700 },
    { code: '300750', shares: 300, cost: 273.333, name: '宁德时代' },
  ])
  const diff = diffReconcile(valid, doc.positions)

  const kept = applyReconcile(doc, diff, false)
  const keptText = renderHoldingsDoc(kept.doc)
  assert.ok(keptText.includes('# 底仓注释')) // 文档模型：注释逐字保留
  assert.ok(keptText.includes('sz300750,宁德时代,300,273.333,电池,'))
  assert.deepEqual(kept.removed, [])

  // 无 missing 的场景之外再验证 removeMissing：外部只给 600519，300750 成 missing
  const { valid: onlyOne } = validateReconcileRows([{ code: '600519', shares: 100, cost: 1700 }])
  const diff2 = diffReconcile(onlyOne, doc.positions)
  const purged = applyReconcile(doc, diff2, true)
  const purgedText = renderHoldingsDoc(purged.doc)
  assert.ok(!purgedText.includes('sz300750'))
  assert.ok(purgedText.includes('# 底仓注释'))
  assert.deepEqual(purged.removed.map(p => p.code), ['sz300750'])
})

test('renderReconcileApplied：差异表与写入结果文本', () => {
  const local = [pos('sh600519', 100, 1700, '茅台'), pos('sz300750', 200, 260)]
  const { valid } = validateReconcileRows([
    { code: 'sh600519', shares: 100, cost: 1700 },
    { code: 'sh600036', shares: 500, cost: 38.5, name: '招商银行' },
  ])
  const diff = diffReconcile(valid, local)
  const preview = renderReconcilePreview(diff, 'abc123def4567890')
  assert.ok(preview.includes('| 代码 | 名称 | 对比 | 股数 | 成本 |'))
  assert.ok(preview.includes('🆕 新增'))
  assert.ok(preview.includes('⚠️ 截图未出现'))
  assert.ok(preview.includes('默认保留'))
  assert.ok(preview.includes('`abc123def4567890`'))

  const applied = renderReconcileApplied(diff, [], '/tmp/holdings.csv')
  assert.ok(applied.includes('新增：sh600036 招商银行 500 股 @ 38.5'))
  assert.ok(applied.includes('持仓表已更新：/tmp/holdings.csv'))
  // 补记的卖出流水在写入结果里逐笔可见
  const withSells = renderReconcileApplied(diff, [], '/tmp/holdings.csv', [
    { code: 'sz159883', name: '医疗器械ETF', shares: 10000, reason: '清仓', price: 0.5, pnl: 230 },
    { code: 'sh600522', name: '中天科技', shares: 500, reason: '减仓', price: null, pnl: null },
  ])
  assert.ok(withSells.includes('卖出流水已补记：sz159883 医疗器械ETF 清仓 10000 股 @ 行情 0.5（已实现 +230.00 元）'))
  assert.ok(withSells.includes('卖出流水已补记：sh600522 中天科技 减仓 500 股 @ 行情 —（盈亏待补（未取到行情价））'))
})

test('collectSellEvents：removeMissing 才记清仓；减仓按股数差记，加仓/一致不记', () => {
  const local = [
    pos('sh600519', 100, 1700, '茅台'),   // 一致
    pos('sz300750', 300, 260, '宁德'),    // 减仓 → 200
    pos('sh510880', 1000, 2.683, '红利'), // 清仓（missing）
    pos('sh600036', 100, 38.5),           // 加仓 → 300
  ]
  const { valid } = validateReconcileRows([
    { code: 'sh600519', shares: 100, cost: 1700 },
    { code: 'sz300750', shares: 200, cost: 260 },
    { code: 'sh600036', shares: 300, cost: 38.5 },
  ])
  const diff = diffReconcile(valid, local)

  // 未确认清仓：只记减仓
  assert.deepEqual(collectSellEvents(diff, false), [
    { code: 'sz300750', name: '宁德', shares: 100, cost: 260, reason: '减仓' },
  ])
  // 确认清仓后：missing 全记 + 减仓
  const events = collectSellEvents(diff, true)
  assert.deepEqual(events, [
    { code: 'sh510880', name: '红利', shares: 1000, cost: 2.683, reason: '清仓' },
    { code: 'sz300750', name: '宁德', shares: 100, cost: 260, reason: '减仓' },
  ])
})

test('renderReconcilePreview：有清仓/减仓时预告会补记卖出流水', () => {
  const local = [pos('sh510880', 1000, 2.683, '红利'), pos('sz300750', 300, 260)]
  // 场景一：missing（可能清仓）
  const { valid: onlyOne } = validateReconcileRows([{ code: 'sz300750', shares: 300, cost: 260 }])
  assert.ok(renderReconcilePreview(diffReconcile(onlyOne, local), 't').includes('自动为清仓/减仓'))
  // 场景二：减仓
  const { valid: reduced } = validateReconcileRows([{ code: 'sz300750', shares: 100, cost: 260 }, { code: 'sh510880', shares: 1000, cost: 2.683 }])
  assert.ok(renderReconcilePreview(diffReconcile(reduced, local), 't').includes('自动为清仓/减仓'))
  // 场景三：只有新增/一致 → 不预告
  const { valid: added } = validateReconcileRows([{ code: 'sh600036', shares: 500, cost: 38.5 }, { code: 'sh510880', shares: 1000, cost: 2.683 }])
  const addedDiff = diffReconcile(added, [pos('sh510880', 1000, 2.683)])
  assert.ok(!renderReconcilePreview(addedDiff, 't').includes('自动为清仓/减仓'))
})
