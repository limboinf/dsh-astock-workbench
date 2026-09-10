/**
 * 浏览器半面 —— 工作台视图 + 工具结果渲染 + 快捷按钮 + 面板→对话联动。
 *
 * 注册点（全部为 list/keyed 槽位，不顶掉任何原生组件）：
 * - conversation.view        「工作台」tab（ui-chat 的「对话」tab 同层）
 * - tool.call.toolview       astock_* 工具结果表格化渲染（keyed by 工具名）
 * - conversation.input.left  输入框左侧「持仓/简报」快捷按钮
 *
 * 纪律：
 * - 只值导入 react（模块表基线），不 import 任何 @deepseek-ai/* 运行时符号，
 *   ctx 类型自声明（与 Host 半面 src/index.ts 同一套零依赖打法）；
 * - 面板零 mock：数据层订阅会话内 astock_positions 工具结果（真数据），
 *   录入/修改/删除全走自然语言（模型调 astock_add/remove_position 记账）；
 * - 联动走官方通道 ConversationController.send（方案 §3.4），prompt 只带意图与
 *   稳定标识（代码/日期），不携带数字——数字仍由模型侧 astock_* 工具取。
 */
import { createElement, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react'
import { f10Url, isLikelyFund, marketUrl, stripPrefix } from '../links.ts'
import { kindGroup, labelGroup, splitDayEntries, stripDayDate } from '../decision-entry.ts'
import type { DecisionBlock, DecisionEntry, KindGroup } from '../decision-entry.ts'

// ---------- 最小类型声明（刻意宽松，抵御 dsh developer preview 变更） ----------

interface SlotRegisterOptions {
  name: string
  id?: string
  key?: string
  order?: number
  label?: () => unknown
  /** chain 槽位（如 conversation.chat.turnTail）的认领函数：返回 matched 值或 null 弃权 */
  select?: (owner: unknown) => unknown
}

type Disposable = { dispose?: () => void }

interface SlotsService {
  inject(slot: string, register: () => Disposable): Disposable
  register(options: SlotRegisterOptions, component: (props: never) => unknown): Disposable
}

interface ClientContext {
  slots: SlotsService
  /** ui-conversation（web 半面常驻）：注册会话节点定义，从事件流逐 turn 累积数据 */
  uiConversation?: { events: { register(definition: unknown): void } }
  /** cordis ctx.get：惰性取服务（conversation 等 scoped 服务点击时再取） */
  get(service: string): unknown
  /** cordis ctx.effect：注册带清理的副作用 */
  effect?(fn: () => void | (() => void), name?: string): void
}

interface RemoteCommandsService {
  execute(sessionId: string, line: string, images?: unknown[]): Promise<{
    ok: boolean
    /** CommandExecution = { commandId, result: { kind, text? } }；部分 preview 版本平铺 { kind, text }，两种都容忍 */
    value?: { commandId?: unknown; result?: { kind: string; text?: string }; kind?: string; text?: string }
    error?: { message?: string }
  }>
}

interface RemoteService {
  commands: RemoteCommandsService
}

/** ui-conversation 的会话服务（方案 §3.4：send 将文本原样发进当前 session，排队执行） */
interface ConversationService {
  send(text: string): Promise<void>
}

/** api-session-controller 的会话目录服务（conversation 是 session 作用域，须经 scope 取） */
interface SessionsService {
  list: {
    /** byId[current].cwd 是宿主投影出的会话工作目录，影子会话按它分桶 */
    getSnapshot(): { current?: string; byId?: Record<string, { cwd?: string } | undefined> }
    /** 订阅会话目录变化（含 current 切换）；返回取消订阅函数 */
    subscribe?(listener: () => void): () => void
  }
  scope(id: string): { get(service: string): unknown } | undefined
  /** 幂等创建/收养会话（宿主语义：带 sessionId 即 adopt 已有会话）；旧 preview 可能没有。
   * ⚠️ adopt 会校验 cwd：宿主 ensureSession 发现已有会话的 cwd 与请求不一致就抛
   * ApiSessionCwdConflict，所以固定 id 不能跨工作目录复用（见 SHADOW_SESSION_PREFIX）。 */
  create?(opts: { sessionId: string; cwd?: string }): Promise<string>
  /** 取会话门面（改名等元操作用）；旧 preview 可能没有 */
  sessionOf?(ctx: unknown): { rename?(title: string): Promise<unknown> } | undefined
}

function getConversation(ctx: ClientContext): ConversationService | undefined {
  try {
    // 正规路径（ui-conversation apply.ts scopedConversation 同款）：
    // sessions.list 快照拿当前 session → sessions.scope(id) → scoped.get('conversation')
    const sessions = ctx.get('sessions') as SessionsService | undefined
    const current = sessions?.list?.getSnapshot?.()?.current
    if (sessions !== undefined && current !== undefined) {
      const scoped = sessions.scope(current)
      const scopedService = scoped?.get('conversation') as ConversationService | undefined
      if (scopedService !== undefined && typeof scopedService.send === 'function') return scopedService
    }
    // 兜底：root context 上若存在同名服务（未来版本可能放宽作用域）
    const rootService = ctx.get('conversation') as ConversationService | undefined
    return rootService !== undefined && typeof rootService.send === 'function' ? rootService : undefined
  } catch {
    return undefined
  }
}

/**
 * 联动发送：失败静默降级为复制提示（真实环境连接异常时不打断界面）。
 *
 * 发出去之前统一拼装：画像前缀（怎么答）+ 大盘背景（在什么环境下答）+ 问题本身。
 * 注入点只此一处，加新按钮不用重复拼。大盘背景按需带（withMarket）——纯操作类
 * 入口（记录决策日志）带上只是噪音，还会占 prompt 预算。
 */
async function linkSend(
  ctx: ClientContext,
  prompt: string,
  options?: { withMarket?: boolean },
): Promise<boolean> {
  const conversation = getConversation(ctx)
  if (conversation === undefined || typeof conversation.send !== 'function') return false
  const market = options?.withMarket === true ? renderMarketContext(marketStore.get()) : ''
  try {
    await conversation.send(renderProfilePrefix(profileStore.effective()) + market + prompt)
    return true
  } catch {
    return false
  }
}

// ---------- 持仓数据层：解析会话内 astock_positions 工具结果（真数据，零 mock） ----------
//
// 数据流：Host 半面 holdings.csv + 腾讯行情 → astock_positions 工具确定性计算 →
// markdown 文本进对话流 → AstockToolRow 渲染时解析 → 本 store → 面板订阅显示。
// 录入/修改/删除全部走自然语言（对话里说，模型调 astock_add/remove_position 记账），
// 记账后 store 标记 stale，面板提示刷新（再次查询即同步）。

import {
  decodeAnalyzeTag,
  decodeHtmlPreviewTag,
  decodeMarketTag,
  decodePayloadTag,
  decodeTag,
  renderMarketContext,
  stripPayloadTag,
  stripTag,
  type AnalyzePayload,
  type MarketPayload,
  type PortfolioPayload,
} from '../dto.ts'
import {
  defaultProfile,
  normalizeProfile,
  PROFILE_LABELS,
  PROFILE_NOTE_MAX,
  renderProfilePrefix,
  type InvestorProfile,
  type ProfileDepth,
  type ProfileJargon,
  type ProfileOrder,
} from '../profile.ts'

/** 一行持仓（字段为 format.ts 格式化后的字符串，'—' 表示行情缺失） */
interface ParsedRow {
  code: string
  name: string
  price: string
  cost: string
  shares: string
  value: string
  pnl: string
  pnlPct: string
  day: string
  turnover: string
  weight: string
}

interface PortfolioData {
  rows: ParsedRow[]
  totalAssets: string
  /** 手动总资产（astock_set_total_assets 录入，覆盖持仓口径）；未录入时 undefined */
  manualTotalAssets?: string
  manualAssetsDate?: string
  /** 现金口径（astock_set_cash 录入）：totalAssets = 持仓市值 + 现金；未录入时 undefined */
  cash?: string
  cashDate?: string
  totalValue: string
  totalPnl: string
  totalPnlPct: string
  /** 当日参考盈亏金额（Σ(现价−昨收)×股数），如 "+940.80"；与 dayPct 同源 */
  dayPnl: string
  dayPct: string
  /** dayPct 的分母口径文案："占总资产"（与券商一致）或降级的"占持仓市值" */
  dayBasis: string
  quoteTime: string
  stale: boolean
}

const EMPTY_PARSE: PortfolioData = {
  rows: [], totalAssets: '—', totalValue: '—', totalPnl: '—', totalPnlPct: '—', dayPnl: '—', dayPct: '—', dayBasis: '', quoteTime: '', stale: false,
}

// ---------- 结构化载荷 → 展示串 ----------
//
// 数字→字符串的格式化归 client（见 src/dto.ts 的契约说明）：host 只算数，
// 显示精度改了不用动 host。口径与 format.ts 的 fmt/fmtSigned 保持一致。

function fmtNum(n: number | null | undefined, digits = 2, suffix = ''): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + suffix
}

function fmtSignedNum(n: number | null | undefined, digits = 2, suffix = ''): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return (n > 0 ? '+' : '') + fmtNum(n, digits, suffix)
}

/** 把结构化载荷投影成面板的展示数据（渲染层仍吃字符串，形状与正则解析一致） */
function payloadToPortfolioData(payload: PortfolioPayload): PortfolioData {
  const { totals, day } = payload
  const assets = fmtNum(totals.assets)
  return {
    rows: payload.rows.map(row => ({
      code: row.code,
      name: row.name === '' ? '—' : row.name,
      price: fmtNum(row.price),
      cost: fmtNum(row.cost),
      shares: String(row.shares),
      value: fmtNum(row.marketValue),
      pnl: fmtSignedNum(row.pnl),
      pnlPct: fmtSignedNum(row.pnlPct, 2, '%'),
      day: fmtSignedNum(row.dayPct, 2, '%'),
      turnover: fmtNum(row.turnoverPct, 2, '%'),
      weight: fmtNum(row.weightPct, 1, '%'),
    })),
    totalAssets: assets,
    ...(totals.assetsBasis === 'cash'
      ? { cash: fmtNum(totals.cash), cashDate: totals.asOf ?? '' }
      : {}),
    ...(totals.assetsBasis === 'manual'
      ? { manualTotalAssets: assets, manualAssetsDate: totals.asOf ?? '' }
      : {}),
    totalValue: fmtNum(totals.marketValue),
    totalPnl: fmtSignedNum(totals.pnl),
    totalPnlPct: fmtSignedNum(totals.pnlPct, 2, '%'),
    dayPnl: fmtSignedNum(day.pnl),
    dayPct: fmtSignedNum(day.pct, 2, '%'),
    dayBasis: day.basis === 'total-assets' ? '占总资产' : '占持仓市值',
    quoteTime: payload.quoteTime ?? '',
    stale: false,
  }
}

/** 把 astock_positions 的 markdown 输出解析成结构化数据；识别不了返回 null */
function parsePositionsText(text: string): PortfolioData | null {
  // 正路：host 挂在末尾的结构化载荷。文案怎么改都不影响面板。
  const payload = decodePayloadTag(text)
  if (payload !== null) return payloadToPortfolioData(payload)
  // 过渡期回退：老版本 host（未挂载荷）仍按中文文案解析。两边都升级后可删。
  const rowRe = /^\|\s*(sh|sz|bj)\d{6}\s*\|/
  const rows: ParsedRow[] = []
  let totalAssets = '—'
  let manualTotalAssets: string | undefined
  let manualAssetsDate: string | undefined
  let cash: string | undefined
  let cashDate: string | undefined
  let totalValue = '—'
  let totalPnl = '—'
  let totalPnlPct = '—'
  let dayPnl = '—'
  let dayPct = '—'
  let dayBasis = ''
  let quoteTime = ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (rowRe.test(trimmed)) {
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())
      if (cells.length >= 11) {
        rows.push({
          code: cells[0], name: cells[1], price: cells[2], cost: cells[3], shares: cells[4],
          value: cells[5], pnl: cells[6], pnlPct: cells[7], day: cells[8], turnover: cells[9], weight: cells[10],
        })
      }
      continue
    }
    let m = /^- 总市值：(.+) 元$/.exec(trimmed)
    if (m !== null) { totalValue = m[1]; continue }
    m = /^- 总资产（持仓市值 \+ 现金）：(.+) 元（现金 (.+)，截至 (.+)）$/.exec(trimmed)
    if (m !== null) { totalAssets = m[1]; cash = m[2]; cashDate = m[3]; continue }
    m = /^- 总资产（持仓口径，不含现金）：(.+) 元$/.exec(trimmed)
    if (m !== null) { totalAssets = m[1]; continue }
    m = /^- 手动总资产：(.+) 元（截至 (.+)）$/.exec(trimmed)
    if (m !== null) { manualTotalAssets = m[1]; manualAssetsDate = m[2]; continue }
    m = /^- 累计盈亏：(.+) 元（(.+)）$/.exec(trimmed)
    if (m !== null) { totalPnl = m[1]; totalPnlPct = m[2]; continue }
    m = /^- 当日参考盈亏：(.+) 元（(.+)，(.+)）$/.exec(trimmed)
    if (m !== null) { dayPnl = m[1]; dayPct = m[2]; dayBasis = m[3]; continue }
    m = /^- 行情时间：(.+)$/.exec(trimmed)
    if (m !== null) { quoteTime = m[1]; continue }
  }
  return { rows, totalAssets, totalValue, totalPnl, totalPnlPct, dayPnl, dayPct, dayBasis, quoteTime, stale: false, manualTotalAssets, manualAssetsDate, cash, cashDate }
}

const portfolioStore = {
  data: null as PortfolioData | null,
  listeners: new Set<(data: PortfolioData | null) => void>(),
  get(): PortfolioData | null { return this.data },
  subscribe(fn: (data: PortfolioData | null) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  },
  set(next: PortfolioData | null): void {
    this.data = next
    for (const fn of this.listeners) fn(next)
  },
  /** 录入/清仓等写操作完成后调用：已有数据标记过期，提示刷新 */
  markStale(): void {
    if (this.data !== null && !this.data.stale) this.set({ ...this.data, stale: true })
  },
}

/** 大盘概览 store。与持仓是两条独立链路：大盘取不到不影响持仓表渲染。 */
const marketStore = {
  data: null as MarketPayload | null,
  listeners: new Set<(data: MarketPayload | null) => void>(),
  get(): MarketPayload | null { return this.data },
  subscribe(fn: (data: MarketPayload | null) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  },
  set(next: MarketPayload | null): void {
    this.data = next
    for (const fn of this.listeners) fn(next)
  },
}

/**
 * 投资者画像 store。linkSend 是模块级函数，直接读这里的当前值给 prompt 加前缀——
 * 所有面板 AI 入口共用一个注入点，加新按钮不用记得再拼一次。
 * saved=false 表示还没设置过（面板显示默认档，但不假装用户已经配置过）。
 */
const profileStore = {
  data: null as (InvestorProfile & { saved: boolean }) | null,
  listeners: new Set<(data: (InvestorProfile & { saved: boolean }) | null) => void>(),
  get(): (InvestorProfile & { saved: boolean }) | null { return this.data },
  subscribe(fn: (data: (InvestorProfile & { saved: boolean }) | null) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  },
  set(next: (InvestorProfile & { saved: boolean }) | null): void {
    this.data = next
    for (const fn of this.listeners) fn(next)
  },
  /** 已保存过才注入；没设置过就别拿默认档去改模型行为 */
  effective(): InvestorProfile | null {
    return this.data !== null && this.data.saved ? this.data : null
  },
}

interface DecisionLogEntry {
  date: string
  /** 首行 # 标题（去掉 # 前缀），折叠行展示用 */
  title: string
  /** 去掉首行标题后的 Markdown 正文（含 ## 时间戳 + 条目），展开时渲染 */
  body: string
}

interface DecisionLogsData {
  entries: DecisionLogEntry[]
}

const decisionLogsStore = {
  data: { entries: [] } as DecisionLogsData,
  /** 已成功拉取过一次（含空列表）。空日志的 entries.length 恒为 0，
   * 不能拿它当「未加载」判据——那会让每次会话切换都重发一次命令。 */
  loaded: false,
  listeners: new Set<(data: DecisionLogsData) => void>(),
  get(): DecisionLogsData { return this.data },
  subscribe(fn: (data: DecisionLogsData) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  },
  set(next: DecisionLogsData): void {
    this.data = next
    for (const fn of this.listeners) fn(next)
  },
}

/** 拆分每篇日志的首行标题与其余正文 */
function splitTitleBody(text: string): { title: string; body: string } {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '') continue
    if (t.startsWith('# ')) return { title: t.slice(2).trim() || '（无标题）', body: lines.slice(i + 1).join('\n').trim() }
    return { title: t, body: lines.slice(i).join('\n').trim() }
  }
  return { title: '（无标题）', body: '' }
}

/** 按 `### YYYY-MM-DD` 分节，拆成标题 + Markdown 正文 */
function parseDecisionLogsText(text: string): DecisionLogsData {
  const entries: DecisionLogEntry[] = []
  let date = ''
  let lines: string[] = []
  const flush = (): void => {
    if (date === '') return
    const { title, body } = splitTitleBody(lines.join('\n').trim())
    entries.push({ date, title, body })
  }
  for (const line of text.split('\n')) {
    const heading = /^###\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line.trim())
    if (heading !== null) {
      flush()
      date = heading[1]
      lines = []
      continue
    }
    if (date !== '') lines.push(line)
  }
  flush()
  return { entries }
}

// ---------- 决策日志结构化渲染 ----------

/** 徽标着色组 → 前景/底色（A股语义红买绿卖；中性灰兜底未知标签） */
const GROUP_COLORS: Record<KindGroup, { fg: string; bg: string }> = {
  red: { fg: '#b83838', bg: 'rgba(214,58,58,.10)' },
  green: { fg: '#157a45', bg: 'rgba(25,154,84,.10)' },
  blue: { fg: '#3358c9', bg: 'rgba(86,134,254,.15)' },
  orange: { fg: '#9c5f0f', bg: 'rgba(245,158,11,.16)' },
  teal: { fg: '#0d7360', bg: 'rgba(16,150,120,.12)' },
  violet: { fg: '#7348c4', bg: 'rgba(122,79,208,.12)' },
  plain: { fg: 'rgba(127,127,127,1)', bg: 'rgba(127,127,127,.12)' },
}

function chip(text: string, group: KindGroup, key: string | number): ReactElement {
  const c = GROUP_COLORS[group]
  return createElement('span', {
    key,
    style: {
      display: 'inline-block', flex: 'none', fontSize: 10.5, fontWeight: 600, lineHeight: 1.5,
      padding: '1px 7px', borderRadius: 4, whiteSpace: 'nowrap', background: c.bg, color: c.fg,
    },
  }, text)
}

/** 关键数字等宽加粗（回看时先扫数字）；单位与文字不动 */
const NUM_SPLIT_RE = /([+-]?\d[\d,]*(?:\.\d+)?%?)/g
function numericText(text: string, keyBase: string): ReactNode[] {
  return text.split(NUM_SPLIT_RE).map((part, i) =>
    part !== '' && i % 2 === 1
      ? createElement('b', { key: `${keyBase}#${i}`, style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, part)
      : part,
  )
}

/** 单个标签块：标签徽标（左列）+ 正文（右列）；列表一条一行挂在块内 */
function renderDecisionBlock(b: DecisionBlock, key: number): ReactElement {
  const muted = b.label === '注'
  const bodyFontSize = muted ? 11.5 : 12.5
  const textEl = b.text === ''
    ? null
    : createElement('div', { key: 't', style: { fontSize: bodyFontSize, lineHeight: 1.7 } }, ...numericText(b.text, `b${key}`))
  const listEl = b.items.length === 0
    ? null
    : createElement('ul', {
        key: 'l',
        style: { margin: b.text === '' ? 0 : '2px 0 0', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 },
      }, ...b.items.map((it, i) =>
        createElement('li', { key: i, style: { fontSize: bodyFontSize, lineHeight: 1.65 } }, ...numericText(it, `b${key}l${i}`)),
      ))
  // 无标签叙述与「注：」脚注不占标签列，通栏排版
  if (b.label === '' || muted) {
    return createElement('div', {
      key,
      style: { margin: '0 0 8px', ...(muted ? { opacity: 0.55, lineHeight: 1.6 } : {}) },
    }, textEl, listEl)
  }
  const c = GROUP_COLORS[labelGroup(b.label)]
  return createElement('div', {
    key,
    style: { display: 'grid', gridTemplateColumns: '88px minmax(0,1fr)', gap: 8, alignItems: 'start', margin: '0 0 8px' },
  },
    createElement('span', {
      style: {
        justifySelf: 'start', fontSize: 11, fontWeight: 600, lineHeight: 1.5, textAlign: 'center',
        padding: '1.5px 6px', borderRadius: 4, background: c.bg, color: c.fg,
      },
    }, b.label.replace(/（[^）]*）$/, '')),
    createElement('div', { style: { minWidth: 0 } }, textEl, listEl),
  )
}

/** 单个时间戳条目：时间 + [性质]徽标 + 摘要标题，下接标签块；条目之间细分隔线 */
function renderDecisionEntry(entry: DecisionEntry, index: number): ReactElement {
  const children: ReactElement[] = []
  if (entry.time !== '' || entry.kind !== '' || entry.title !== '') {
    children.push(createElement('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 8px' } },
      entry.time === '' ? null : createElement('span', { style: { fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', flex: 'none' } }, entry.time),
      entry.kind === '' ? null : chip(entry.kind, kindGroup(entry.kind), 'k'),
      entry.title === '' ? null : createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, entry.title),
    ))
  }
  entry.blocks.forEach((b, i) => children.push(renderDecisionBlock(b, i)))
  return createElement('div', {
    key: index,
    style: index === 0
      ? { padding: '2px 0 3px' }
      : { borderTop: '1px solid rgba(127,127,127,.16)', marginTop: 9, paddingTop: 9 },
  }, ...children)
}

/**
 * 极简 Markdown 渲染（兜底）：只服务于手工编辑成无条目结构（无 ## 时间戳行）
 * 的日志文件；正常由 append 落盘的正文都走上面的结构化渲染。
 * 不引入第三方解析库，维持客户端零运行时依赖。
 */
function renderMarkdownContent(text: string): ReactElement[] {
  const nodes: ReactElement[] = []
  let listItems: ReactElement[] = []
  const flushList = (): void => {
    if (listItems.length === 0) return
    nodes.push(createElement('ul', {
      key: nodes.length,
      style: { margin: '4px 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 },
    }, ...listItems))
    listItems = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') { flushList(); continue }
    const bullet = /^[-*•]\s+/.exec(line)
    if (bullet !== null) {
      listItems.push(createElement('li', { key: listItems.length, style: { fontSize: 12.5, lineHeight: 1.65 } }, line.slice(bullet[0].length)))
      continue
    }
    flushList()
    if (line.startsWith('# ')) {
      nodes.push(createElement('div', { key: nodes.length, style: { fontSize: 13.5, fontWeight: 600, margin: '2px 0 4px' } }, line.slice(2).trim()))
      continue
    }
    if (line.startsWith('## ')) {
      nodes.push(createElement('div', { key: nodes.length, style: { fontSize: 12, fontWeight: 600, opacity: 0.72, margin: '6px 0 2px', fontVariantNumeric: 'tabular-nums' } }, line.slice(3).trim()))
      continue
    }
    if (line.startsWith('### ')) {
      nodes.push(createElement('div', { key: nodes.length, style: { fontSize: 12, fontWeight: 600, opacity: 0.55, margin: '6px 0 2px' } }, line.slice(4).trim()))
      continue
    }
    nodes.push(createElement('div', { key: nodes.length, style: { fontSize: 12.5, lineHeight: 1.65, whiteSpace: 'pre-wrap' } }, line))
  }
  flushList()
  return nodes
}

/** 浏览器安全的本地「今天」日期（client 不能 import 用 node:fs 的 decision-log.ts） */
function localToday(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 日期是否在最近 days 天内（含今天） */
function isRecentDate(date: string, today: string, days: number): boolean {
  const d = new Date(`${date}T00:00:00`).getTime()
  const t = new Date(`${today}T00:00:00`).getTime()
  const diff = (t - d) / 86400000
  return diff >= 0 && diff < days
}

/** 按 YYYY-MM 分组（倒序），组内按日期倒序 */
function groupDecisionLogs(entries: DecisionLogEntry[]): Array<{ month: string; label: string; entries: DecisionLogEntry[] }> {
  const map = new Map<string, DecisionLogEntry[]>()
  for (const e of entries) {
    const m = e.date.slice(0, 7)
    if (!map.has(m)) map.set(m, [])
    map.get(m)!.push(e)
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, list]) => ({
      month,
      label: `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`,
      entries: list.sort((a, b) => b.date.localeCompare(a.date)),
    }))
}

/** 单条决策日志：折叠行（日期+标题+条目数/性质徽标）点击展开结构化条目 */
function DecisionLogItem({ entry, defaultOpen }: { entry: DecisionLogEntry; defaultOpen: boolean }): ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  // 条目展示按时间倒序（最新一条在最上，打开先看刚才的决策）；落盘仍是追加式正序，
  // 只在展示层翻转，天与天之间的倒序由 groupDecisionLogs 负责
  const dayEntries = splitDayEntries(entry.body).reverse()
  const kinds = [...new Set(dayEntries.map(e => e.kind).filter(k => k !== ''))]
  return createElement('div', { style: { borderRadius: 8, background: 'rgba(127,127,127,.08)', overflow: 'hidden' } },
    createElement('button', {
      onClick: () => setOpen(v => !v),
      title: open ? '收起' : '展开查看完整日志',
      style: {
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
        padding: '7px 10px', cursor: 'pointer', color: 'inherit',
        background: 'transparent', border: 'none', fontSize: 12.5,
      },
    },
      createElement('span', { style: { opacity: 0.6, fontSize: 11, flex: 'none' } }, open ? '▾' : '▸'),
      createElement('b', { style: { flex: 'none', fontVariantNumeric: 'tabular-nums' } }, entry.date.slice(5)),
      // 标题里去掉与左侧日期徽标重复的前缀日期（老文件「# 2026-09-07 电投能源」）
      createElement('span', {
        style: { opacity: 0.82, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0 },
      }, stripDayDate(entry.title, entry.date)),
      dayEntries.length > 0
        ? createElement('span', { style: { marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 4 } },
            chip(`${dayEntries.length}条`, 'plain', 'n'),
            ...kinds.map(k => chip(k, kindGroup(k), k)),
          )
        : null,
    ),
    open
      ? createElement('div', { style: { padding: '0 12px 12px 18px' } },
          dayEntries.length > 0
            ? dayEntries.map(renderDecisionEntry)
            : renderMarkdownContent(entry.body),
        )
      : null,
  )
}

/** 决策日志列表：最近 30 天按月分组 + 折叠条目，更早的按需展开 */
function DecisionLogList({ entries }: { entries: DecisionLogEntry[] }): ReactElement {
  const [showOlder, setShowOlder] = useState(false)
  const today = localToday()
  const recent = entries.filter(e => isRecentDate(e.date, today, 30))
  const older = entries.filter(e => !isRecentDate(e.date, today, 30))
  const recentGroups = groupDecisionLogs(recent)
  const olderGroups = groupDecisionLogs(older)
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    ...recentGroups.map(g => createElement('div', { key: g.month },
      createElement('div', { style: { fontSize: 11, fontWeight: 600, opacity: 0.5, letterSpacing: 0.5, margin: '0 0 6px' } }, g.label),
      createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        ...g.entries.map(e => createElement(DecisionLogItem, { key: e.date, entry: e, defaultOpen: e.date === today })),
      ),
    )),
    older.length > 0
      ? createElement('div', null,
          createElement('button', {
            onClick: () => setShowOlder(v => !v),
            style: { width: '100%', padding: '6px 10px', cursor: 'pointer', color: 'inherit', background: 'transparent', border: '1px dashed rgba(127,127,127,.35)', borderRadius: 8, fontSize: 12, opacity: 0.7 },
          }, `${showOlder ? '收起' : '展开'}更早的 ${older.length} 篇日志`),
          showOlder
            ? createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 } },
                ...olderGroups.map(g => createElement('div', { key: g.month },
                  createElement('div', { style: { fontSize: 11, fontWeight: 600, opacity: 0.5, letterSpacing: 0.5, margin: '0 0 6px' } }, g.label),
                  createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    ...g.entries.map(e => createElement(DecisionLogItem, { key: e.date, entry: e, defaultOpen: false })),
                  ),
                )),
              )
            : null,
        )
      : null,
  )
}

interface CommandExecValue {
  commandId?: unknown
  result?: { kind?: string; text?: string }
  kind?: string
  text?: string
}

/**
 * 命令返回解包（对齐 dsh 契约，防御性兼容版本漂移）：
 * remote.commands.execute → RemoteResult<CommandExecution | undefined>，
 * CommandExecution = { commandId, result: { kind: 'success'|'error', text? } }。
 * 旧代码误读成 value.kind/value.text（平铺），导致刷新永远判定失败；
 * 这里以嵌套 result 为准，同时保留平铺兜底。
 */
function unwrapCommandText(result: { ok: boolean; value?: unknown }): string | undefined {
  if (!result.ok) return undefined
  const value = result.value as CommandExecValue | undefined
  if (value === null || value === undefined) return undefined
  const inner = value.result
  if (inner !== undefined) {
    return inner.kind === 'success' && typeof inner.text === 'string' ? inner.text : undefined
  }
  return value.kind === 'success' && typeof value.text === 'string' ? value.text : undefined
}

// ---------- 面板取数通道：固定 id 的「影子会话」 ----------
//
// dsh 的 CommandRuntime.execute 每次都会向目标会话日志追加 command/run +
// command/done 两个持久事件（done 携带结果全文；log-only、不进模型上下文，
// 但会话轨迹里逐条渲染）。面板首屏自动加载 + 盘中轮询若在「当前会话」里
// 执行 /portfolio、/decision-logs，真实对话就会被成串命令记录污染
// （2026-09-04 用户报告的「新对话重复注入很多信息」）。
// 解法：所有面板取数走一个用户从不打开的影子会话承接这些事件，真实对话保持干净。
// host 的 session.create 对带 sessionId 的请求是幂等 adopt，id 记在 localStorage
// 里保证跨页面加载复用同一个（失败时换新，见 ensureShadowSessionId 的头注）。
// 已知代价：盘中轮询会让影子会话日志持续增长（可整会话删除）；
// 正路是 README 待办里的 AstockService/Typert Remote 免对话直连。
const SHADOW_SESSION_PREFIX = 'session-astock-panel'
const SHADOW_SESSION_TITLE = '📊 A股工作台 · 面板数据'
const SHADOW_STORAGE_KEY = 'astock-workbench:shadow-session'
/**
 * 影子会话的取数单例。挂在 globalThis 而不是模块作用域：client 半面是闭包工厂
 * 打包，每个挂载点会各自求值一次模块，模块级变量不共享——2026-09-04 实测一次
 * 页面加载并发建出 3 个影子会话，多余的两个立刻成为孤儿。
 * 成功一次就复用；失败不缓存，下次取数重试。
 */
const shadowSingleton = globalThis as {
  __astockShadowId?: Promise<string | undefined>
  __astockShadowCwd?: string
  __astockShadowRenamed?: Set<string>
}
const shadowRenamed = shadowSingleton.__astockShadowRenamed ??= new Set<string>()

/** 当前会话的工作目录（宿主 list 投影带出）；拿不到返回 undefined */
function currentSessionCwd(ctx: ClientContext): string | undefined {
  try {
    const sessions = ctx.get('sessions') as SessionsService | undefined
    const snapshot = sessions?.list?.getSnapshot?.()
    const current = snapshot?.current
    if (current === undefined) return undefined
    const cwd = snapshot?.byId?.[current]?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/** FNV-1a 32 位：只用来把 cwd 压成短后缀，不是安全哈希 */
function cwdTag(cwd: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < cwd.length; i += 1) {
    hash ^= cwd.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** 新影子会话 id：cwd 指纹 + 时间戳，保证不撞已损坏的旧会话 */
function freshShadowId(cwd: string): string {
  return `${SHADOW_SESSION_PREFIX}-${cwdTag(cwd)}-${Date.now().toString(36)}`
}

/** localStorage 里记住的影子会话（隐私模式等取不到时退化为「没记住」） */
function readRememberedShadow(cwd: string): string | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(SHADOW_STORAGE_KEY)
    if (raw === null || raw === undefined) return undefined
    const parsed = JSON.parse(raw) as { cwd?: string; sessionId?: string }
    return parsed.cwd === cwd && typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined
  } catch {
    return undefined
  }
}

function rememberShadow(cwd: string, sessionId: string): void {
  try {
    globalThis.localStorage?.setItem(SHADOW_STORAGE_KEY, JSON.stringify({ cwd, sessionId }))
  } catch { /* 存不下就每次新建一个，功能不受影响 */ }
}

/**
 * 确保当前 cwd 有一个可用的影子会话并返回其 id；拿不到返回 undefined。
 *
 * 为什么不能用固定 id（2026-09-04 实测教训）：宿主 adopt 已有会话时会先读它的
 * 日志，会话日志是 zstd 分帧写的，进程被 kill 时最后一帧可能只写了一半，宿主此后
 * 一律报 `stored session ... is corrupt` —— 固定 id 会就此永久瘫痪，重试多少次都
 * 一样。cwd 变化同样会让 adopt 撞上宿主的 cwd 校验（ApiSessionCwdConflict）。
 * 所以 id 记在 localStorage 里，adopt 失败就换一个新 id 重建：一次损坏只丢一个
 * 废弃会话，通道自愈。
 */
function ensureShadowSessionId(ctx: ClientContext): Promise<string | undefined> {
  const cwd = currentSessionCwd(ctx)
  if (cwd === undefined) return Promise.resolve(undefined)
  if (shadowSingleton.__astockShadowId !== undefined && shadowSingleton.__astockShadowCwd === cwd) {
    return shadowSingleton.__astockShadowId
  }
  const created = (async () => {
    const sessions = ctx.get('sessions') as SessionsService | undefined
    if (sessions === undefined || typeof sessions.create !== 'function') return undefined
    const remembered = readRememberedShadow(cwd)
    // 记住的 id 先试 adopt；损坏/cwd 不符就换新 id，不再纠缠。
    const candidates = remembered === undefined
      ? [freshShadowId(cwd)]
      : [remembered, freshShadowId(cwd)]
    for (const sessionId of candidates) {
      try {
        await sessions.create({ sessionId, cwd })
      } catch {
        continue
      }
      rememberShadow(cwd, sessionId)
      if (!shadowRenamed.has(sessionId)) {
        shadowRenamed.add(sessionId)
        try {
          const scoped = sessions.scope(sessionId)
          const face = scoped === undefined ? undefined : sessions.sessionOf?.(scoped)
          await face?.rename?.(SHADOW_SESSION_TITLE)
        } catch { /* 改名是装饰性的，失败不影响取数 */ }
      }
      return sessionId
    }
    return undefined
  })().then(id => {
    if (id === undefined) {
      shadowSingleton.__astockShadowId = undefined
      shadowSingleton.__astockShadowCwd = undefined
    }
    return id
  })
  shadowSingleton.__astockShadowId = created
  shadowSingleton.__astockShadowCwd = cwd
  return created
}

/**
 * 经 remote.commands 直接执行一条本地命令（不经模型，不产生 AI 对话）。
 * 目标会话只用影子会话——影子不可用就整个放弃这次取数（fail-closed）：
 * 退回当前会话会把 command/run|done 写进用户真实对话，5s 轮询下这是不可见
 * 的持续污染，比面板刷不出数（可见、可重试）严重得多。
 * 返回 'unavailable' 表示会话/remote/影子通道未就绪，undefined 表示执行失败
 * 或结果不可用，否则返回命令的成功文本。
 */
async function executeCommandText(ctx: ClientContext, line: string): Promise<string | undefined | 'unavailable'> {
  try {
    const remote = ctx.get('remote') as RemoteService | undefined
    if (remote?.commands?.execute === undefined) return 'unavailable'
    const sessionId = await ensureShadowSessionId(ctx)
    if (sessionId === undefined) return 'unavailable'
    return unwrapCommandText(await remote.commands.execute(sessionId, line, []))
  } catch {
    return undefined
  }
}

/** /portfolio 取数互斥：5s 轮询下慢请求（>5s）会撞上下一跳，重叠时跳过而非排队 */
let portfolioRefreshInFlight = false

async function refreshPortfolio(ctx: ClientContext): Promise<'ok' | 'busy' | 'failed' | 'unavailable'> {
  if (portfolioRefreshInFlight) return 'busy'
  portfolioRefreshInFlight = true
  try {
    const text = await executeCommandText(ctx, '/portfolio')
    if (text === 'unavailable') return 'unavailable'
    if (text === undefined) return 'failed'
    const parsed = parsePositionsText(text)
    if (parsed === null) return 'failed'
    portfolioStore.set(parsed)
    return 'ok'
  } finally {
    portfolioRefreshInFlight = false
  }
}

/** 大盘概览取数互斥：与 /portfolio 同频轮询，慢请求撞上下一跳时跳过而非排队 */
let marketRefreshInFlight = false

async function refreshMarket(ctx: ClientContext): Promise<'ok' | 'busy' | 'failed' | 'unavailable'> {
  if (marketRefreshInFlight) return 'busy'
  marketRefreshInFlight = true
  try {
    const text = await executeCommandText(ctx, '/market')
    if (text === 'unavailable') return 'unavailable'
    if (text === undefined) return 'failed'
    const parsed = decodeMarketTag(text)
    if (parsed === null) return 'failed'
    marketStore.set(parsed)
    return 'ok'
  } finally {
    marketRefreshInFlight = false
  }
}

async function refreshProfile(ctx: ClientContext): Promise<'ok' | 'failed' | 'unavailable'> {
  const text = await executeCommandText(ctx, '/profile')
  if (text === 'unavailable') return 'unavailable'
  if (text === undefined) return 'failed'
  const parsed = decodeTag<InvestorProfile & { saved?: boolean }>('profile', text)
  if (parsed === null) return 'failed'
  profileStore.set({ ...normalizeProfile(parsed, parsed.updatedAt), saved: parsed.saved === true })
  return 'ok'
}

/** 命令行传不了带引号/换行的 JSON，走 base64（note 可能是中文，先 UTF-8 编码） */
function encodeProfileArg(profile: InvestorProfile): string {
  const bytes = new TextEncoder().encode(JSON.stringify(profile))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function saveProfile(ctx: ClientContext, profile: InvestorProfile): Promise<boolean> {
  const text = await executeCommandText(ctx, `/profile set ${encodeProfileArg(profile)}`)
  if (text === undefined || text === 'unavailable') return false
  const parsed = decodeTag<InvestorProfile & { saved?: boolean }>('profile', text)
  if (parsed === null) return false
  profileStore.set({ ...normalizeProfile(parsed, parsed.updatedAt), saved: true })
  return true
}

async function refreshDecisionLogs(ctx: ClientContext): Promise<'ok' | 'failed' | 'unavailable'> {
  const text = await executeCommandText(ctx, '/decision-logs')
  if (text === 'unavailable') return 'unavailable'
  if (text === undefined) return 'failed'
  decisionLogsStore.set(parseDecisionLogsText(text))
  decisionLogsStore.loaded = true
  return 'ok'
}

/**
 * 集合竞价时段（9:15–9:25）判断——判据是行情时间（快照本身处于竞价窗口），
 * 不是本机时钟：9:26 后查看 9:20 的快照同样该提示。口径与 format.ts 的文本版
 * isCallAuctionTime 一致；client 不能 import format.ts（其 import 链带 Node
 * 依赖），只能双写，改动时两处同步。
 */
function isCallAuctionQuoteTime(quoteTime: string): boolean {
  const m = / (\d{2}):(\d{2}):\d{2}/.exec(quoteTime)
  if (m === null) return false
  const t = Number(m[1]) * 60 + Number(m[2])
  return t >= 555 && t < 565
}

/**
 * 盘中自动轮询间隔（毫秒）。5s 是用户明确要的准实时节奏（2026-09-04）：对
 * fuyao（自费 Key）+ 腾讯兜底约 12 次/分钟，可接受；护栏是页面隐藏跳过、
 * 离开交易时段自然停、面板收起即卸载，加上 refreshPortfolio 的取数互斥。
 */
const AUTO_REFRESH_MS = 5_000

/**
 * A 股交易时段判断（含集合竞价前后缓冲）：周一~周五 9:10–11:35、12:55–15:05。
 * 法定节假日照常轮询的代价只是刷到同一份收盘数据，不值得维护节假日表。
 */
function isMarketOpen(now = new Date()): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const m = now.getHours() * 60 + now.getMinutes()
  return (m >= 550 && m <= 695) || (m >= 775 && m <= 905)
}

// ---------- 内联样式工具 ----------

const UP = '#d63a3a'
const DOWN = '#199a54'
/** 数字单元格上色：A 股口径红涨绿跌（'+…' 红、'−/-…' 绿、'—' 灰） */
const cellColor = (s: string): string | undefined =>
  /^\+/.test(s) ? UP : /^[−-]/.test(s) ? DOWN : undefined
const num = (s: string): number => {
  const v = Number.parseFloat(s.replace(/,/g, '').replace('%', ''))
  return Number.isFinite(v) ? v : 0
}

/**
 * 「联动按钮」：点击 → ConversationController.send 预设 prompt → 按钮上浮现反馈。
 * 反馈语义：✓ 已发送到对话（请切回 Chat 查看）；✗ 通道不可用。
 */
interface LinkButtonProps {
  prompt: string
  label: string
  title?: string
  style?: Record<string, string | number>
  /** 发送完成后的回调（浮层菜单用它自动收起） */
  onSent?: () => void
  /** 是否带上当前大盘环境（行情分析类入口开，纯操作类入口关） */
  withMarket?: boolean
}

function makeLinkButton(ctx: ClientContext): (props: LinkButtonProps) => ReactElement {
  return function LinkButton({ prompt, label, title, style, onSent, withMarket }: LinkButtonProps): ReactElement {
    const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
    return createElement('button', {
      title: title ?? `${label}（引入对话，由 AI 结合工具数据分析）`,
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 12.5, cursor: 'pointer',
        color: 'inherit', background: 'transparent',
        border: '1px solid rgba(127,127,127,.35)', borderRadius: 999,
        padding: state === 'idle' ? '4px 12px' : '4px 10px',
        opacity: state === 'sending' ? 0.5 : 1,
        ...style,
      },
      onClick: () => {
        setState('sending')
        void linkSend(ctx, prompt, { withMarket }).then(ok => {
          setState(ok ? 'sent' : 'failed')
          if (ok) setTimeout(() => onSent?.(), 900)
        })
        setTimeout(() => setState('idle'), 2200)
      },
    },
      state === 'idle' ? label : state === 'sending' ? '发送中…' : state === 'sent' ? '✓ 已发送到对话' : '✗ 通道不可用',
    )
  }
}

/**
 * 通用「直接刷新」按钮：执行本地命令（不经模型，不产生 AI 对话），
 * 显示 loading/ok/failed 反馈。run 传 refreshPortfolio / refreshDecisionLogs。
 */
function makeRefreshButton(
  ctx: ClientContext,
  run: (ctx: ClientContext) => Promise<'ok' | 'busy' | 'failed' | 'unavailable'>,
  title: string,
  style?: Record<string, string | number>,
): (props: unknown) => ReactElement {
  return function RefreshButton(_props: unknown): ReactElement {
    const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'failed'>('idle')
    return createElement('button', {
      title,
      disabled: state === 'loading',
      onClick: () => {
        setState('loading')
        void run(ctx).then(result => {
          // 'busy'：已有一轮取数在途（多半是自动轮询），数据随后就到，按成功反馈
          setState(result === 'failed' || result === 'unavailable' ? 'failed' : 'ok')
          setTimeout(() => setState('idle'), 1800)
        })
      },
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 12.5, cursor: state === 'loading' ? 'wait' : 'pointer',
        color: 'inherit', background: 'transparent',
        border: '1px solid rgba(127,127,127,.35)', borderRadius: 999,
        padding: '3px 10px', opacity: state === 'loading' ? 0.5 : 1,
        ...style,
      },
    }, state === 'loading' ? '刷新中…' : state === 'ok' ? '✓ 已刷新' : state === 'failed' ? '✗ 刷新失败' : '↻ 刷新')
  }
}

function ExternalLink({ href, label, title }: { href: string; label: string; title: string }): ReactElement {
  return createElement('a', {
    href, target: '_blank', rel: 'noreferrer noopener', title,
    onClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
    style: { fontSize: 11, opacity: 0.7, color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 },
  }, label)
}

// ---------- 顶部大盘条 ----------

/** 亿元展示：大盘的钱都是亿量级，元/万都太长塞不进面板 */
function toYi(n: number | null, digits = 0): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${(n / 1e8).toFixed(digits)}亿`
}

function signedPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
}

function signedNum(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`
}

/** 指数涨跌色：与持仓表同口径的红涨绿跌 */
function trendColor(n: number | null): string | undefined {
  if (n === null || !Number.isFinite(n) || n === 0) return undefined
  return n > 0 ? UP : DOWN
}

/**
 * 大盘概览条（面板顶部）：三大指数 + 沪深涨跌家数 + 成交额 + 主力净流入。
 * 数据源见 src/market.ts（东财主源 / 腾讯兜底）；腾讯兜底拿不到家数与资金流，
 * 那两项显示「—」并在角标标出数据源，不编数字。
 */
function MarketBar({ data }: { data: MarketPayload | null }): ReactElement | null {
  if (data === null || data.indices.length === 0) return null
  const { totals } = data
  const up = totals.up ?? 0
  const down = totals.down ?? 0
  const flat = totals.flat ?? 0
  const breadth = up + down + flat
  const hasBreadth = totals.up !== null && breadth > 0

  return createElement('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: 8,
      padding: '10px 12px', borderRadius: 10,
      border: '1px solid rgba(127,127,127,.22)',
      background: 'rgba(127,127,127,.05)',
    },
  },
    // 三大指数
    createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      ...data.indices.map(row => createElement('div', {
        key: row.code,
        style: {
          flex: '1 1 96px', minWidth: 96, padding: '6px 9px', borderRadius: 8,
          background: (row.changePct ?? 0) >= 0 ? 'rgba(214,58,58,.08)' : 'rgba(25,154,84,.08)',
        },
      },
        createElement('div', { style: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap' } }, row.name),
        createElement('div', {
          style: { fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: trendColor(row.changePct) ?? 'inherit' },
        }, row.price === null ? '—' : row.price.toFixed(2)),
        createElement('div', {
          style: { fontSize: 11, fontVariantNumeric: 'tabular-nums', color: trendColor(row.changePct) ?? 'inherit' },
        }, `${signedNum(row.change)}  ${signedPct(row.changePct)}`),
      )),
    ),
    // 涨跌家数进度条
    hasBreadth
      ? createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        createElement('div', { style: { display: 'flex', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' } },
          createElement('span', { style: { color: DOWN } }, `跌 ${down}`),
          createElement('span', { style: { flex: 1 } }),
          createElement('span', { style: { color: UP } }, `涨 ${up}`),
        ),
        createElement('div', {
          title: `沪深两市：涨 ${up} · 平 ${flat} · 跌 ${down}`,
          style: { display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden', background: 'rgba(127,127,127,.2)' },
        },
          createElement('i', { style: { width: `${(down / breadth) * 100}%`, background: DOWN } }),
          createElement('i', { style: { width: `${(flat / breadth) * 100}%`, background: 'rgba(127,127,127,.5)' } }),
          createElement('i', { style: { width: `${(up / breadth) * 100}%`, background: UP } }),
        ),
      )
      : null,
    // 成交额 + 资金流 + 数据源
    createElement('div', {
      style: { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, opacity: 0.75, fontVariantNumeric: 'tabular-nums' },
    },
      createElement('span', null, `沪深成交 ${toYi(totals.amount)}`),
      createElement('span', { style: { color: trendColor(totals.netInflow) } },
        `主力净流入 ${totals.netInflow === null ? '—' : `${totals.netInflow > 0 ? '+' : ''}${toYi(totals.netInflow, 1)}`}`),
      createElement('span', { style: { flex: 1 } }),
      createElement('span', { style: { opacity: 0.7 } },
        data.error !== null ? '⚠️ 行情不可用'
          : data.source === 'tencent' ? `${data.time ?? ''} · 腾讯兜底（无家数/资金流）`
            : data.time ?? ''),
    ),
  )
}

// ---------- 个股 AI 入口：按意图分流 ----------
//
// 为什么不是一个「分析」按钮（2026-09-04 实测教训）：开放问题会让模型用「全面
// 覆盖」对冲不确定性——同一段上下文里，「帮我分析 X」端出七个章节，而「62 挂一手
// 合理吗」直接给结论和纪律。与其让用户去设置输出长度，不如让产品先问对问题。
// 所以这里把入口拆成三个具体问题 + 一个保留的完整分析，每个只取自己要的数据、
// 只答自己那一段。

type StockIntent = 'move' | 'action' | 'portfolio' | 'full'

/**
 * 估值与财务同因收编工具面（2026-09-07）：此前让模型 shell 自读 FUYAO_API_KEY
 * （数据目录 env 是 `export KEY=V` 格式，grep `^KEY=` 锚定不到，反复翻车）+ 裸 curl
 * fuyao，且 quarterly 返回的是年初至今累计值、模型极易当单季误读。
 * astock_fundamentals 在本地完成取数与折算，key 不再经模型之手。
 */
function fundamentalsLine(code: string): string {
  return `估值与财务：调用 astock_fundamentals（symbol=${stripPrefix(code)}）取确定性数字`
    + '（PE-TTM/PB-MRQ、近4个单季营收与归母净利润及同比环比），分析时直接引用这些数字。'
}

const NO_AUTO_LOG = '本次回答是分析建议、还没有成交：不要主动调用 astock_log_decision 写决策日志；如觉得值得留存，先问我要不要记录。'
const POSITION_SOURCE = '持仓金额、比例只以 astock_positions 返回为准。'

/**
 * 近期走势数据一律走 astock_analyze 工具（本地算死的确定性数字），不让模型裸调
 * fuyao 日K：接口 start/end 要毫秒时间戳，模型自己换算时用 date +%s 拿到的是秒级，
 * 接口对「窗口内无数据」不报错（返回 code=0 + 空 item），模型会误判成接口坏了
 * （2026-09-07 实测，002128 与 600519 对照双双踩坑）。
 */
function klineLine(code: string): string {
  return `近期走势与量能：调用 astock_analyze（symbol=${stripPrefix(code)}）取确定性数字`
    + '（趋势/量能/相对强弱判定标签、MA5/MA20、20日区间与位置、5日/20日收益），'
    + '支撑压力位与加/减触发价以这些数字为锚。不要按该工具默认的「诊断书」三段结构展开，'
    + '回答结构以本提问的要求为准。'
}

/**
 * 提示词只带意图与稳定标识（代码），不携带数字——行情/趋势/估值/财务全由
 * 模型调用 astock_* 工具自取（确定性数据层算好，模型只解读；fuyao key
 * 全程不经对话与模型之手）。
 */
function stockPrompt(intent: StockIntent, code: string, name: string): string {
  const label = `${name}（${stripPrefix(code)}）`
  const fund = isLikelyFund(code)
  const lines: string[] = []
  switch (intent) {
    case 'move':
      lines.push(`${label}今天为什么这么走？`)
      lines.push('请先调用 astock_quote 获取最新行情。')
      lines.push(klineLine(code))
      lines.push(`行情页：${marketUrl(code)}`)
      lines.push('只回答「今天为什么这么走」：先用一句话给归因，再列最多 3 条支撑证据'
        + '（放量还是缩量、有没有跌破/站上关键位、是板块共振还是个股独走）。'
        + '不要讲估值、不要讲财务、不要给操作建议——那些我会另外问。')
      break
    case 'action':
      lines.push(`${label}现在该加、该减，还是不动？`)
      lines.push('请先调用 astock_positions 和 astock_quote。')
      lines.push(klineLine(code))
      if (!fund) {
        lines.push(fundamentalsLine(code))
      }
      lines.push('只回答这一个问题：先给明确结论（加/减/不动）和不超过 3 条理由，'
        + '再给触发条件——什么价位或什么信号加，什么价位或什么信号减，跌到哪里算判断错误。'
        + '不要复述公司基本面和历史行情。结尾说明这不是投资建议。')
      lines.push(POSITION_SOURCE)
      break
    case 'portfolio':
      lines.push(`${label}在我的组合里有什么问题？`)
      lines.push('请先调用 astock_positions 拿到全部持仓，再用 astock_quote 取这只的最新行情。')
      lines.push('只从组合视角回答三点：①它和我其他持仓的敞口是否重复（点名哪几只、合计多少权重）；'
        + '②当前权重与它的波动性是否匹配（仓位太小没意义、还是太大扛不住）；'
        + '③如果要调整组合，它属于优先动的还是最后动的，为什么。'
        + '不要单独讲这家公司的基本面和财务，我只关心它在组合里的角色。')
      lines.push(POSITION_SOURCE)
      break
    case 'full':
      lines.push(`结合我的持仓，帮我分析${label}。`)
      lines.push('请先调用 astock_quote 获取最新行情，再深入研究。')
      lines.push(klineLine(code))
      if (!fund) {
        lines.push(fundamentalsLine(code))
      } else {
        lines.push(`行情页：${marketUrl(code)}`)
      }
      lines.push('最后结合今日行情、估值、财务趋势，以及这笔仓位在组合里的问题给出分析。')
      lines.push(POSITION_SOURCE)
      break
  }
  lines.push(NO_AUTO_LOG)
  return lines.join('\n')
}

const STOCK_ACTIONS: { intent: StockIntent; label: string; hint: string }[] = [
  { intent: 'move', label: '今天为什么这么走？', hint: '只做异动归因，不讲估值财务' },
  { intent: 'action', label: '该加、该减，还是不动？', hint: '直接给结论和触发条件' },
  { intent: 'portfolio', label: '它在我组合里的问题', hint: '敞口重复、权重是否匹配' },
  { intent: 'full', label: '完整分析', hint: '行情+估值+财务+组合，篇幅最长' },
]

/** 个股 ✦：点开是一组具体问题，而不是一个包办一切的「分析」 */
function makeStockActions(ctx: ClientContext): (props: { code: string; name: string }) => ReactElement {
  const LinkButton = makeLinkButton(ctx)
  return function StockActions({ code, name }: { code: string; name: string }): ReactElement {
    const [open, setOpen] = useState(false)
    return createElement('div', { style: { position: 'relative' } },
      createElement('button', {
        title: `问 AI 关于 ${name} 的具体问题`,
        style: {
          border: 'none', padding: '2px 8px', fontSize: 13, cursor: 'pointer',
          background: open ? 'rgba(86,134,254,.16)' : 'transparent',
          borderRadius: 6, color: 'inherit', opacity: open ? 1 : 0.75,
        },
        onClick: () => setOpen(v => !v),
      }, '✦'),
      open
        ? createElement('div', {
          style: {
            position: 'absolute', top: '100%', right: 0, zIndex: 30, marginTop: 4,
            minWidth: 250, padding: 6, borderRadius: 10,
            border: '1px solid rgba(127,127,127,.35)',
            background: 'var(--dsh-surface, Canvas)',
            boxShadow: '0 8px 24px rgba(0,0,0,.18)',
            display: 'flex', flexDirection: 'column', gap: 2,
          },
        },
          ...STOCK_ACTIONS.map(action => createElement('div', { key: action.intent },
            createElement(LinkButton, {
              prompt: stockPrompt(action.intent, code, name),
              label: action.label,
              title: action.hint,
              // 判断「跟跌还是独跌」必须知道大盘环境，四个问题都带
              withMarket: true,
              onSent: () => setOpen(false),
              style: {
                border: 'none', borderRadius: 7, width: '100%', textAlign: 'left',
                justifyContent: 'flex-start', padding: '6px 9px', fontSize: 12.5,
              },
            }),
            createElement('div', { style: { fontSize: 10.5, opacity: 0.45, padding: '0 9px 4px' } }, action.hint),
          )),
        )
        : null,
    )
  }
}

/**
 * 个性化设置卡：三个档位 + 一句话自述，保存后立即对所有面板 AI 入口生效。
 *
 * 为什么只有三档：用户答不上来「我想要什么风格」，直到看见输出。先给最少的
 * 档位跑起来，再按实际使用补——不要一上来就做成一张问卷（见 src/profile.ts）。
 */
function makeSettingsCard(ctx: ClientContext): (props: { onClose(): void }) => ReactElement {
  return function SettingsCard({ onClose }: { onClose(): void }): ReactElement {
    const stored = profileStore.get()
    const [draft, setDraft] = useState<InvestorProfile>(stored ?? defaultProfile())
    const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
    useEffect(() => profileStore.subscribe(next => { if (next !== null) setDraft(next) }), [])

    const pill = (active: boolean): Record<string, string | number> => ({
      fontSize: 12, cursor: 'pointer', padding: '3px 11px', borderRadius: 999,
      border: `1px solid ${active ? 'rgba(86,134,254,.85)' : 'rgba(127,127,127,.35)'}`,
      background: active ? 'rgba(86,134,254,.14)' : 'transparent',
      color: 'inherit', fontWeight: active ? 600 : 400,
    })
    const row = (
      label: string, hint: string,
      options: [string, string][], current: string, pick: (v: string) => void,
    ): ReactElement => createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
      createElement('div', { style: { width: 52, fontSize: 12, opacity: 0.6, flexShrink: 0 } }, label),
      ...options.map(([value, text]) => createElement('button', {
        key: value, style: pill(current === value), onClick: () => { pick(value); setState('idle') },
      }, text)),
      createElement('div', { style: { fontSize: 11, opacity: 0.45, flexBasis: '100%' } }, hint),
    )

    return createElement('div', {
      style: {
        border: '1px solid rgba(86,134,254,.35)', borderRadius: 10, padding: 14,
        display: 'flex', flexDirection: 'column', gap: 12,
        background: 'rgba(86,134,254,.05)',
      },
    },
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        createElement('h2', { style: { fontSize: 14, fontWeight: 600, margin: 0 } }, '个性化'),
        createElement('span', { style: { fontSize: 11, opacity: 0.5 } },
          stored?.saved === true ? `已保存 · ${stored.updatedAt}` : '未设置，当前为默认档'),
        createElement('span', { style: { flex: 1 } }),
        createElement('button', {
          style: { fontSize: 12, cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', opacity: 0.6 },
          onClick: onClose,
        }, '收起'),
      ),
      row('详略', '速览＝3–5 句话给结论；深度＝不限制（当前 ✦ 分析的默认行为）',
        [['brief', PROFILE_LABELS.depth.brief], ['standard', PROFILE_LABELS.depth.standard], ['deep', PROFILE_LABELS.depth.deep]],
        draft.depth, v => setDraft({ ...draft, depth: v as ProfileDepth })),
      row('术语', 'PE、扣非、回撤位这类名词首次出现时用括号解释一句',
        [['explain', PROFILE_LABELS.jargon.explain], ['as-is', PROFILE_LABELS.jargon['as-is']]],
        draft.jargon, v => setDraft({ ...draft, jargon: v as ProfileJargon })),
      row('结构', '结论先行＝先说「所以该怎么想/怎么做」，再讲理由',
        [['conclusion-first', PROFILE_LABELS.order['conclusion-first']], ['reasoning-first', PROFILE_LABELS.order['reasoning-first']]],
        draft.order, v => setDraft({ ...draft, order: v as ProfileOrder })),
      createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        createElement('div', { style: { fontSize: 12, opacity: 0.6 } }, `一句话自述（选填，${PROFILE_NOTE_MAX} 字内）`),
        createElement('textarea', {
          value: draft.note,
          maxLength: PROFILE_NOTE_MAX,
          rows: 2,
          placeholder: '例：入市两年，看得懂财报但不熟技术分析；我最想知道该不该动手，别给我研报。',
          onChange: (e: { target: { value: string } }) => { setDraft({ ...draft, note: e.target.value }); setState('idle') },
          style: {
            fontSize: 12.5, lineHeight: 1.6, padding: '7px 9px', borderRadius: 8, resize: 'vertical',
            border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
            fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
          },
        }),
      ),
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        createElement('button', {
          disabled: state === 'saving',
          style: {
            fontSize: 12.5, cursor: 'pointer', padding: '5px 16px', borderRadius: 999, fontWeight: 500,
            border: '1px solid rgba(86,134,254,.7)', background: 'rgba(86,134,254,.14)', color: 'inherit',
            opacity: state === 'saving' ? 0.5 : 1,
          },
          onClick: () => {
            setState('saving')
            void saveProfile(ctx, draft).then(ok => setState(ok ? 'saved' : 'failed'))
          },
        }, state === 'saving' ? '保存中…' : '保存'),
        createElement('span', { style: { fontSize: 11.5, opacity: 0.55 } },
          state === 'saved' ? '✓ 已生效，之后的 ✦ 分析都会带上'
            : state === 'failed' ? '✗ 保存失败，取数通道不可用'
              : '只影响面板里的 ✦ 按钮，你自己手打的问题不受影响'),
      ),
    )
  }
}

/**
 * 工作台内容（右侧停靠面板用）。真数据：订阅 portfolioStore
 * （来源是会话内 astock_positions 工具结果），无数据时引导自然语言录入。
 */
function makeWorkbenchBody(ctx: ClientContext): (props: unknown) => ReactElement {
  const LinkButton = makeLinkButton(ctx)
  const RefreshButton = makeRefreshButton(ctx, refreshPortfolio, '直接执行 /portfolio 刷新本地持仓与最新行情，不发送 AI 对话消息')
  const RefreshLogsButton = makeRefreshButton(ctx, refreshDecisionLogs, '直接执行 /decision-logs 读取本地决策日志，不发送 AI 对话消息', { padding: '3px 9px' })
  const SettingsCard = makeSettingsCard(ctx)
  const StockActions = makeStockActions(ctx)
  return function WorkbenchBody(_props: unknown): ReactElement {
    const [showSettings, setShowSettings] = useState(false)
    const [data, setData] = useState<PortfolioData | null>(portfolioStore.get())
    const [logs, setLogs] = useState<DecisionLogsData>(decisionLogsStore.get())
    const [market, setMarket] = useState<MarketPayload | null>(marketStore.get())
    /** 距下一次自动刷新的秒数；null = 不在自动刷新状态（页面隐藏/非交易时段） */
    const [nextIn, setNextIn] = useState<number | null>(null)
    const nextAtRef = useRef(0)
    useEffect(() => portfolioStore.subscribe(setData), [])
    useEffect(() => marketStore.subscribe(setMarket), [])
    useEffect(() => decisionLogsStore.subscribe(setLogs), [])
    // 首屏自动拉取：面板打开即显示总资产与决策日志，无需先点刷新。
    // 只补空：持仓无数据、日志从未成功拉过才发命令（空日志的 loaded=false
    // 是唯一可靠判据，entries.length 恒 0）；两项都就绪后不再随会话切换
    // 重拉——面板数据是全局口径（holdings.csv/日志文件），与当前会话无关，
    // 会话切换重拉只会往会话里白写命令记录。
    useEffect(() => {
      const settled = (): boolean =>
        portfolioStore.get() !== null && decisionLogsStore.loaded
        && profileStore.get() !== null && marketStore.get() !== null
      const tryLoad = (): void => {
        if (portfolioStore.get() === null) void refreshPortfolio(ctx)
        if (!decisionLogsStore.loaded) void refreshDecisionLogs(ctx)
        // 画像要在第一次点 ✦ 之前就位，否则首次分析会漏掉个性化前缀
        if (profileStore.get() === null) void refreshProfile(ctx)
        if (marketStore.get() === null) void refreshMarket(ctx)
      }
      tryLoad()
      const sessions = ctx.get('sessions') as SessionsService | undefined
      let lastCurrent: string | undefined = sessions?.list?.getSnapshot?.()?.current
      const unsubscribe = sessions?.list?.subscribe?.(() => {
        if (settled()) return
        const cur = sessions.list.getSnapshot?.()?.current
        if (cur === lastCurrent) return
        lastCurrent = cur
        tryLoad()
      })
      return () => unsubscribe?.()
    }, [])

    // 盘中自动轮询：交易时段每 5s 走一次 /portfolio 免对话通道（经影子会话，
    // 命令事件不落真实对话），面板常开即「准实时」。页面隐藏时跳过（浏览器后台
    // 本就限流，别白打接口）；离开交易时段自然停。面板收起时本组件卸载，
    // interval 随之清理，不占后台。
    //
    // 倒计时（nextIn）与轮询同源：数据每落到 store 一次（自动或手动刷新完成），
    // 就把「下一次」重拨到数据到达那刻 + AUTO_REFRESH_MS，展示的秒数永远从
    // 新数据到达开始数——慢请求期间秒数会数到 0 停住，那是「取数中」的诚实展示。
    useEffect(() => {
      const arm = (): void => { nextAtRef.current = Date.now() + AUTO_REFRESH_MS }
      arm()
      const auto = setInterval(() => {
        if (document.hidden || !isMarketOpen()) return
        void refreshPortfolio(ctx)
        // 大盘条与持仓同频刷新（各自有取数互斥，一条链路慢不拖住另一条）
        void refreshMarket(ctx)
      }, AUTO_REFRESH_MS)
      const unsubStore = portfolioStore.subscribe(arm)
      const tick = setInterval(() => {
        // 非自动刷新状态显示 null（React 对相同值不会重渲染，重复 set 无副作用）
        if (document.hidden || !isMarketOpen()) {
          setNextIn(null)
          return
        }
        setNextIn(Math.max(0, Math.ceil((nextAtRef.current - Date.now()) / 1000)))
      }, 1000)
      return () => {
        clearInterval(auto)
        clearInterval(tick)
        unsubStore()
      }
    }, [])

    const card: Record<string, string | number> = {
      border: '1px solid rgba(127,127,127,.28)',
      borderRadius: 12,
      padding: '14px 16px',
      flex: '1 1 180px',
      minWidth: 180,
    }
    const k: Record<string, string | number> = { fontSize: 12, opacity: 0.6, marginBottom: 4 }
    const v: Record<string, string | number> = { fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }
    const d: Record<string, string | number> = { fontSize: 12, opacity: 0.65, marginTop: 2 }

    // ---- 空态：引导自然语言录入（不预置任何持仓） ----
    if (data === null || data.rows.length === 0) {
      const examples = [
        '我买了 600519 贵州茅台，100 股，成本 1700 元',
        '买入宁德时代 300750，200 股，每股 260，行业电池',
        '清仓宁德时代',
      ]
      return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, width: '100%', boxSizing: 'border-box' } },
        createElement('div', { style: { ...card, textAlign: 'center', padding: '26px 16px' } },
          createElement('div', { style: { fontSize: 30, marginBottom: 6 } }, '📋'),
          createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } },
            data === null ? '还没有持仓数据' : '持仓表是空的'),
          createElement('p', { style: { fontSize: 12.5, opacity: 0.65, margin: '0 0 14px', lineHeight: 1.7 } },
            data === null
              ? '不用手填表格——直接在左侧对话里说你的交易，AI 会记账并同步到这里。'
              : '直接在左侧对话里说你的交易，AI 会记账并同步到这里；也可以手动编辑 holdings.csv。'),
          ...examples.map(ex => createElement('button', {
            key: ex,
            onClick: () => {
              try { void navigator.clipboard?.writeText(ex) } catch { /* 剪贴板不可用就算了 */ }
            },
            title: '点击复制，粘贴到左侧输入框发送',
            style: {
              display: 'block', width: '100%', textAlign: 'left', cursor: 'copy',
              fontSize: 12, color: 'inherit', opacity: 0.75,
              background: 'rgba(127,127,127,.08)',
              border: '1px dashed rgba(127,127,127,.35)', borderRadius: 8,
              padding: '7px 10px', margin: '6px 0',
            },
          }, `“${ex}”`)),
        ),
        createElement(RefreshButton, null),
        createElement('p', { style: { textAlign: 'center', opacity: 0.5, fontSize: 11.5, margin: 0 } },
          '支持自然语言：买入/加仓/清仓/查行情 · 数字一律由本地计算 · 非投资建议',
        ),
      )
    }

    // ---- 数据态：全部来自工具返回（含行情时间与覆盖口径） ----
    const riskHeavy = data.rows.filter(r => num(r.weight) > 30)
    const staleHint = data.stale

    return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, width: '100%', boxSizing: 'border-box' } },
      // 口径标注 + 刷新 / 解读
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        createElement('span', { style: { fontSize: 11.5, opacity: 0.55 } },
          data.quoteTime !== '' ? `行情时间 ${data.quoteTime}` : '行情时间未知'),
        data.quoteTime !== '' && isCallAuctionQuoteTime(data.quoteTime)
          ? createElement('span', {
              style: { fontSize: 11.5, color: '#c77d1f' },
              title: '集合竞价（9:15–9:25）显示的是虚拟撮合参考价，9:25 才定开盘价，与券商 App 对数会有出入',
            }, '· 集合竞价，价格未定盘')
          : null,
        isMarketOpen()
          ? createElement('span', { style: { fontSize: 11.5, opacity: 0.45 }, title: '交易时段内每 5 秒自动刷新一次' },
              nextIn !== null ? `· ${nextIn}s 后自动刷新` : '· 盘中自动刷新')
          : null,
        staleHint
          ? createElement('span', { style: { fontSize: 11.5, color: '#c77d1f' } }, '· 持仓已变动，待刷新')
          : null,
        createElement('span', { style: { flex: 1 } }),
        createElement(RefreshButton, null),
        createElement('button', {
          title: '个性化：设置回答的详略、术语解释与结论位置（只影响面板 ✦ 按钮）',
          style: {
            fontSize: 12.5, cursor: 'pointer', color: 'inherit', padding: '4px 10px', borderRadius: 999,
            border: '1px solid rgba(127,127,127,.35)',
            background: showSettings ? 'rgba(86,134,254,.14)' : 'transparent',
          },
          onClick: () => setShowSettings(v => !v),
        }, '⚙'),
        createElement(LinkButton, {
          prompt: '帮我解读今天的持仓表现：哪些在涨、哪些在拖累，结构上有什么要注意的。解读完不要主动写决策日志；值得留存的话先问我。',
          label: '✦ AI 解读',
          withMarket: true,
          style: { background: 'rgba(127,127,127,.12)', fontWeight: 500 },
        }),
      ),
      showSettings ? createElement(SettingsCard, { onClose: () => setShowSettings(false) }) : null,
      createElement(MarketBar, { data: market }),
      // 速览卡
      createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
        createElement('div', { style: card },
          createElement('div', { style: k },
            data.cash !== undefined ? '总资产（持仓 + 现金）'
              : data.manualTotalAssets !== undefined && data.manualTotalAssets !== '—' ? '总资产（手动）'
                : '总资产（持仓口径）'),
          createElement('div', { style: v }, `¥${data.manualTotalAssets ?? data.totalAssets}`),
          createElement('div', { style: d },
            data.cash !== undefined ? `现金 ¥${data.cash} · 随行情更新`
              : data.manualTotalAssets !== undefined && data.manualTotalAssets !== '—'
                ? `手动设定 · 截至 ${data.manualAssetsDate}`
                : '不含现金余额'),
        ),
        createElement('div', { style: card },
          createElement('div', { style: k }, '总市值'),
          createElement('div', { style: v }, `¥${data.totalValue}`),
          createElement('div', { style: d }, `${data.rows.length} 只持仓`),
        ),
        createElement('div', { style: card },
          createElement('div', { style: k }, '当日参考盈亏'),
          createElement('div', { style: { ...v, color: cellColor(data.dayPnl) ?? 'inherit' } }, `${data.dayPnl} 元`),
          createElement(
            'div',
            { style: { ...d, color: cellColor(data.dayPnl) } },
            data.dayBasis ? `${data.dayPct} · ${data.dayBasis}` : data.dayPct,
          ),
        ),
        createElement('div', { style: card },
          createElement('div', { style: k }, '累计盈亏'),
          createElement('div', { style: { ...v, color: cellColor(data.totalPnlPct) ?? 'inherit', fontSize: 18 } }, `${data.totalPnl} 元`),
          createElement('div', { style: { ...d, color: cellColor(data.totalPnlPct) } }, data.totalPnlPct),
        ),
      ),
      // 持仓明细（全部字段直出工具结果，前端零计算）
      createElement('div', { style: card },
        createElement('h2', { style: { fontSize: 14, fontWeight: 600, margin: '0 0 2px' } }, '持仓明细'),
        createElement('div', { style: { overflowX: 'auto' } },
          createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' } },
            createElement('thead', null,
              createElement('tr', null,
                ...(['持仓', '现价', '今日', '股数@成本', '市值', '累计盈亏', '权重'].map(h =>
                  createElement('th', { key: h, style: { textAlign: h === '持仓' ? 'left' : 'right', fontSize: 11, fontWeight: 500, opacity: 0.55, padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,.25)', whiteSpace: 'nowrap' } }, h),
                )),
                createElement('th', { key: 'ai', style: { width: 36, padding: '6px 4px 6px 0', borderBottom: '1px solid rgba(127,127,127,.25)' } }, ''),
              ),
            ),
            createElement('tbody', null,
              ...data.rows.map(r => createElement('tr', { key: r.code },
                createElement('td', { style: { padding: '8px', borderBottom: '1px solid rgba(127,127,127,.16)', whiteSpace: 'nowrap' } },
                  createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
                    createElement('a', {
                      href: marketUrl(r.code), target: '_blank', rel: 'noreferrer noopener',
                      title: '在东方财富查看行情走势',
                      style: { color: 'inherit', textDecoration: 'none' },
                    }, createElement('b', { style: { fontWeight: 600 } }, r.name)),
                    createElement('span', { style: { opacity: 0.5, fontSize: 11, fontFamily: 'SF Mono, Menlo, Consolas, monospace' } }, r.code),
                  ),
                  createElement('div', { style: { display: 'flex', gap: 7, marginTop: 3 } },
                    createElement(ExternalLink, { href: marketUrl(r.code), label: '行情', title: '东方财富行情走势' }),
                    isLikelyFund(r.code)
                      ? null
                      : createElement(ExternalLink, { href: f10Url(r.code), label: 'F10', title: '同花顺 F10 公司资料' }),
                  ),
                ),
                createElement('td', { style: td }, r.price),
                createElement('td', { style: { ...td, color: cellColor(r.day) ?? 'inherit' } }, r.day),
                createElement('td', { style: { ...td, opacity: 0.7 } }, `${r.shares}@${r.cost}`),
                createElement('td', { style: td }, r.value),
                createElement('td', { style: { ...td, color: cellColor(r.pnl) ?? 'inherit' } }, r.pnl),
                createElement('td', { style: td },
                  r.weight,
                  createElement('span', { style: { display: 'inline-block', verticalAlign: 'middle', width: 44, height: 5, borderRadius: 3, background: 'rgba(127,127,127,.2)', marginLeft: 7, position: 'relative', overflow: 'hidden' } },
                    createElement('i', { style: { position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, num(r.weight))}%`, background: 'rgba(86,134,254,.8)' } }),
                  ),
                ),
                createElement('td', { style: { ...td, width: 36, paddingRight: 0 } },
                  createElement(StockActions, { code: r.code, name: r.name }),
                ),
              )),
            ),
          ),
        ),
      ),
      createElement('div', { style: card },
        createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          createElement('h2', { style: { fontSize: 14, fontWeight: 600, margin: 0 } }, '交易日决策日志'),
          createElement('span', { style: { flex: 1 } }),
          createElement(RefreshLogsButton, null),
          createElement(LinkButton, {
            prompt: '请读取我的最近交易日决策日志，并结合 astock_positions 和 astock_quote，复盘当时的观察、决策依据、实际结果和风险暴露。指出哪些判断被事实支持、哪些被证伪，并提出下一次需要验证的问题。不要替我下单。',
            withMarket: true,
            label: 'AI 复盘',
            style: { padding: '3px 9px', background: 'rgba(127,127,127,.12)' },
          }),
        ),
        logs.entries.length === 0
          ? createElement('div', { style: { fontSize: 12.5, opacity: 0.6 } }, '暂无日志。需要记录时直接对 AI 说「记录今天的决策日志」。')
          : createElement(DecisionLogList, { entries: logs.entries }),
      ),
      // 风险提示（数据驱动：权重>30% 才出现）
      riskHeavy.length > 0
        ? createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start', background: 'rgba(245,158,11,.12)', color: '#c77d1f', borderRadius: 12, padding: '11px 14px', fontSize: 12.5, flexWrap: 'wrap' } },
            createElement('span', null, '⚠️'),
            createElement('span', null,
              [
                riskHeavy.length > 0 ? `${riskHeavy.map(r => `${r.name} ${r.weight}`).join('、')} 权重超 30%（集中度偏高）` : '',
              ].filter(s => s !== '').join('；') + '。',
            ),
            createElement('span', { style: { flex: 1 } }),
            createElement(LinkButton, {
              prompt: '给我的持仓做一次体检：集中度、浮亏、盈利结构，能算的都算给我看。',
              withMarket: true,
              label: '让 AI 体检 →',
              style: { border: 'none', padding: 0, textDecoration: 'underline', textUnderlineOffset: 3, fontWeight: 500, fontSize: 12.5 },
            }),
          )
        : null,
      createElement('p', { style: { textAlign: 'center', opacity: 0.5, fontSize: 11.5, margin: 0 } },
        '行情来源：同花顺 fuyao（主）+ 腾讯（兜底） · 所有数字由本地计算 · 非投资建议',
      ),
    )
  }
}

const td: Record<string, string | number> = {
  padding: '8px',
  textAlign: 'right',
  borderBottom: '1px solid rgba(127,127,127,.16)',
  whiteSpace: 'nowrap',
}

// ---------- astock_* 工具结果渲染（tool.call.toolview，keyed by 工具名） ----------

/** 从冻结的调用块中宽容提取结果文本（block 形态随 dsh 版本演进，这里不做强断言） */
function resultText(block: unknown): string {
  if (block === null || typeof block !== 'object') return ''
  const b = block as Record<string, unknown>
  const candidates = [b.result, b.output, b]
  for (const c of candidates) {
    if (c === null || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    if (Array.isArray(o.content)) {
      const text = (o.content as unknown[])
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && (p as Record<string, unknown>).type === 'text')
        .map(p => String((p as Record<string, unknown>).text ?? ''))
        .join('\n')
      if (text !== '') return text
    }
    if (typeof o.text === 'string' && o.text !== '') return o.text
  }
  return ''
}

/**
 * 工具块生命周期判定（对齐 ui-chat 契约：settled 块带 kind:'tool-result'，
 * running 块无 kind 字段；错误态看 isError）。
 */
function blockState(block: unknown): 'running' | 'ok' | 'error' {
  const b = block as Record<string, unknown> | null
  if (b === null || typeof b !== 'object' || !('kind' in b)) return 'running'
  if (b.kind !== 'tool-result') return 'running'
  return b.isError === true ? 'error' : 'ok'
}

// ---------- 内嵌 HTML 图解（astock_show_html，2026-09-10） ----------
//
// 呈现位置是 turn 尾部（conversation.chat.turnTail 链，与原生「产出文件」chips 同一条
// chain）：工具调用组默认整体折叠，预览藏在里面等于看不见（2026-09-10 实测），卡片必须
// 长在 AI 消息正文下方才会被看到。数据链路：会话事件（tool/result）经节点定义逐 turn
// 累积载荷 → turn data → select 认领 → 卡片；会话重建时事件重放、同样恢复。
// sandbox 只给 allow-scripts：脚本可跑，无同源、无存储、无弹窗，模型生成的页面天然关在笼子里。
//
// 节点定义的 start/update/buildLocationData 首参一律是 context（.state 取状态），不是
// state 本身。首版按 state 写，update 里读 state.items 直接抛 TypeError；assembler 没有
// try/catch，整条 tool/result 事件被丢掉——所有工具调用都settle不了，轨迹全标 interrupted、
// 对话里图解位置显示「调用失败」（2026-09-10 实测并修）。

/** 单条图解（载荷在事件累积时解码，渲染层拿到的就是 html 原文） */
interface HtmlPreviewItem {
  title: string
  file: string
  html: string
}

/** 一 turn 内最多渲染几张图解：正常一轮一张，兜顶防刷屏 */
const HTML_PREVIEW_PER_TURN = 4

/**
 * 宽容提取结果文本：text 部分在冻结块顶层是 {type:'text'}，在会话事件里却嵌在
 * {type:'tool-result', content:[…]} 里（2026-09-10 实测）。两种形态都接，递归下钻一层。
 */
function extractResultText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (typeof p.text === 'string') { out.push(p.text); continue }
    if (Array.isArray(p.content)) out.push(extractResultText(p.content))
  }
  return out.join('\n')
}

/** 一 turn 内累积到的图解（engine 持有的 State） */
interface HtmlPreviewState {
  turn: number
  items: HtmlPreviewItem[]
}

/**
 * 会话事件累积器（ConversationNodeDefinition 契约，形状对齐 ui-deliverables 的
 * deliverablesDefinition）。三个回调的首参都是 **context**（带 .state），不是 state 本身。
 */
const htmlPreviewDefinition = {
  kind: 'astockHtmlPreview',
  match(
    event: { type: string; surfaceOp?: unknown; data?: { turn?: number } },
  ): { id: string; role: 'start' | 'update' } | null {
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') {
      return { id: String(event.data.turn), role: 'start' }
    }
    // 结果事件不带工具名：先全收，update 里靠解码失败天然过滤掉别人的工具。
    // 只收 append 原生结果——replace 是模型可见面的影子拷贝，收了会把同一张图记两次。
    if (event.type === 'tool/result' && event.surfaceOp === 'append' && typeof event.data?.turn === 'number') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start(
    _context: unknown,
    match: { event: { type: string; data: { turn: number } } },
  ): HtmlPreviewState {
    if (match.event.type !== 'turn/start') throw new Error('astockHtmlPreview 的 start 只接 turn/start')
    return { turn: match.event.data.turn, items: [] }
  },
  update(
    context: { state: HtmlPreviewState },
    match: { event: { type: string; data?: Record<string, unknown> } },
  ): HtmlPreviewState {
    const state = context.state
    if (match.event.type !== 'tool/result' || state.items.length >= HTML_PREVIEW_PER_TURN) return state
    const message = match.event.data?.message as
      | { isError?: boolean; content?: unknown }
      | undefined
    if (message === undefined || message.isError === true || !Array.isArray(message.content)) return state
    const text = extractResultText(message.content)
    const preview = decodeHtmlPreviewTag(text)
    if (preview === null) return state
    return { turn: state.turn, items: [...state.items, { title: preview.title, file: preview.file, html: preview.html }] }
  },
  buildLocationData(
    context: { state?: HtmlPreviewState },
    scope: string,
    previous: { kind: string; turn: number; key: string; value: { items: HtmlPreviewItem[] } } | null | undefined,
  ): { kind: 'turn'; turn: number; key: string; value: { items: HtmlPreviewItem[] } } | null {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn' && previous.turn === context.state.turn
      && previous.key === 'astockHtmlPreview' && previous.value.items === context.state.items) {
      // 判别字段是运行时手工核对的（kind: string 收窄不了字面量），断言安全
      return previous as { kind: 'turn'; turn: number; key: string; value: { items: HtmlPreviewItem[] } }
    }
    return { kind: 'turn', turn: context.state.turn, key: 'astockHtmlPreview', value: { items: context.state.items } }
  },
}

/** 新标签页独立打开：blob URL 不依赖存档路径，旧会话里的图解也能直接看 */
function openHtmlInNewWindow(html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html; charset=utf-8' }))
  window.open(url, '_blank', 'noopener')
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const htmlPreviewButtonStyle = {
  fontSize: 11, opacity: 0.6, cursor: 'pointer',
  border: 'none', background: 'transparent', padding: '0 4px',
} as const

function HtmlPreviewCard(props: { preview: HtmlPreviewItem }): ReactElement {
  const { preview } = props
  const [expanded, setExpanded] = useState(false)
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('span', {
        style: {
          fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, `🎨 ${preview.title}`),
      createElement('button', {
        type: 'button', onClick: () => openHtmlInNewWindow(preview.html), style: htmlPreviewButtonStyle,
      }, '独立窗口'),
      createElement('button', {
        type: 'button', onClick: () => setExpanded(v => !v), style: htmlPreviewButtonStyle,
      }, expanded ? '收起' : '放大'),
    ),
    createElement('iframe', {
      sandbox: 'allow-scripts',
      srcDoc: preview.html,
      title: preview.title,
      style: {
        width: '100%',
        height: expanded ? 720 : 420,
        border: '1px solid rgba(127,127,127,.22)',
        borderRadius: 8,
        background: '#fff',
      },
    }),
    preview.file !== ''
      ? createElement('div', { style: { fontSize: 10.5, opacity: 0.45 } }, `已存档：${preview.file}`)
      : null,
  )
}

/** turn 尾部卡片链入口：select 把认领到的图解 items 以 matched 传入 */
function HtmlPreviewTail(props: Record<string, unknown>): ReactElement {
  const items = Array.isArray(props.matched) ? props.matched as HtmlPreviewItem[] : []
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '6px 0' } },
    ...items.map((it, i) => createElement(HtmlPreviewCard, { key: i, preview: it })),
  )
}

/** 折叠工具组里的占位行：结果本体在消息下方的卡片，这里只留一行摘要（base64 别漏出来） */
function HtmlToolStub(props: Record<string, unknown>): ReactElement {
  const block = props.block
  const state = blockState(block)
  const raw = state === 'running' ? '' : extractResultText((block as Record<string, unknown> | undefined)?.content)
  if (state === 'running') {
    return createElement('div', { style: { fontSize: 12.5, opacity: 0.65, padding: '2px 0' } },
      '生成图解中…',
    )
  }
  if (state === 'error') {
    // 把工具报错原文带出来（截断）：调用失败不再是无头案
    return createElement('div', { style: { fontSize: 12.5, color: UP, padding: '2px 0' } },
      `astock_show_html 调用失败${raw !== '' ? `：${raw.slice(0, 140)}` : ''}`,
    )
  }
  const title = decodeHtmlPreviewTag(raw)?.title ?? ''
  return createElement('div', { style: { fontSize: 12, opacity: 0.6, padding: '2px 0' } },
    `🎨 图解「${title}」已生成——正文下方内嵌预览`,
  )
}

// ---------- 诊断书卡片（astock_analyze，2026-09-06 原型 A 定案） ----------
//
// 呈现宿主是对话流工具卡片（窄幅）：确定性判定标签 + 迷你 K 线 + 关键数字 +
// 持仓上下文全部来自载荷；AI 的三段白话解读在会话文本里，不进卡片。
// 手写 SVG（零依赖纪律，不引图表库）；数据不足就少画，绝不占位猜数。

const TONE_COLOR: Record<string, string> = { up: UP, down: DOWN, flat: 'rgba(127,127,127,.85)' }

/** 迷你 K 线：仅蜡烛 + 持仓成本虚线，量能不画（窄卡里信息密度优先给价格） */
function miniKlineSvg(bars: AnalyzePayload['bars'], cost: number | null): ReactElement {
  const W = 320
  const H = 116
  if (bars.length === 0) {
    return createElement('div', { style: { fontSize: 11, opacity: 0.55, padding: '6px 0' } }, '（无K线数据）')
  }
  const lo = Math.min(...bars.map(b => b[4]))
  const hi = Math.max(...bars.map(b => b[3]))
  const span = hi > lo ? hi - lo : 1
  const y = (p: number): number => 4 + (hi - p) / span * (H - 8)
  const step = W / bars.length
  const bw = Math.max(1, step * 0.6)
  const els: ReactElement[] = []
  bars.forEach((b, i) => {
    const [, o, c, h, l] = b
    const x = i * step + step / 2
    const col = c >= o ? UP : DOWN
    els.push(createElement('line', {
      key: `w${i}`, x1: x, x2: x, y1: y(h), y2: y(l),
      stroke: col, strokeWidth: 1,
    }))
    els.push(createElement('rect', {
      key: `b${i}`, x: x - bw / 2, y: y(Math.max(o, c)), width: bw,
      height: Math.max(1, Math.abs(y(o) - y(c))), fill: col,
    }))
  })
  if (cost !== null && cost >= lo && cost <= hi) {
    els.push(createElement('line', {
      key: 'cost', x1: 0, x2: W, y1: y(cost), y2: y(cost),
      stroke: 'rgba(127,157,255,.9)', strokeWidth: 1, strokeDasharray: '3 3',
    }))
  }
  return createElement('svg', { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', display: 'block', margin: '6px 0 2px' } }, ...els)
}

function AnalyzeCard(payload: AnalyzePayload): ReactElement {
  const { holding } = payload
  const pct = (n: number | null): string =>
    n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
  const n2 = (n: number | null): string => (n === null ? '—' : n.toFixed(2))
  const stats: [string, string][] = [
    ['MA5', n2(payload.ma5)],
    ['MA20', n2(payload.ma20)],
    ['量比', payload.volRatio === null ? '—' : `${payload.volRatio.toFixed(1)}×`],
    ['20日区间', payload.low20 === null ? '—' : `${payload.low20.toFixed(2)}~${payload.high20?.toFixed(2)}`],
    ['5日收益', payload.benchRet5 === null ? pct(payload.ret5) : `${pct(payload.ret5)}（基准 ${pct(payload.benchRet5)}）`],
    ['20日收益', pct(payload.ret20)],
  ]
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 0' } },
    // 头：标的 + 现价
    createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
      createElement('span', { style: { fontSize: 12.5, fontWeight: 600 } },
        `个股诊断 · ${payload.name || payload.symbol}`),
      payload.price !== null
        ? createElement('span', { style: { fontSize: 12.5, fontWeight: 600, color: (payload.changePct ?? 0) >= 0 ? UP : DOWN } },
            `${payload.price.toFixed(2)}（${pct(payload.changePct)}）`)
        : null,
      payload.klineSource !== null
        ? createElement('span', { style: { fontSize: 10, opacity: 0.45 } }, `K线 ${payload.klineSource}·前复权`)
        : null,
    ),
    // 判定标签（确定性结论，AI 只展开不推翻）
    createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
      ...payload.tags.map((t, i) => createElement('span', {
        key: i,
        style: {
          fontSize: 10.5, padding: '1px 7px', borderRadius: 999,
          border: `1px solid ${TONE_COLOR[t.tone]}`, color: TONE_COLOR[t.tone],
        },
      }, t.label)),
    ),
    miniKlineSvg(payload.bars, holding?.cost ?? null),
    // 关键数字条
    createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2px 10px' } },
      ...stats.map(([k, v]) => createElement('div', { key: k, style: { fontSize: 11 } },
        createElement('span', { style: { opacity: 0.5, marginRight: 4 } }, k), v)),
    ),
    // 持仓上下文
    holding !== null
      ? createElement('div', { style: { fontSize: 11, opacity: 0.75, padding: '2px 0' } },
          `持有 ${holding.shares} 股 · 成本 ${holding.cost.toFixed(2)} · 浮动盈亏 `,
          createElement('span', { style: { color: (holding.pnl ?? 0) >= 0 ? UP : DOWN, fontWeight: 600 } },
            `${holding.pnl === null ? '—' : holding.pnl.toFixed(0)} 元（${pct(holding.pnlPct)}）`),
          holding.weightPct === null ? '' : ` · 权重 ${holding.weightPct.toFixed(1)}%`)
      : createElement('div', { style: { fontSize: 11, opacity: 0.55, padding: '2px 0' } }, '未持有该标的'),
    payload.klineError !== null
      ? createElement('div', { style: { fontSize: 11, color: DOWN } }, `⚠️ ${payload.klineError}（趋势/量能/位置判定不可用）`)
      : null,
  )
}

/** 把 Host 半面 format.ts 的 markdown 表格输出解析成节点（非表格行按普通文本渲染） */
function AstockToolRow(props: Record<string, unknown>): ReactElement {
  const toolName = String(props.toolName ?? 'astock')
  const block = props.block
  const state = blockState(block)
  const raw = state === 'ok' ? resultText(block) : ''
  // astock_analyze：先取诊断载荷给专用卡片；其余工具剥 portfolio 载荷给人看
  const analyze = toolName === 'astock_analyze' && state === 'ok' ? decodeAnalyzeTag(raw) : null
  const text = toolName === 'astock_analyze' ? stripTag('analyze', raw) : stripPayloadTag(raw)

  // 数据泵：positions 结果 → 共享 store（面板订阅）；add/remove 完成 → 标记过期
  useEffect(() => {
    if (state !== 'ok') return
    if (toolName === 'astock_positions') {
      const parsed = parsePositionsText(raw)
      if (parsed !== null) portfolioStore.set(parsed)
    } else if (toolName === 'astock_decision_logs') {
      decisionLogsStore.set(parseDecisionLogsText(text))
    } else if (toolName === 'astock_add_position' || toolName === 'astock_remove_position') {
      portfolioStore.markStale()
    } else if (toolName === 'astock_reconcile') {
      // 对账写入成功的返回带「持仓表已更新」；预览结果不动 store
      if (text.includes('持仓表已更新')) portfolioStore.markStale()
    }
  }, [toolName, state, text, raw])

  if (state === 'running') {
    return createElement('div', { style: { fontSize: 12.5, opacity: 0.65, padding: '2px 0' } },
      `${toolName} 调用中…`,
    )
  }
  if (state === 'error') {
    return createElement('div', { style: { fontSize: 12.5, color: UP, padding: '2px 0' } },
      `${toolName} 调用失败`,
    )
  }

  // 诊断载荷在 → 走诊断书专用卡片；载荷解析失败才回退通用 markdown 渲染
  if (analyze !== null) {
    return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      createElement('div', { style: { fontSize: 11, opacity: 0.5 } }, `⚙ ${toolName}`),
      AnalyzeCard(analyze),
    )
  }

  const nodes: ReactElement[] = []
  const tableRows: ReactElement[] = []
  let hasHead = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('## ')) {
      nodes.push(createElement('div', { key: nodes.length, style: { fontSize: 12, fontWeight: 600, opacity: 0.7, margin: '4px 0 2px' } }, trimmed.slice(3)))
      continue
    }
    if (trimmed.startsWith('|')) {
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())
      if (cells.length === 0 || cells.every(c => /^:?-{2,}:?$/.test(c))) continue
      if (!hasHead && trimmed.includes('代码')) {
        hasHead = true
        nodes.push(createElement('table', { key: nodes.length, style: { borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums', margin: '2px 0' } },
          createElement('thead', null,
            createElement('tr', null, ...cells.map((c, i) =>
              createElement('th', { key: i, style: { textAlign: i === 0 || i === 1 ? 'left' : 'right', fontSize: 10.5, fontWeight: 500, opacity: 0.55, padding: '4px 8px', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(127,127,127,.25)' } }, c),
            )),
          ),
          createElement('tbody', { key: 'tbody' }),
        ))
      } else if (hasHead) {
        tableRows.push(createElement('tr', { key: tableRows.length }, ...cells.map((c, i) => {
          const color = cellColor(c)
          return createElement('td', { key: i, style: { textAlign: i === 0 || i === 1 ? 'left' : 'right', fontSize: 12.5, padding: '5px 8px', whiteSpace: 'nowrap', color } }, c)
        })))
      } else {
        nodes.push(createElement('div', { key: nodes.length, style: { fontSize: 12.5, padding: '2px 0', whiteSpace: 'pre-wrap' } }, trimmed))
      }
      continue
    }
    // astock_quote 的列表行：涨跌在「（+x / +x%）」括号里，行级上色
    const lineColor = trimmed.startsWith('- ') && trimmed.includes('：')
      ? (trimmed.includes('（+') || trimmed.includes('(+') ? UP : trimmed.includes('（−') || trimmed.includes('(−') || trimmed.includes('(-') ? DOWN : undefined)
      : undefined
    nodes.push(createElement('div', { key: nodes.length, style: { fontSize: 12, opacity: lineColor === undefined ? 0.65 : 0.85, padding: '2px 0', color: lineColor } }, trimmed))
  }

  // 表体行挂到表头所在的 table（倒数第二项的 tbody 占位）
  if (tableRows.length > 0 && hasHead) {
    const tableIdx = nodes.length - 1
    const table = nodes[tableIdx] as { props: { children: ReactElement[] } }
    table.props.children[1] = createElement('tbody', null, ...tableRows)
  }

  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
    createElement('div', { style: { fontSize: 11, opacity: 0.5 } }, `⚙ ${toolName}`),
    ...nodes,
  )
}

// ---------- 右侧停靠面板（shell.overlay：官方浮层扩展点，list 型不冲突） ----------

/** ui-layout 的布局服务：面板展开时收起原生 Details 避免右栏叠压 */
interface LayoutService {
  closeDetails(): void
}

/**
 * 对话列让位：dsh 三栏布局不开放给第三方，右栏（Details）无扩展点，
 * 面板只能走 shell.overlay 浮层。为避免浮层盖住对话，注入全局 CSS 让
 * AppFrame 的中间列（data-shell-overlay 父根的第 2 个子元素，结构见
 * ui-layout AppFrame.tsx：sidebar/center/details/overlay 顺序固定）按面板
 * 宽度收缩 margin-right；45vw 上限保证小屏不把对话挤没。
 * 拖动中（.astock-panel-resizing）关闭过渡保跟手，开关时平滑过渡。
 */
const PANEL_CSS = `
:has(> [data-shell-overlay]) > :nth-child(2) {
  margin-right: min(var(--astock-panel-w, 0px), 45vw) !important;
  transition: margin-right .18s ease-out;
}
html:has(.astock-panel-resizing) :has(> [data-shell-overlay]) > :nth-child(2) {
  transition: none !important;
}
.astock-panel { transition: width .18s ease-out; }
html:has(.astock-panel-resizing) .astock-panel { transition: none !important; }
`

function ensurePanelCss(): void {
  if (document.getElementById('astock-panel-style') !== null) return
  const style = document.createElement('style')
  style.id = 'astock-panel-style'
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

/**
 * 工作台右侧停靠面板：对话在左、工作台在右，互不遮挡。
 * - 展开时贴右停靠（玻璃拟态底，主题自适应），并主动收起原生 Details 栏；
 * - 收起时右缘留竖把手一键唤回；
 * - 左缘拖拽手柄调宽（对齐 dsh 原生 Details 栏的交互）：Pointer capture 跟踪、
 *   clamp 到 [PANEL_MIN, PANEL_MAX]、双击手柄恢复默认宽；开合与宽度均存 localStorage。
 */
function makeSidePanel(ctx: ClientContext): (props: unknown) => ReactElement {
  const Body = makeWorkbenchBody(ctx)
  const OPEN_KEY = 'astock-workbench:side-panel-open'
  const WIDTH_KEY = 'astock-workbench:side-panel-width'
  const PANEL_MIN = 320
  const PANEL_MAX = 860
  const PANEL_DEFAULT = 460
  const clampWidth = (px: number): number => Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(px)))
  const readStoredWidth = (): number => {
    try {
      const raw = Number(globalThis.localStorage?.getItem(WIDTH_KEY))
      return Number.isFinite(raw) && raw > 0 ? clampWidth(raw) : PANEL_DEFAULT
    } catch { return PANEL_DEFAULT }
  }

  return function SidePanel(_props: unknown): ReactElement {
    const [open, setOpen] = useState<boolean>(() => {
      try { return globalThis.localStorage?.getItem(OPEN_KEY) !== '0' } catch { return true }
    })
    const [width, setWidth] = useState<number>(readStoredWidth)
    const [dragging, setDragging] = useState<boolean>(false)
    const dragStartX = useRef(0)
    const dragStartW = useRef(0)

    // 对话列让位：面板开合/宽度变化实时同步 CSS 变量（注入的规则消费它）
    useEffect(() => {
      document.documentElement.style.setProperty('--astock-panel-w', open ? `${width}px` : '0px')
    }, [open, width])

    const toggle = (next: boolean): void => {
      setOpen(next)
      try { globalThis.localStorage?.setItem(OPEN_KEY, next ? '1' : '0') } catch { /* 私隐模式等场景静默 */ }
      if (next) {
        // 让出右栏：原生 Details 打开时收起，避免两个右栏叠压
        try { (ctx.get('layout') as LayoutService | undefined)?.closeDetails?.() } catch { /* 服务未就绪则算了 */ }
      }
    }

    // 拖拽调宽：pointer capture 让指针移出手柄仍持续跟踪；拖拽期间禁掉文本选择
    const onResizeStart = (e: ReactPointerEvent<HTMLElement>): void => {
      e.preventDefault()
      dragStartX.current = e.clientX
      dragStartW.current = width
      setDragging(true)
      e.currentTarget.setPointerCapture(e.pointerId)
      const body = document.body
      body.style.userSelect = 'none'
    }
    const onResizeMove = (e: ReactPointerEvent<HTMLElement>): void => {
      if (!dragging) return
      // 面板贴右缘：指针左移（dx<0）= 变宽
      setWidth(clampWidth(dragStartW.current + (dragStartX.current - e.clientX)))
    }
    const onResizeEnd = (e: ReactPointerEvent<HTMLElement>): void => {
      if (!dragging) return
      setDragging(false)
      e.currentTarget.releasePointerCapture(e.pointerId)
      document.body.style.userSelect = ''
      setWidth(current => {
        try { globalThis.localStorage?.setItem(WIDTH_KEY, String(current)) } catch { /* 静默 */ }
        return current
      })
    }
    const onResizeReset = (): void => {
      setWidth(PANEL_DEFAULT)
      try { globalThis.localStorage?.setItem(WIDTH_KEY, String(PANEL_DEFAULT)) } catch { /* 静默 */ }
    }

    if (!open) {
      return createElement('button', {
        onClick: () => toggle(true),
        title: '展开工作台面板',
        'aria-label': '展开工作台面板',
        style: {
          position: 'absolute', right: 0, top: '38%',
          writingMode: 'vertical-rl' as const,
          padding: '14px 6px',
          fontSize: 12, letterSpacing: 2, cursor: 'pointer',
          color: 'inherit',
          background: 'rgba(127,127,127,.12)',
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(127,127,127,.3)', borderRight: 'none',
          borderRadius: '10px 0 0 10px',
        },
      }, '工作台 📊')
    }

    return createElement('div', {
      className: `astock-panel${dragging ? ' astock-panel-resizing' : ''}`,
      style: {
        position: 'absolute', right: 0, top: 0, bottom: 0,
        width, maxWidth: '94vw',
        display: 'flex', flexDirection: 'column',
        boxSizing: 'border-box',
        background: 'rgba(127,127,127,.10)',
        backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        borderLeft: '1px solid rgba(127,127,127,.28)',
        boxShadow: '-12px 0 32px rgba(0,0,0,.10)',
      },
    },
      // 左缘拖拽手柄（跨在边框上更好抓）：拖动调宽，双击恢复默认
      createElement('div', {
        role: 'separator', 'aria-orientation': 'vertical',
        'aria-label': '拖动调整工作台宽度，双击恢复默认',
        title: '拖动调整宽度 · 双击恢复默认',
        tabIndex: 0,
        onPointerDown: onResizeStart,
        onPointerMove: onResizeMove,
        onPointerUp: onResizeEnd,
        onPointerCancel: onResizeEnd,
        onDoubleClick: onResizeReset,
        onKeyDown: (e: { key: string; preventDefault(): void }) => {
          // 键盘可调：← 变宽、→ 变窄（步进 24px）
          if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(w => clampWidth(w + 24)) }
          if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(w => clampWidth(w - 24)) }
        },
        style: {
          position: 'absolute', left: -4, top: 0, bottom: 0,
          width: 8, zIndex: 5,
          cursor: 'col-resize', touchAction: 'none',
          background: dragging ? 'rgba(86,134,254,.5)' : 'transparent',
          borderRadius: 4,
        },
      }),
      // 头部
      createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 14px', flex: 'none',
          borderBottom: '1px solid rgba(127,127,127,.22)',
        },
      },
        createElement('span', { style: { fontSize: 14, fontWeight: 600 } }, '📊 工作台'),
        createElement('span', { style: { fontSize: 11, opacity: 0.5 } }, 'A股持仓'),
        createElement('span', { style: { flex: 1 } }),
        createElement('button', {
          onClick: () => toggle(false),
          title: '收起面板', 'aria-label': '收起工作台面板',
          style: {
            cursor: 'pointer', color: 'inherit', background: 'transparent',
            border: 'none', fontSize: 12, opacity: 0.6, padding: '4px 6px',
          },
        }, '收起 »'),
      ),
      // 内容滚动区
      createElement('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '14px' } },
        createElement(Body, null),
      ),
    )
  }
}

// ---------- 快捷按钮（conversation.input.left） ----------

function makeQuickRow(ctx: ClientContext): (props: never) => ReactElement {
  const LinkButton = makeLinkButton(ctx)
  return function QuickRow(_props: never): ReactElement {
    return createElement('div', { style: { display: 'flex', gap: 6 } },
      createElement(LinkButton, { prompt: '看看我的持仓', label: '📈 持仓' }),
      createElement(LinkButton, { prompt: '生成今日收盘简报', label: '📰 简报', withMarket: true }),
    )
  }
}

// ---------- 插件入口 ----------

export const name = 'astock-workbench/client'

export const inject = ['slots', 'uiConversation', 'remote', 'remote.commands']

const ASTOCK_TOOLS = [
  'astock_positions',
  'astock_quote',
  'astock_analyze',
  'astock_add_position',
  'astock_remove_position',
  'astock_reconcile',
  'astock_log_decision',
  'astock_decision_logs',
] as const

export function apply(ctx: ClientContext): void {
  ensurePanelCss()

  // 右侧停靠面板：对话在左、工作台在右（shell.overlay 是官方浮层扩展点，
  // list 型叠加不冲突；原生右栏 Details 无第三方槽位，故走此层停靠，
  // 并经全局 CSS 让 AppFrame 对话列按面板宽度收缩，实现真并排不遮挡）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'astock-workbench-panel' },
    makeSidePanel(ctx),
  ))

  for (const tool of ASTOCK_TOOLS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key: tool },
      AstockToolRow,
    ))
  }

  // astock_show_html 在折叠的工具组里只留一行干净摘要（防 base64 漏出来）；
  // 结果本体走下面的 turn 尾部卡片
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'astock_show_html' },
    HtmlToolStub,
  ))

  // 图解卡片长在 AI 消息正文下方：turn 尾部链（conversation.chat.turnTail，
  // 与原生「产出文件」chips 同一条 chain），会话重建时事件重放、卡片随之恢复。
  // uiConversation 缺席（异常组合）时静默不挂，工具组里仍有摘要行兜底。
  ctx.uiConversation?.events.register(htmlPreviewDefinition)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
    {
      name: 'conversation.chat.turnTail',
      select: (owner: unknown): HtmlPreviewItem[] | null => {
        const items = (owner as { turn?: { data?: Map<string, { items?: HtmlPreviewItem[] }> } } | null)
          ?.turn?.data?.get?.('astockHtmlPreview')?.items
        return Array.isArray(items) && items.length > 0 ? items : null
      },
    },
    HtmlPreviewTail,
  ))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: 'astock-quick' },
    makeQuickRow(ctx),
  ))
}
