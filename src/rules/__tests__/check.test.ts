import { describe, expect, it } from 'vitest'
import { abilityModifier, check, proficiencyBonus } from '../check'
import { createRNG } from '../rng'

describe('abilityModifier', () => {
  it('(점수-10)/2 내림', () => {
    expect(abilityModifier(10)).toBe(0)
    expect(abilityModifier(11)).toBe(0)
    expect(abilityModifier(12)).toBe(1)
    expect(abilityModifier(8)).toBe(-1)
    expect(abilityModifier(7)).toBe(-2)
    expect(abilityModifier(20)).toBe(5)
  })
})

describe('proficiencyBonus', () => {
  it('4레벨 구간마다 1씩 오른다', () => {
    expect(proficiencyBonus(1)).toBe(2)
    expect(proficiencyBonus(4)).toBe(2)
    expect(proficiencyBonus(5)).toBe(3)
    expect(proficiencyBonus(9)).toBe(4)
  })
})

describe('check', () => {
  it('자연 20은 보정과 무관하게 성공, 자연 1은 무조건 실패', () => {
    const rng = createRNG(4242)
    let sawNat20 = false
    let sawNat1 = false

    for (let i = 0; i < 5000; i++) {
      const r = check(rng, { dc: 99, modifier: -5 })
      if (r.natural === 20) {
        sawNat20 = true
        expect(r.success).toBe(true)
        expect(r.criticalSuccess).toBe(true)
      }
      const r2 = check(rng, { dc: 1, modifier: 20 })
      if (r2.natural === 1) {
        sawNat1 = true
        expect(r2.success).toBe(false)
        expect(r2.criticalFailure).toBe(true)
      }
    }

    expect(sawNat20).toBe(true)
    expect(sawNat1).toBe(true)
  })

  it('유리함은 2개를 굴려 높은 눈, 불리함은 낮은 눈을 채택한다', () => {
    const rng = createRNG(31337)
    for (let i = 0; i < 500; i++) {
      const adv = check(rng, { dc: 10, mode: 'advantage' })
      expect(adv.allRolls).toHaveLength(2)
      expect(adv.natural).toBe(Math.max(...adv.allRolls))

      const dis = check(rng, { dc: 10, mode: 'disadvantage' })
      expect(dis.natural).toBe(Math.min(...dis.allRolls))
    }
  })

  it('유리함의 기대 성공률이 일반보다 높다', () => {
    const count = (mode: 'normal' | 'advantage') => {
      const rng = createRNG(2024)
      let hits = 0
      for (let i = 0; i < 4000; i++) {
        if (check(rng, { dc: 12, mode }).success) hits++
      }
      return hits
    }
    expect(count('advantage')).toBeGreaterThan(count('normal'))
  })
})
