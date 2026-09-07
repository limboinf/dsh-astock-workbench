import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnvText, resolveFuyaoApiKey } from '../src/fuyao.ts'

test('parseEnvText：支持 export 前缀、引号、注释与空行', () => {
  const env = parseEnvText([
    '# 注释',
    '',
    'export DEEPSEEK_API_KEY=sk-abc',
    'FUYAO_API_KEY="sk-fuyao-xyz"',
    "OTHER='quoted'",
    'BAD LINE',
  ].join('\n'))
  assert.equal(env['DEEPSEEK_API_KEY'], 'sk-abc')
  assert.equal(env['FUYAO_API_KEY'], 'sk-fuyao-xyz')
  assert.equal(env['OTHER'], 'quoted')
  assert.equal(env['BAD'], undefined)
})

test('resolveFuyaoApiKey：环境变量 → 数据目录 env 文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuyao-key-'))
  writeFileSync(join(dir, 'env'), '# cron 同款\nexport FUYAO_API_KEY=sk-fuyao-from-file\n', 'utf8')
  const prevDir = process.env.ASTOCK_DATA_DIR
  const prevKey = process.env.FUYAO_API_KEY
  try {
    process.env.ASTOCK_DATA_DIR = dir
    delete process.env.FUYAO_API_KEY
    assert.equal(resolveFuyaoApiKey(), 'sk-fuyao-from-file')
    process.env.FUYAO_API_KEY = 'sk-fuyao-from-env'
    assert.equal(resolveFuyaoApiKey(), 'sk-fuyao-from-env') // 环境变量优先
  } finally {
    if (prevDir === undefined) delete process.env.ASTOCK_DATA_DIR
    else process.env.ASTOCK_DATA_DIR = prevDir
    if (prevKey === undefined) delete process.env.FUYAO_API_KEY
    else process.env.FUYAO_API_KEY = prevKey
  }
})
