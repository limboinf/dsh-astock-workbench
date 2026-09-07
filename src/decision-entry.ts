/**
 * 决策日志条目契约 —— 纯类型 + 纯函数、零 import（client 半面可直接 import，
 * 同 dto.ts / profile.ts 打法）。
 *
 * 落盘仍是追加式 Markdown（decision-log.ts，文档模型不变，可手工编辑），
 * 本模块只约定「一天之内」的条目结构、解析与规范化：
 *
 *   ## 10:52 [纪律] 退出纪律（700股 @ 29.01）   ← 时间 + 可选[性质] + 可选一句话摘要
 *   机械执行不恋战：…                            ← 无标签叙述，面板通栏渲染
 *
 *   ## 11:04 [计划] 加仓计划（28元×3手=300股，未成交）
 *   【决策】可以加，但要拆单、别追。              ← 每个维度一行，【标签】开头
 *   【复核条件】                                 ← 列表类标签可只写标签行
 *   - 收盘跌破 27.94 则作废观望                   ← 列表项一条一行，归属上方标签
 *
 * 历史写法兼容（老文件不动，解析端识别三种）：
 *   ① 行首【标签】（2026-09-04 上午）
 *   ② 行首「标签：」（2026-09-04 下午）
 *   ③ 无标签墙文：多个维度挤一段，按「标点 + 已知标签词 + 冒号」边界切段
 *     （2026-09-07 11:04）；「机械执行不恋战：」这类普通冒号不会被误切——
 *     切分点前面必须是句读标点或行首。
 */

// ---------- 性质（kind，条目级徽标） ----------

export const DECISION_KINDS = ['计划', '买入', '加仓', '减仓', '卖出', '清仓', '纪律', '复盘', '观察'] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

/** 徽标着色组；A股语义红买绿卖 */
export type KindGroup = 'red' | 'green' | 'blue' | 'orange' | 'teal' | 'violet' | 'plain'

export function kindGroup(kind: string): KindGroup {
  if (kind === '买入' || kind === '加仓') return 'red'
  if (kind === '卖出' || kind === '减仓' || kind === '清仓') return 'green'
  if (kind === '计划' || kind === '观察') return 'blue'
  if (kind === '纪律') return 'orange'
  if (kind === '复盘') return 'violet'
  return 'plain'
}

// ---------- 标签（块级，正文维度） ----------

/**
 * 已知标签词 → 着色组。列表顺序即墙文切词的备选顺序：
 * 长词必须排在可能成为其前缀的短词之前（如 复核条件 先于 复核、
 * 观察与依据 先于 观察），否则 alternation 会先命中短词把标签切残。
 */
const LABEL_GROUPS: ReadonlyArray<readonly [string, KindGroup]> = [
  ['事后复盘·教训', 'violet'],
  ['复核条件', 'teal'],
  ['复核', 'teal'],
  ['观察与依据', 'blue'],
  ['买入记录', 'red'],
  ['加仓记录', 'red'],
  ['卖出记录', 'green'],
  ['减仓记录', 'green'],
  ['止损纪律', 'orange'],
  ['止盈纪律', 'orange'],
  ['我的判断', 'blue'],
  ['决策', 'blue'],
  ['理由', 'blue'],
  ['执行', 'blue'],
  ['计划', 'blue'],
  ['判断', 'blue'],
  ['依据', 'blue'],
  ['结论', 'blue'],
  ['背景', 'blue'],
  ['观察', 'blue'],
  ['风险', 'orange'],
  ['纪律', 'orange'],
  ['止损', 'orange'],
  ['止盈', 'orange'],
  ['效果', 'teal'],
  ['教训', 'violet'],
  ['操作', 'red'],
  ['复盘', 'violet'],
  ['注', 'plain'],
]

const LABEL_WORDS_ALT = LABEL_GROUPS.map(([w]) => w).join('|')

/** 标签着色组；未知标签归 plain。尾缀括注（如「复核条件（止损/加仓纪律）」）不参与匹配 */
export function labelGroup(label: string): KindGroup {
  const bare = label.replace(/（[^）]*）$/, '')
  const hit = LABEL_GROUPS.find(([w]) => w === bare)
  return hit ? hit[1] : 'plain'
}

// ---------- 条目与块 ----------

export interface DecisionBlock {
  /** 标签（保留括注、无【】与冒号）；'' = 无标签通栏段 */
  label: string
  /** 标签行正文（标签单独成行时为 ''） */
  text: string
  /** 紧随的 - 列表项（复核条件/风险等一条一行） */
  items: string[]
}

export interface DecisionEntry {
  /** HH:MM；标题行之前的游离文本归入 time='' 的条目（正常不出现） */
  time: string
  /** [性质]；老日志为 '' */
  kind: string
  /** 一句话摘要；老日志可能为 '' */
  title: string
  blocks: DecisionBlock[]
}

const ENTRY_HEADING_RE = /^##\s+(\d{1,2}:\d{2})\s*(?:\[([^\]]{1,10})\])?\s*(.*)$/

/** 解析条目标题行「## 10:52 [计划] 摘要」；非条目标题行返回 null */
export function parseEntryHeading(line: string): { time: string; kind: string; title: string } | null {
  const m = ENTRY_HEADING_RE.exec(line.trim())
  if (m === null) return null
  return { time: m[1], kind: (m[2] ?? '').trim(), title: m[3].trim() }
}

/** 反向：由时间/性质/摘要拼条目标题行（host 落盘用，与 parseEntryHeading 互为逆） */
export function formatEntryHeading(time: string, kind: string, summary: string): string {
  const parts = [time]
  if (kind !== '') parts.push(`[${kind}]`)
  if (summary !== '') parts.push(summary)
  return `## ${parts.join(' ')}`
}

/** 工具入参清洗：性质去括号截断到 10 字，防模型把自由文本塞进来撑爆徽标 */
export function sanitizeKind(raw: string): string {
  return raw.replace(/[[\]【】]/g, '').trim().slice(0, 10)
}

/** 工具入参清洗：摘要压成单行截断到 60 字（折叠行标题会省略，超长无意义） */
export function sanitizeSummary(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 60)
}

/**
 * 把一天的正文体拆成条目序列。## 标题行开启新条目，其余行归属当前条目；
 * 标题行之前若有无归属的游离文本，归入 time='' 的首个条目兜底。
 */
export function splitDayEntries(body: string): DecisionEntry[] {
  const entries: DecisionEntry[] = []
  let current: DecisionEntry | null = null
  let raw: string[] = []
  const flush = (): void => {
    if (current === null) return
    current.blocks = parseBlocks(raw)
    entries.push(current)
    current = null
    raw = []
  }
  for (const line of body.split('\n')) {
    const head = parseEntryHeading(line)
    if (head !== null) {
      flush()
      current = { ...head, blocks: [] }
      continue
    }
    if (current !== null) {
      raw.push(line)
    } else if (line.trim() !== '') {
      current = { time: '', kind: '', title: '', blocks: [] }
      raw.push(line)
    }
  }
  flush()
  return entries
}

const BULLET_RE = /^[-*•]\s+/
const LEADING_LABEL_RE = /^【([^【】]{1,10})】\s*/
// 前缀（句读/行首+空白+可选【）单独捕获，切点位置由前缀长度决定，避免可选用符算偏
const WALL_SPLIT_RE = new RegExp(
  `((?:^|[。；;，,])\\s*【?)(${LABEL_WORDS_ALT})(?:（([^）]{0,20})）)?】?[:：]`,
  'g',
)

interface LabelCut {
  label: string
  start: number
  end: number
}

/**
 * 把一行拆成若干「标签 + 正文」段：
 * - 行首【标签】先规范化成「标签：」再统一切分；
 * - 墙文按「句读标点 + 已知标签词 + 冒号」边界切（前缀标点吸收进切点），
 *   括注（如「复核条件（止损/加仓纪律）：」）并入标签、不进正文；
 * - 无任何已知标签时整行归为一段无标签文本。
 */
function splitLabeledLine(line: string): Array<{ label: string; text: string }> {
  const normalized = line.replace(LEADING_LABEL_RE, '$1：')
  const cuts: LabelCut[] = []
  WALL_SPLIT_RE.lastIndex = 0
  for (let m = WALL_SPLIT_RE.exec(normalized); m !== null; m = WALL_SPLIT_RE.exec(normalized)) {
    const suffix = m[3] !== undefined ? `（${m[3]}）` : ''
    const label = m[2] + suffix
    const start = m.index + m[1].length
    cuts.push({ label, start, end: start + label.length + 1 })
  }
  if (cuts.length === 0) return [{ label: '', text: normalized }]
  const segments: Array<{ label: string; text: string }> = []
  const head = normalized.slice(0, cuts[0].start).trim()
  if (head !== '') segments.push({ label: '', text: head })
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i].end
    const to = i + 1 < cuts.length ? cuts[i + 1].start : normalized.length
    segments.push({ label: cuts[i].label, text: normalized.slice(from, to).trim() })
  }
  return segments
}

/**
 * 条目正文体 → 块序列。规则：
 * - 空行分块；-/* 开头为列表项，归属当前块（复核条件/风险一条一行）；
 * - 每行先按标签切段再落块；相邻同标签的行合并成一块（模型分行写同一维度）；
 * - 无标签文字仅在与上一块同为无标签时合并（同一段落续行），
 *   标签块之后的无标签尾巴自成一块，保持叙述顺序。
 */
function parseBlocks(lines: string[]): DecisionBlock[] {
  const blocks: DecisionBlock[] = []
  let pending: DecisionBlock | null = null
  const flush = (): void => {
    if (pending !== null) {
      blocks.push(pending)
      pending = null
    }
  }
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') {
      flush()
      continue
    }
    const bullet = BULLET_RE.exec(line)
    if (bullet !== null) {
      if (pending === null) pending = { label: '', text: '', items: [] }
      pending.items.push(line.slice(bullet[0].length).trim())
      continue
    }
    for (const seg of splitLabeledLine(line)) {
      if (seg.label === '') {
        if (pending !== null && pending.label === '') {
          pending.text = pending.text === '' ? seg.text : `${pending.text}\n${seg.text}`
        } else {
          flush()
          pending = { label: '', text: seg.text, items: [] }
        }
      } else if (pending !== null && pending.label === seg.label) {
        pending.text = pending.text === '' ? seg.text : `${pending.text}\n${seg.text}`
      } else {
        flush()
        pending = { label: seg.label, text: seg.text, items: [] }
      }
    }
  }
  flush()
  return blocks
}

/**
 * 折叠行标题去重：天文件首行是「# 2026-09-07 电投能源」，而折叠行左侧已有
 * 09-07 日期徽标，去掉标题里重复的前缀日期（老文件修复，新文件可不带日期）。
 */
export function stripDayDate(title: string, date: string): string {
  if (!title.startsWith(date)) return title
  return title.slice(date.length).replace(/^[\s:：、·-]+/, '').trim() || title
}
