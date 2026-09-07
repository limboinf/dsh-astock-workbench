import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatEntryHeading,
  kindGroup,
  labelGroup,
  parseEntryHeading,
  sanitizeKind,
  sanitizeSummary,
  splitDayEntries,
  stripDayDate,
} from '../src/decision-entry.ts'

test('parseEntryHeading：新格式 [性质]+摘要、裸时间、无摘要', () => {
  assert.deepEqual(parseEntryHeading('## 10:52 [纪律] 退出纪律（700股 @ 29.01）'), {
    time: '10:52',
    kind: '纪律',
    title: '退出纪律（700股 @ 29.01）',
  })
  assert.deepEqual(parseEntryHeading('## 11:04 [计划]加仓计划'), { time: '11:04', kind: '计划', title: '加仓计划' })
  // 老日志只有时间（2026-09-04 原文如此）
  assert.deepEqual(parseEntryHeading('## 10:59'), { time: '10:59', kind: '', title: '' })
  assert.equal(parseEntryHeading('# 2026-09-07 电投能源'), null)
  assert.equal(parseEntryHeading('正文一行'), null)
})

test('formatEntryHeading 与 parseEntryHeading 互逆', () => {
  const line = formatEntryHeading('11:04', '计划', '28元×3手=300股，未成交')
  assert.equal(line, '## 11:04 [计划] 28元×3手=300股，未成交')
  assert.deepEqual(parseEntryHeading(line), { time: '11:04', kind: '计划', title: '28元×3手=300股，未成交' })
  assert.equal(formatEntryHeading('10:59', '', ''), '## 10:59')
})

test('splitDayEntries：墙文按已知标签切段（2026-09-07 11:04 原文）', () => {
  const body = [
    '## 11:04 加仓计划（28元×3手=300股，未成交）',
    '',
    '决策：可以加，但要拆单、别追。理由：2026H1 归母净利52.9亿≈2025全年54.2亿，业绩快于股价、不贵；今日跌3.5%是红利风格被抽血，非个股恶化。执行：1手挂28、2手挂贴近MA20(27.94)下方27.6~27.8；收盘跌破27.94则作废观望。效果：成本29.01→约28.7，权重6.6%→约9%，加完即止。',
  ].join('\n')
  const entries = splitDayEntries(body)
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].blocks.map(b => b.label), ['决策', '理由', '执行', '效果'])
  assert.equal(entries[0].blocks[0].text, '可以加，但要拆单、别追。')
  assert.ok(entries[0].blocks[1].text.startsWith('2026H1 归母净利'))
  assert.ok(entries[0].blocks[2].text.endsWith('则作废观望。'))
  assert.equal(entries[0].blocks[3].text, '成本29.01→约28.7，权重6.6%→约9%，加完即止。')
})

test('splitDayEntries：普通冒号不误切（2026-09-07 10:52 原文）', () => {
  const body = [
    '## 10:52 退出纪律（700股 @ 29.01）',
    '',
    '机械执行不恋战：浮盈 +2%（约29.6）清仓；浮亏 -5%（约27.6）割肉。触发后同步持仓表并备注。',
  ].join('\n')
  const entries = splitDayEntries(body)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].blocks.length, 1)
  assert.equal(entries[0].blocks[0].label, '')
  assert.ok(entries[0].blocks[0].text.startsWith('机械执行不恋战：'))
})

test('splitDayEntries：行首【标签】风格（2026-09-04 10:59 原文）', () => {
  const body = [
    '## 10:59',
    '',
    '【买入记录】盘中以62元买入1手（100股），与原有持仓合并后现持200股/加权成本63.03。',
    '',
    '【事后复盘·教训】买入时只看到价格回落到62整数关口附近、觉得便宜。',
    '',
    '【复核条件】①今日收盘能否收在62上方；②是否继续放量跌破今日低点。',
  ].join('\n')
  const entries = splitDayEntries(body)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].time, '10:59')
  assert.equal(entries[0].title, '')
  assert.deepEqual(entries[0].blocks.map(b => b.label), ['买入记录', '事后复盘·教训', '复核条件'])
  assert.deepEqual(entries[0].blocks.map(b => labelGroup(b.label)), ['red', 'violet', 'teal'])
})

test('splitDayEntries：行首「标签：」+ 列表 + 尾注（2026-09-04 14:44 原文）', () => {
  const body = [
    '## 14:44',
    '',
    '操作：31.58 加仓中天科技 300 股（3 手），现持仓 1000 股，加权成本 43.50（原 700 股 @ 48.61）。',
    '观察与依据：今日中天科技 -4.0%，明显跑输大盘。',
    '本次加仓实质是摊低成本，把最弱的一只从 7.6% 提到约 10.5% 仓位。',
    '风险：在弱势股下跌途中加码，存在「越跌越买越套」风险。',
    '复核条件（止损/加仓纪律）：',
    '- 减：跌破今日低点 31.54 且收不回，先减掉本次加的 3 手止损。',
    '- 判断错误位：跌至 28 附近仍未止跌，无条件减仓离场。',
    '- 加：放量收回昨收 32.91 上方，才考虑小仓位试补。',
    '',
    '注：日 K 历史接口本次未取到有效数据，价位为实时行情粗略参考。',
  ].join('\n')
  const entries = splitDayEntries(body)
  assert.equal(entries.length, 1)
  const blocks = entries[0].blocks
  assert.deepEqual(blocks.map(b => b.label), ['操作', '观察与依据', '', '风险', '复核条件（止损/加仓纪律）', '注'])
  assert.deepEqual(blocks[4].items, [
    '减：跌破今日低点 31.54 且收不回，先减掉本次加的 3 手止损。',
    '判断错误位：跌至 28 附近仍未止跌，无条件减仓离场。',
    '加：放量收回昨收 32.91 上方，才考虑小仓位试补。',
  ])
  assert.equal(blocks[4].text, '')
  // 括注并入标签、不进正文；着色仍按主干词
  assert.equal(blocks[4].label, '复核条件（止损/加仓纪律）')
  assert.equal(labelGroup(blocks[4].label), 'teal')
  // 列表后的空行断块，注 自成一块（注 被识别为标签，正文不带前缀）
  assert.equal(blocks[5].label, '注')
  assert.equal(blocks[5].text, '日 K 历史接口本次未取到有效数据，价位为实时行情粗略参考。')
})

test('splitDayEntries：多条目分天结构 + 【标签】列表混排（2026-09-04 14:36 原文）', () => {
  const body = [
    '## 14:36',
    '',
    '【加仓记录】59.70 元再加两手（200股），现持 400股/加权成本 61.36。',
    '【我的判断】基本面没有问题；这次买入自己清楚是在"接刀子"，接受这一性质。',
    '【止损纪律】股价跌到 50 元即认亏、割肉离场。',
    '【风险】①接刀子不断加大敞口；②"越跌越买"依赖基本面判断正确；③防止"舍不得"而不执行。',
    '【复核条件】',
    '- 是否跌破 50 元（触发离场纪律）',
    '- 基本面是否出现恶化迹象',
  ].join('\n')
  const entries = splitDayEntries(body)
  assert.equal(entries.length, 1)
  const blocks = entries[0].blocks
  assert.deepEqual(blocks.map(b => b.label), ['加仓记录', '我的判断', '止损纪律', '风险', '复核条件'])
  assert.deepEqual(blocks[4].items, ['是否跌破 50 元（触发离场纪律）', '基本面是否出现恶化迹象'])
})

test('splitDayEntries：同标签相邻行合并、空行分块', () => {
  const body = [
    '## 09:00 测试',
    '',
    '【风险】第一行。',
    '【风险】第二行。',
    '',
    '【风险】空行后另起一块。',
  ].join('\n')
  const entries = splitDayEntries(body)
  const blocks = entries[0].blocks
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, '第一行。\n第二行。')
  assert.equal(blocks[1].text, '空行后另起一块。')
})

test('splitDayEntries：老标题行新格式混排互不影响', () => {
  const body = [
    '## 10:52 退出纪律',
    '',
    '机械执行不恋战。',
    '',
    '## 11:04 [计划] 加仓计划',
    '',
    '【决策】可以加。',
  ].join('\n')
  const entries = splitDayEntries(body)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map(e => e.kind), ['', '计划'])
  assert.deepEqual(entries.map(e => e.title), ['退出纪律', '加仓计划'])
})

test('kindGroup：红买绿卖等 A股语义映射', () => {
  assert.equal(kindGroup('买入'), 'red')
  assert.equal(kindGroup('加仓'), 'red')
  assert.equal(kindGroup('卖出'), 'green')
  assert.equal(kindGroup('清仓'), 'green')
  assert.equal(kindGroup('计划'), 'blue')
  assert.equal(kindGroup('观察'), 'blue')
  assert.equal(kindGroup('纪律'), 'orange')
  assert.equal(kindGroup('复盘'), 'violet')
  assert.equal(kindGroup('自定义'), 'plain')
})

test('labelGroup：主干词匹配、括注不参与、未知归 plain', () => {
  assert.equal(labelGroup('复核条件'), 'teal')
  assert.equal(labelGroup('复核条件（止损/加仓纪律）'), 'teal')
  assert.equal(labelGroup('事后复盘·教训'), 'violet')
  assert.equal(labelGroup('买入记录'), 'red')
  assert.equal(labelGroup('注'), 'plain')
  assert.equal(labelGroup('自造标签'), 'plain')
})

test('sanitizeKind / sanitizeSummary：防模型塞自由文本', () => {
  assert.equal(sanitizeKind(' [计划] '), '计划')
  assert.equal(sanitizeKind('【买入】'), '买入')
  assert.equal(sanitizeKind('复盘 '), '复盘')
  assert.equal(sanitizeKind(''), '')
  assert.equal(sanitizeSummary('成本\n 29.01 →  约28.7'), '成本 29.01 → 约28.7')
  assert.equal(sanitizeSummary('x'.repeat(100)).length, 60)
})

test('stripDayDate：折叠行去掉与日期徽标重复的前缀', () => {
  assert.equal(stripDayDate('2026-09-07 电投能源(002128)', '2026-09-07'), '电投能源(002128)')
  assert.equal(stripDayDate('2026-09-04 国瓷材料300285：62元买入1手（买入后复盘）', '2026-09-04'), '国瓷材料300285：62元买入1手（买入后复盘）')
  // 新写入不带日期前缀时原样返回
  assert.equal(stripDayDate('电投能源(002128)', '2026-09-07'), '电投能源(002128)')
  // 标题只有日期本身时不至于删空
  assert.equal(stripDayDate('2026-09-07', '2026-09-07'), '2026-09-07')
})
