/**
 * 投资者画像 —— 面板 AI 入口的个性化设置。
 *
 * 解决的问题：开放问题（「帮我分析 X」）会让模型用「全面覆盖」对冲不确定性，
 * 于是七个章节一起端上来。画像把「要多细、术语解不解释、先给结论还是先给论证」
 * 三件事说死，模型就不用猜。
 *
 * 为什么只有三档而不是十个维度：用户答不上来自己要什么风格，直到看见输出。
 * 先给最少的档位跑一阵，再按实际使用补——不要一上来就设计一张问卷。
 *
 * 与 dto.ts 一样是纯类型 + 纯函数、零 import，client 半面可直接 import；
 * 文件读写在 profile-store.ts（带 fs，host 专用）。
 */

/** 画像版本：client 认不出的版本按「未设置」处理，绝不猜字段 */
export const INVESTOR_PROFILE_VERSION = 1

/** 详略档：影响输出长度与章节数 */
export type ProfileDepth = 'brief' | 'standard' | 'deep'
/** 术语档：专业名词是否随手解释 */
export type ProfileJargon = 'explain' | 'as-is'
/** 结构档：结论在前还是论证在前 */
export type ProfileOrder = 'conclusion-first' | 'reasoning-first'

export interface InvestorProfile {
  v: typeof INVESTOR_PROFILE_VERSION
  depth: ProfileDepth
  jargon: ProfileJargon
  order: ProfileOrder
  /** 一句话自述（兜底的自由输入，可空） */
  note: string
  updatedAt: string
}

/** 默认画像：标准长度、解释术语、结论先行——按「多数人是学习者」取的保守默认 */
export function defaultProfile(updatedAt = ''): InvestorProfile {
  return {
    v: INVESTOR_PROFILE_VERSION,
    depth: 'standard',
    jargon: 'explain',
    order: 'conclusion-first',
    note: '',
    updatedAt,
  }
}

const DEPTHS: ProfileDepth[] = ['brief', 'standard', 'deep']
const JARGONS: ProfileJargon[] = ['explain', 'as-is']
const ORDERS: ProfileOrder[] = ['conclusion-first', 'reasoning-first']

/** 一句话自述的长度上限：它会进每条 prompt，别让它变成小作文 */
export const PROFILE_NOTE_MAX = 200

/**
 * 宽松校验：认不出的字段一律退回默认值，绝不抛错。
 * 画像是锦上添花的偏好，任何一处坏掉都不该让面板或分析功能挂掉。
 */
export function normalizeProfile(input: unknown, updatedAt = ''): InvestorProfile {
  const base = defaultProfile(updatedAt)
  if (input === null || typeof input !== 'object') return base
  const raw = input as Record<string, unknown>
  return {
    v: INVESTOR_PROFILE_VERSION,
    depth: DEPTHS.includes(raw.depth as ProfileDepth) ? raw.depth as ProfileDepth : base.depth,
    jargon: JARGONS.includes(raw.jargon as ProfileJargon) ? raw.jargon as ProfileJargon : base.jargon,
    order: ORDERS.includes(raw.order as ProfileOrder) ? raw.order as ProfileOrder : base.order,
    note: typeof raw.note === 'string' ? raw.note.trim().slice(0, PROFILE_NOTE_MAX) : base.note,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt !== '' ? raw.updatedAt : updatedAt,
  }
}

const DEPTH_RULES: Record<ProfileDepth, string> = {
  brief: '用 3–5 句话回答，只给结论和最关键的一条理由。不要分章节、不要罗列所有维度；'
    + '我要的是「所以我该怎么想/怎么做」，不是一份研报。',
  standard: '控制在 500 字左右，最多 3 个小标题。只讲对判断有影响的点，'
    + '把次要细节留到我追问时再展开。',
  deep: '',
}

const JARGON_RULE = '专业术语（PE/PB、扣非、并表、回撤位、稼动率、pct 这类）首次出现时，'
  + '在括号里用一句大白话解释它是什么、为什么值得看。别默认我懂。'

const ORDER_RULE = '先给结论和可执行动作，再给支撑理由。不要把结论压在最后一节。'

/**
 * 把画像渲染成一段注入 prompt 的前缀；无需任何约束时返回空串。
 *
 * 放在用户问题**之前**：模型对靠前的指令更敏感，而且这样追问时的上下文里
 * 也一直带着这段约束，不会问到第三轮就退回长篇大论。
 */
export function renderProfilePrefix(profile: InvestorProfile | null): string {
  if (profile === null) return ''
  const rules: string[] = []
  const depthRule = DEPTH_RULES[profile.depth]
  if (depthRule !== '') rules.push(depthRule)
  if (profile.jargon === 'explain') rules.push(JARGON_RULE)
  if (profile.order === 'conclusion-first') rules.push(ORDER_RULE)
  if (profile.note !== '') rules.push(`关于我：${profile.note}`)
  if (rules.length === 0) return ''
  return ['【回答要求（我的个人偏好，优先于你的默认风格）】', ...rules.map(r => `- ${r}`), ''].join('\n')
}

/** 档位的中文标签（设置页与说明文案共用，避免两处各写一遍） */
export const PROFILE_LABELS = {
  depth: { brief: '速览', standard: '标准', deep: '深度' } as Record<ProfileDepth, string>,
  jargon: { explain: '解释术语', 'as-is': '不解释' } as Record<ProfileJargon, string>,
  order: { 'conclusion-first': '结论先行', 'reasoning-first': '论证先行' } as Record<ProfileOrder, string>,
}
