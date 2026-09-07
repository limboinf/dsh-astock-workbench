import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBalance, validateBalanceDate, writeBalance, writeCashBalance } from '../src/balance.ts'

test('writeBalance/readBalance：往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'balance-'))
  writeBalance(dir, 528306.88, '2026-09-03', '含现金')
  const b = readBalance(dir)
  assert.equal(b?.totalAssets, 528306.88)
  assert.equal(b?.updatedAt, '2026-09-03')
  assert.equal(b?.note, '含现金')
  const raw = JSON.parse(readFileSync(join(dir, 'balance.json'), 'utf8'))
  assert.equal(raw.totalAssets, 528306.88)
})

test('readBalance：文件不存在返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'balance-empty-'))
  assert.equal(readBalance(dir), null)
})

test('readBalance：损坏 JSON 返回 null 不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'balance-bad-'))
  writeFileSync(join(dir, 'balance.json'), '{broken', 'utf8')
  assert.equal(readBalance(dir), null)
})

test('validateBalanceDate：格式校验', () => {
  assert.equal(validateBalanceDate('2026-09-03'), '2026-09-03')
  assert.throws(() => validateBalanceDate('2026/09/03'))
})

test('writeCashBalance/readBalance：现金口径往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'balance-cash-'))
  writeCashBalance(dir, 50000, '2026-09-04', '可用资金')
  const b = readBalance(dir)
  assert.equal(b?.cash, 50000)
  assert.equal(b?.totalAssets, undefined)
  assert.equal(b?.updatedAt, '2026-09-04')
  assert.equal(b?.note, '可用资金')
  const raw = JSON.parse(readFileSync(join(dir, 'balance.json'), 'utf8'))
  assert.equal(raw.cash, 50000)
  assert.equal(raw.totalAssets, undefined)
})

test('现金与快照互斥：后写的覆盖先写的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'balance-mix-'))
  writeBalance(dir, 528306.88, '2026-09-03')
  writeCashBalance(dir, 50000, '2026-09-04')
  let b = readBalance(dir)
  assert.equal(b?.cash, 50000)
  assert.equal(b?.totalAssets, undefined)
  writeBalance(dir, 530000, '2026-09-05')
  b = readBalance(dir)
  assert.equal(b?.totalAssets, 530000)
  assert.equal(b?.cash, undefined)
})

test('readBalance：cash 为 0 是合法现金口径（满仓无现金）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'balance-zero-'))
  writeCashBalance(dir, 0, '2026-09-04')
  assert.equal(readBalance(dir)?.cash, 0)
})

test('readBalance：文件同时含 cash 与 totalAssets 时 cash 优先', () => {
  const dir = mkdtempSync(join(tmpdir(), 'balance-both-'))
  writeFileSync(join(dir, 'balance.json'), '{"cash":1,"totalAssets":2,"updatedAt":"2026-09-04"}', 'utf8')
  const b = readBalance(dir)
  assert.equal(b?.cash, 1)
  assert.equal(b?.totalAssets, undefined)
})
