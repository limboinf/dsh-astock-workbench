import test from 'node:test'
import assert from 'node:assert/strict'
import { f10Url, isLikelyFund, marketUrl, stripPrefix } from '../src/links.ts'

test('marketUrl：带前缀与裸 6 位代码都生成正确东方财富链接', () => {
  assert.equal(marketUrl('sz002128'), 'https://quote.eastmoney.com/sz002128.html')
  assert.equal(marketUrl('002128'), 'https://quote.eastmoney.com/sz002128.html')
  assert.equal(marketUrl('600519'), 'https://quote.eastmoney.com/sh600519.html')
})

test('f10Url：用 6 位裸代码', () => {
  assert.equal(f10Url('sz002128'), 'https://basic.10jqka.com.cn/002128/')
  assert.equal(f10Url('sh600519'), 'https://basic.10jqka.com.cn/600519/')
})

test('isLikelyFund：5/15/16/18 开头的 6 位代码识别为基金', () => {
  assert.equal(isLikelyFund('sh510880'), true) // 红利ETF
  assert.equal(isLikelyFund('sh560860'), true) // 工业有色ETF
  assert.equal(isLikelyFund('sh513850'), true) // 美国50ETF
  assert.equal(isLikelyFund('sz159883'), true) // 医疗器械ETF
  assert.equal(isLikelyFund('sz160505'), true) // LOF 基金
  assert.equal(isLikelyFund('sz180001'), true) // 老封闭式基金
})

test('isLikelyFund：个股不误判', () => {
  assert.equal(isLikelyFund('sz002128'), false) // 电投能源
  assert.equal(isLikelyFund('sh600519'), false) // 贵州茅台
  assert.equal(isLikelyFund('sh600522'), false) // 中天科技
  assert.equal(isLikelyFund('sz300285'), false) // 国瓷材料
})

test('stripPrefix：去掉前缀并小写', () => {
  assert.equal(stripPrefix('SZ002128'), '002128')
  assert.equal(stripPrefix('sh600519'), '600519')
  assert.equal(stripPrefix('600519'), '600519')
})
