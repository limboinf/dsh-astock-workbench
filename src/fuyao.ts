/**
 * fuyao（同花顺金融数据）REST 客户端 + 配置解析。
 *
 * 接入选型（2026-09 实测定稿）：REST 直连。skill/MCP 都是「把取数交给模型」的形态，
 * 只有 REST 让取数与计算留在本地确定性数据层：金额要能对账、要可复现，
 * 交给模型每次算一遍既慢又不稳。
 *
 * 接口契约（官方文档 + 2026-09-04 实测固化）：
 * - 认证：X-api-key 请求头。key 查找顺序：环境变量 FUYAO_API_KEY →
 *   数据目录 env 文件（支持 export 前缀）→ 包内 .env（开发自检用）。
 * - 响应恒 HTTP 200，业务码 code=0 才成功；错误体 {code, message, request_id}。
 * - /api/a-share/prices/snapshot：thscodes 逗号批量，只覆盖沪深**股票**
 *   （ETF/北交所不在内）；批量含未知代码时整批报 1002（上层剔除后重试）；
 *   深市标的实测返回 last_price=null 的「有壳无价」条目（上游缺口）。
 * - /api/fund/market/snapshot：单只 thscode，仅 ETF（LOF/场外报 3002）；
 *   深市 ETF 实测报 3002「尚未开放」。
 * - /api/a-share/valuations/snapshot：thscodes 批量，含 name/pe_ttm/pb_mrq（股票）。
 * 上述缺口统一由 quotes.ts 落回腾讯免费接口兜底，fuyao 补齐后可整体删除兜底。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FUYAO_BASE = 'https://fuyao.aicubes.cn'

export function resolveDataDir(): string {
  return process.env.ASTOCK_DATA_DIR?.trim() || join(homedir(), '.dsh', 'astock-workbench')
}

/** 解析 env 文件文本（支持 `KEY=V` 与 `export KEY=V`，# 注释与空行忽略） */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m !== null) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return out
}

function readEnvFile(file: string | undefined): Record<string, string> {
  if (file === undefined || !existsSync(file)) return {}
  try {
    return parseEnvText(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** 包内 .env（开发自检用）：以本模块文件位置定位，bundle 后即安装包根的 .env */
function projectEnvFile(): string | undefined {
  try {
    return new URL('../.env', import.meta.url).pathname
  } catch {
    return undefined
  }
}

/** fuyao key：环境变量 → 数据目录 env → 包内 .env；找不到返回 undefined */
export function resolveFuyaoApiKey(): string | undefined {
  const fromEnv = process.env.FUYAO_API_KEY?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const fromDataDir = readEnvFile(join(resolveDataDir(), 'env'))['FUYAO_API_KEY']
  if (fromDataDir !== undefined && fromDataDir !== '') return fromDataDir
  const fromProject = readEnvFile(projectEnvFile())['FUYAO_API_KEY']
  return fromProject !== undefined && fromProject !== '' ? fromProject : undefined
}

/** fuyao 业务错误（code != 0），携带 code/request_id 供上层分流处理 */
export class FuyaoApiError extends Error {
  constructor(
    readonly fuyaoCode: number,
    message: string,
    readonly requestId: string,
  ) {
    super(`fuyao 业务错误 code=${fuyaoCode}：${message}（request_id=${requestId}）`)
  }
}

export function isFuyaoApiError(e: unknown, code?: number): e is FuyaoApiError {
  return e instanceof FuyaoApiError && (code === undefined || e.fuyaoCode === code)
}

interface FuyaoEnvelope {
  code: number
  message: string
  request_id: string
  data: unknown
}

/** 组合外部取消信号与超时：任一触发即中止 fetch；dispose 清理定时器与监听 */
export function combinedFetchSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`行情请求超时（${timeoutMs}ms）`)), timeoutMs)
  let onAbort: (() => void) | undefined
  if (external) {
    onAbort = () => ctrl.abort(external.reason)
    if (external.aborted) ctrl.abort(external.reason)
    else external.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer)
      if (onAbort !== undefined) external?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * 调一个 fuyao GET 端点，返回业务 data（已过信封校验）。
 * 网络层失败（超时/断网/5xx）自动重试一次；业务码错误抛 FuyaoApiError 不重试
 * （1002/3002 由上层分流兜底，4001 频率超限重试也无意义）。
 */
export async function fetchFuyaoData(
  path: string,
  params: Record<string, string | number>,
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
  const url = `${FUYAO_BASE}${path}?${qs.toString()}`
  let lastError: unknown
  for (let attempt = 0; attempt <= 1; attempt++) {
    const s = combinedFetchSignal(options?.signal, 10_000)
    try {
      const key = resolveFuyaoApiKey()
      if (key === undefined) {
        throw new Error(
          '未配置 fuyao API Key：请设置环境变量 FUYAO_API_KEY，或在数据目录 env 文件' +
            `（${join(resolveDataDir(), 'env')}）写入 FUYAO_API_KEY=...（fuyao.aicubes.cn 签发）`,
        )
      }
      const res = await fetch(url, { headers: { 'X-api-key': key }, signal: s.signal })
      if (!res.ok) throw new Error(`fuyao HTTP ${res.status}`)
      const envelope = (await res.json()) as FuyaoEnvelope
      if (envelope.code !== 0) throw new FuyaoApiError(envelope.code, envelope.message, envelope.request_id)
      return envelope.data
    } catch (e) {
      // 业务错误立即上抛；只有网络层失败才值得重试一次
      if (e instanceof FuyaoApiError) throw e
      lastError = e
      if (attempt === 0) await new Promise(r => setTimeout(r, 300))
    } finally {
      s.dispose()
    }
  }
  throw lastError
}
