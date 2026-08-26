import { describe, expect, it } from 'vitest'
import { loadGameData } from './load'
import { isValidDice, validateGameData } from './validate'

describe('데이터 스키마 검증', () => {
  it('모든 데이터 테이블이 무결하다', () => {
    const errors = validateGameData(loadGameData())
    expect(errors, errors.join('\n')).toEqual([])
  })

  it('주사위 표기 검사가 올바르다', () => {
    for (const good of ['D6', '2D8', 'd20', '3D6+2', '2D8-1', '5', ' D4 ']) {
      expect(isValidDice(good), good).toBe(true)
    }
    for (const bad of ['', 'D', '2x6', 'D6++1', 'abc']) {
      expect(isValidDice(bad), bad).toBe(false)
    }
  })
})

describe('검증기가 실제로 오류를 잡는다', () => {
  it('참조 깨짐을 잡는다', () => {
    const data = loadGameData()
    data.kin[0]!.abilityIds = ['no-such-ability']
    expect(validateGameData(data).some((e) => e.includes('no-such-ability'))).toBe(true)
  })

  it('구간표 구멍을 잡는다', () => {
    const data = loadGameData()
    data.baseChanceTable = data.baseChanceTable.slice(1)
    expect(validateGameData(data).length).toBeGreaterThan(0)
  })

  it('몬스터 공격표 눈 누락을 잡는다', () => {
    const data = loadGameData()
    data.monsters[0]!.attacks = data.monsters[0]!.attacks.slice(0, 5)
    expect(validateGameData(data).some((e) => e.includes('공격표'))).toBe(true)
  })

  it('잘못된 주사위 표기를 잡는다', () => {
    const data = loadGameData()
    data.weapons[0]!.damage = '2x6'
    expect(validateGameData(data).some((e) => e.includes('피해 주사위'))).toBe(true)
  })
})
