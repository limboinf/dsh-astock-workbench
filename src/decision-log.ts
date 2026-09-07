/**
 * 交易日决策日志 —— 追加式 Markdown 文件。
 *
 * 日志与 holdings.csv 分离：它记录“当时为什么这样判断”，不承担交易记账。
 * 采用追加而不是原地更新，保留审计轨迹；复盘或修订直接追加一条新记录即可。
 *
 * 条目结构（解析契约见 decision-entry.ts，client 半面共用）：
 *   ## 10:52 [性质] 一句话摘要
 *   【标签】正文（每个维度一行；复核/风险等列表一条一行、- 开头）
 * 正文本身不做改写——模型按工具描述的写作规范产出，老格式由解析端兼容。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatEntryHeading, sanitizeKind, sanitizeSummary } from './decision-entry.ts'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function currentLocalDate(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function validateLogDate(value: string): string {
  const date = value.trim()
  if (!DATE_RE.test(date)) throw new Error('日期必须是 YYYY-MM-DD 格式')
  const parsed = new Date(`${date}T00:00:00`)
  const localRoundTrip = Number.isNaN(parsed.getTime())
    ? ''
    : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
  if (localRoundTrip !== date) {
    throw new Error(`日期无效：${date}`)
  }
  return date
}

/** 一条决策记录：content 必填；kind（性质徽标）与 summary（条目标题）可选 */
export interface DecisionLogAppend {
  content: string
  kind?: string
  summary?: string
}

export class DecisionLogStore {
  constructor(readonly dir: string) {}

  ensureDir(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  fileFor(date: string): string {
    return join(this.dir, `${validateLogDate(date)}.md`)
  }

  append(entry: DecisionLogAppend, date = currentLocalDate(), title = '交易日决策'): string {
    const normalizedDate = validateLogDate(date)
    const body = entry.content.trim()
    if (body === '') throw new Error('决策日志内容不能为空')
    this.ensureDir()
    const file = join(this.dir, `${normalizedDate}.md`)
    if (!existsSync(file)) {
      writeFileSync(file, `# ${normalizedDate} ${(title ?? '').trim() || '交易日决策'}\n\n`, 'utf8')
    }
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    const heading = formatEntryHeading(stamp, sanitizeKind(entry.kind ?? ''), sanitizeSummary(entry.summary ?? ''))
    appendFileSync(file, `${heading}\n\n${body}\n\n`, 'utf8')
    return file
  }

  read(date: string): string | undefined {
    const file = this.fileFor(date)
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }

  list(from?: string, to?: string): Array<{ date: string; text: string }> {
    const start = from === undefined ? undefined : validateLogDate(from)
    const end = to === undefined ? undefined : validateLogDate(to)
    this.ensureDir()
    return readdirSync(this.dir)
      .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map(name => name.slice(0, -3))
      .filter(date => (start === undefined || date >= start) && (end === undefined || date <= end))
      .sort((a, b) => b.localeCompare(a))
      .map(date => ({ date, text: readFileSync(join(this.dir, `${date}.md`), 'utf8') }))
  }
}

export function renderDecisionLogs(logs: Array<{ date: string; text: string }>): string {
  if (logs.length === 0) return '## 决策日志\n\n暂无决策日志记录。可用 astock_log_decision 创建今天的记录。'
  return [
    '## 决策日志',
    '',
    ...logs.flatMap(log => [`### ${log.date}`, '', log.text.trim(), '']),
  ].join('\n').trimEnd()
}
