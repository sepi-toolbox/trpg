import { describe, expect, it } from 'vitest'
import { diceRange, parseDice, roll, rollCritical } from '../dice'
import { createRNG } from '../rng'

describe('parseDice', () => {
  it('기본 표기를 해석한다', () => {
    expect(parseDice('2d6+3')).toEqual({ count: 2, sides: 6, modifier: 3 })
    expect(parseDice('d20')).toEqual({ count: 1, sides: 20, modifier: 0 })
    expect(parseDice('4d8-1')).toEqual({ count: 4, sides: 8, modifier: -1 })
  })

  it('공백과 대문자를 허용한다', () => {
    expect(parseDice(' 3 D 10 + 2 ')).toEqual({ count: 3, sides: 10, modifier: 2 })
  })

  it('고정값도 표기법으로 받는다', () => {
    expect(parseDice('5')).toEqual({ count: 0, sides: 0, modifier: 5 })
  })

  it('잘못된 표기는 예외를 던진다', () => {
    expect(() => parseDice('2x6')).toThrow()
    expect(() => parseDice('')).toThrow()
    expect(() => parseDice('1d1')).toThrow()
    expect(() => parseDice('200d6')).toThrow()
  })
})

describe('roll', () => {
  it('항상 이론상 최소~최대 범위 안에 있다', () => {
    const rng = createRNG(12345)
    const { min, max } = diceRange('3d6+2')
    for (let i = 0; i < 2000; i++) {
      const r = roll(rng, '3d6+2')
      expect(r.total).toBeGreaterThanOrEqual(min)
      expect(r.total).toBeLessThanOrEqual(max)
      expect(r.rolls).toHaveLength(3)
    }
  })

  it('같은 시드는 같은 결과를 낸다', () => {
    const a = createRNG(999)
    const b = createRNG(999)
    for (let i = 0; i < 50; i++) {
      expect(roll(a, '2d10+1').total).toBe(roll(b, '2d10+1').total)
    }
  })
})

describe('rollCritical', () => {
  it('주사위 개수는 2배, 보정치는 1회만 적용된다', () => {
    const rng = createRNG(7)
    const r = rollCritical(rng, '2d6+3')
    expect(r.rolls).toHaveLength(4)
    expect(r.modifier).toBe(3)
    expect(r.total).toBe(r.rolls.reduce((a, b) => a + b, 0) + 3)
  })
})

describe('diceRange', () => {
  it('밸런스 검산용 최소/최대/평균을 준다', () => {
    expect(diceRange('1d8+1')).toEqual({ min: 2, max: 9, avg: 5.5 })
    expect(diceRange('2d6')).toEqual({ min: 2, max: 12, avg: 7 })
  })
})
