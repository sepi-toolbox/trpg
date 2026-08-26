import { describe, expect, it } from 'vitest'
import { createRNG, hashSeed, rollDie } from './rng'
import { diceRange, parseDice, roll, rollDoubled, rollWithExtraDice } from './dice'
import {
  canPush,
  conditionBanes,
  netModifier,
  pushRoll,
  rollD20,
  rollOpenOpposed,
  rollOpposed,
} from './roll'
import type { ConditionId } from './types'

describe('RNG', () => {
  it('같은 시드는 같은 수열', () => {
    const a = createRNG(42)
    const b = createRNG(42)
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next())
  })

  it('rollDie 는 1..면수 범위', () => {
    const rng = createRNG(7)
    for (let i = 0; i < 2000; i++) {
      const v = rollDie(rng, 20)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(20)
    }
  })

  it('hashSeed 는 결정론적', () => {
    expect(hashSeed('안개계곡')).toBe(hashSeed('안개계곡'))
    expect(hashSeed('a')).not.toBe(hashSeed('b'))
  })
})

describe('주사위 표기', () => {
  it('표기 파싱', () => {
    expect(parseDice('2D8+1')).toEqual({ count: 2, sides: 8, modifier: 1 })
    expect(parseDice('d20')).toEqual({ count: 1, sides: 20, modifier: 0 })
    expect(parseDice('5')).toEqual({ count: 0, sides: 0, modifier: 5 })
    expect(() => parseDice('2x6')).toThrow()
  })

  it('굴림은 이론 범위 안', () => {
    const rng = createRNG(1)
    const { min, max } = diceRange('3D6+2')
    for (let i = 0; i < 1000; i++) {
      const r = roll(rng, '3D6+2')
      expect(r.total).toBeGreaterThanOrEqual(min)
      expect(r.total).toBeLessThanOrEqual(max)
    }
  })

  it('용 피해: 주사위 2배, 보정 1회', () => {
    const rng = createRNG(3)
    const r = rollDoubled(rng, '2D6+3')
    expect(r.rolls).toHaveLength(4)
    expect(r.modifier).toBe(3)
  })

  it('주사위 개수 증감', () => {
    const rng = createRNG(4)
    expect(rollWithExtraDice(rng, 'D8', 1).rolls).toHaveLength(2)
    expect(rollWithExtraDice(rng, '3D6', -1).rolls).toHaveLength(2)
    expect(rollWithExtraDice(rng, 'D6', -5).rolls).toHaveLength(0)
  })
})

describe('D20 하향 판정', () => {
  it('목표치 이하면 성공, 초과면 실패', () => {
    const rng = createRNG(1000)
    for (let i = 0; i < 3000; i++) {
      const r = rollD20(rng, 12)
      if (r.natural === 1) expect(r.success).toBe(true)
      else if (r.natural === 20) expect(r.success).toBe(false)
      else expect(r.success).toBe(r.natural <= 12)
    }
  })

  it('용(1)은 목표치 0이어도 성공, 마(20)는 목표치 20이어도 실패', () => {
    const rng = createRNG(2000)
    let sawDragon = false
    let sawDemon = false
    for (let i = 0; i < 5000; i++) {
      const low = rollD20(rng, 0)
      if (low.natural === 1) {
        sawDragon = true
        expect(low.success).toBe(true)
        expect(low.dragon).toBe(true)
      }
      const high = rollD20(rng, 20)
      if (high.natural === 20) {
        sawDemon = true
        expect(high.success).toBe(false)
        expect(high.demon).toBe(true)
        expect(high.pushable).toBe(false)
      }
    }
    expect(sawDragon).toBe(true)
    expect(sawDemon).toBe(true)
  })

  it('보온은 낮은 눈, 베인은 높은 눈 채택', () => {
    const rng = createRNG(3000)
    for (let i = 0; i < 800; i++) {
      const boon = rollD20(rng, 10, { boons: 1 })
      expect(boon.allRolls).toHaveLength(2)
      expect(boon.natural).toBe(Math.min(...boon.allRolls))

      const bane = rollD20(rng, 10, { banes: 1 })
      expect(bane.natural).toBe(Math.max(...bane.allRolls))
    }
  })

  it('복수 보온/베인은 주사위가 늘어난다', () => {
    const rng = createRNG(3500)
    expect(rollD20(rng, 10, { boons: 3 }).allRolls).toHaveLength(4)
    expect(rollD20(rng, 10, { banes: 2 }).allRolls).toHaveLength(3)
  })

  it('보온과 베인은 1:1 상쇄', () => {
    expect(netModifier({ boons: 1, banes: 1 })).toEqual({ mode: 'normal', extraDice: 0 })
    expect(netModifier({ boons: 2, banes: 1 })).toEqual({ mode: 'boon', extraDice: 1 })
    expect(netModifier({ boons: 1, banes: 3 })).toEqual({ mode: 'bane', extraDice: 2 })
  })

  it('하향 판정에서 보온이 실제로 성공률을 올린다', () => {
    const count = (mods: { boons?: number; banes?: number }) => {
      const rng = createRNG(2024)
      let ok = 0
      for (let i = 0; i < 4000; i++) if (rollD20(rng, 10, mods).success) ok++
      return ok
    }
    const normal = count({})
    expect(count({ boons: 1 })).toBeGreaterThan(normal)
    expect(count({ banes: 1 })).toBeLessThan(normal)
  })
})

describe('대결 판정', () => {
  it('능동측 실패 → 상대와 무관하게 실패', () => {
    const rng = createRNG(4000)
    for (let i = 0; i < 2000; i++) {
      const r = rollOpposed(rng, 10, 10)
      if (!r.active.success) expect(r.success).toBe(false)
    }
  })

  it('양측 성공 시 낮은 눈 승, 동수는 능동측 승', () => {
    const rng = createRNG(4100)
    for (let i = 0; i < 2000; i++) {
      const r = rollOpposed(rng, 15, 15)
      if (r.active.success && r.opposing.success) {
        expect(r.success).toBe(r.active.natural <= r.opposing.natural)
      }
      if (r.active.success && !r.opposing.success) expect(r.success).toBe(true)
    }
  })

  it('열린 대결은 항상 승자를 낸다', () => {
    const rng = createRNG(4200)
    for (let i = 0; i < 300; i++) {
      const r = rollOpenOpposed(rng, 12, 12)
      expect(['a', 'b']).toContain(r.winner)
      // 승부가 난 순간의 판정은 규칙과 모순되지 않는다
      if (r.a.success && r.b.success) expect(r.a.natural).not.toBe(r.b.natural)
    }
  })
})

describe('상태이상 → 베인', () => {
  it('능력치와 대응하는 상태이상만 베인을 준다', () => {
    const conditions = new Set<ConditionId>(['exhausted', 'scared'])
    expect(conditionBanes(conditions, 'str')).toBe(1)
    expect(conditionBanes(conditions, 'wil')).toBe(1)
    expect(conditionBanes(conditions, 'agl')).toBe(0)
    expect(conditionBanes(new Set(), 'str')).toBe(0)
  })
})

describe('푸쉬 굴림', () => {
  const failed = (rng = createRNG(5000)) => {
    // 실패한(마 아님) 판정을 하나 얻을 때까지 굴린다
    for (let i = 0; i < 1000; i++) {
      const r = rollD20(rng, 5)
      if (!r.success && !r.demon) return r
    }
    throw new Error('실패 판정을 얻지 못함')
  }

  it('성공/마/상태이상 6종 보유 시 푸쉬 불가', () => {
    const rng = createRNG(5100)
    let success = rollD20(rng, 20)
    while (!success.success) success = rollD20(rng, 20)
    expect(canPush({ previous: success, conditions: new Set() })).toBe('not-failed')

    let demon = rollD20(rng, 1)
    while (!demon.demon) demon = rollD20(rng, 1)
    expect(canPush({ previous: demon, conditions: new Set() })).toBe('demon')

    const all = new Set<ConditionId>([
      'exhausted', 'sickly', 'dazed', 'angry', 'scared', 'disheartened',
    ])
    expect(canPush({ previous: failed(), conditions: all })).toBe('all-conditions')
  })

  it('이미 가진 상태이상은 대가로 선택할 수 없다', () => {
    const rng = createRNG(5200)
    const out = pushRoll(rng, {
      previous: failed(),
      conditions: new Set<ConditionId>(['angry']),
      chosenCondition: 'angry',
    })
    expect('rejected' in out && out.rejected).toBe('already-have')
  })

  it('푸쉬하면 상태이상을 받고 같은 목표치로 재굴림한다', () => {
    const rng = createRNG(5300)
    const prev = failed()
    const out = pushRoll(rng, {
      previous: prev,
      conditions: new Set(),
      chosenCondition: 'exhausted',
    })
    if ('rejected' in out) throw new Error('푸쉬가 거부됨')
    expect(out.gainedCondition).toBe('exhausted')
    expect(out.result.target).toBe(prev.target)
  })
})
