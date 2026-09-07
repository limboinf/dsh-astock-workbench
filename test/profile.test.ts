import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultProfile,
  normalizeProfile,
  PROFILE_NOTE_MAX,
  renderProfilePrefix,
} from '../src/profile.ts'
import { readProfile, writeProfile } from '../src/profile-store.ts'

test('normalizeProfile：认不出的字段一律退默认，绝不抛错', () => {
  const base = defaultProfile()
  assert.deepEqual(normalizeProfile(null), base)
  assert.deepEqual(normalizeProfile('乱七八糟'), base)
  assert.deepEqual(normalizeProfile({ depth: '不存在的档' }), base)
  // 合法字段保留，非法字段单独退默认（不是整份丢弃）
  const mixed = normalizeProfile({ depth: 'brief', jargon: 'nope', order: 'reasoning-first' })
  assert.equal(mixed.depth, 'brief')
  assert.equal(mixed.jargon, base.jargon)
  assert.equal(mixed.order, 'reasoning-first')
})

test('normalizeProfile：自述超长截断，前后空白去掉', () => {
  const long = normalizeProfile({ note: `  ${'很'.repeat(PROFILE_NOTE_MAX + 50)}  ` })
  assert.equal(long.note.length, PROFILE_NOTE_MAX)
  assert.equal(normalizeProfile({ note: '   ' }).note, '')
})

test('renderProfilePrefix：档位映射成约束，全默认档也有内容，无约束时为空串', () => {
  assert.equal(renderProfilePrefix(null), '')

  const brief = renderProfilePrefix(normalizeProfile({ depth: 'brief', jargon: 'explain', order: 'conclusion-first' }))
  assert.ok(brief.includes('3–5 句话'))
  assert.ok(brief.includes('括号'))
  assert.ok(brief.includes('先给结论'))

  // 深度 + 不解释 + 论证先行 = 三条规则全关，且没有自述 → 不该注入任何东西
  const none = renderProfilePrefix(normalizeProfile({ depth: 'deep', jargon: 'as-is', order: 'reasoning-first' }))
  assert.equal(none, '')

  // 只填自述也要注入
  const noteOnly = renderProfilePrefix(
    normalizeProfile({ depth: 'deep', jargon: 'as-is', order: 'reasoning-first', note: '入市两年' }),
  )
  assert.ok(noteOnly.includes('关于我：入市两年'))
})

test('profile-store：未设置返回 null，写入后可读回，坏文件退默认而不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'astock-profile-'))
  assert.equal(readProfile(dir), null)

  const saved = writeProfile(dir, { depth: 'brief', jargon: 'as-is', note: '只要结论' }, '2026-09-04')
  assert.equal(saved.depth, 'brief')
  assert.equal(saved.updatedAt, '2026-09-04')
  const readBack = readProfile(dir)
  assert.equal(readBack?.depth, 'brief')
  assert.equal(readBack?.note, '只要结论')

  writeFileSync(join(dir, 'profile.json'), '{ 这不是 JSON', 'utf8')
  const broken = readProfile(dir)
  // 画像坏掉不该让分析功能挂掉：退默认档而不是抛错或返回 null
  assert.equal(broken?.depth, defaultProfile().depth)
})
