import { describe, expect, it } from 'vitest'
import { createRNG } from './rng'
import { loadGameData } from './load'
import {
  activateAbility,
  applyEffects,
  applyMishapRow,
  learnAbility,
  meetsRequirement,
  resolveSkillWildcard,
  stretchRestBonus,
  triggeredEffects,
} from './effects'
import type { Vitals } from './hazards'

const data = loadGameData()

function vitals(overrides: Partial<Vitals> = {}): Vitals {
  return {
    hp: 14,
    wp: 10,
    conditions: [],
    attributes: { str: 15, con: 14, agl: 13, int: 12, wil: 10, cha: 8 },
    ...overrides,
  }
}

describe('applyEffects — 자원형 훅', () => {
  it('damage: 방어구 차감·ignoreArmor·HP 하한 0', () => {
    const out = applyEffects(createRNG(1), data, [
      { hook: 'damage', params: { dice: '5', ignoreArmor: false } },
    ], vitals(), { armorRating: 3 })
    expect(out.target.hp).toBe(14 - 2)

    const pierce = applyEffects(createRNG(2), data, [
      { hook: 'damage', params: { dice: '5', ignoreArmor: true } },
    ], vitals(), { armorRating: 3 })
    expect(pierce.target.hp).toBe(14 - 5)

    const overkill = applyEffects(createRNG(3), data, [
      { hook: 'damage', params: { dice: '99', ignoreArmor: true } },
    ], vitals())
    expect(overkill.target.hp).toBe(0)
  })

  it('heal/healWp: 최대치 클램프', () => {
    const out = applyEffects(createRNG(4), data, [
      { hook: 'heal', params: { dice: '99' } },
      { hook: 'healWp', params: { dice: '99' } },
    ], vitals({ hp: 3, wp: 2 }), { maxHp: 14, maxWp: 10 })
    expect(out.target.hp).toBe(14)
    expect(out.target.wp).toBe(10)
  })

  it('condition: choice 는 미보유 첫 상태이상', () => {
    const out = applyEffects(createRNG(5), data, [
      { hook: 'condition', params: { condition: 'choice' } },
    ], vitals({ conditions: ['exhausted'] }))
    expect(out.target.conditions).toContain('sickly')
  })

  it('healCondition: 개수·all', () => {
    const v = vitals({ conditions: ['exhausted', 'scared', 'angry'] })
    const one = applyEffects(createRNG(6), data, [
      { hook: 'healCondition', params: { count: 2 } },
    ], v)
    expect(one.target.conditions).toHaveLength(1)
    const all = applyEffects(createRNG(7), data, [
      { hook: 'healCondition', params: { count: 'all' } },
    ], v)
    expect(all.target.conditions).toHaveLength(0)
  })

  it('knockback: damagePerMeter 와 지시 반환', () => {
    const out = applyEffects(createRNG(8), data, [
      { hook: 'knockback', params: { dice: '2D6', damagePerMeter: true, prone: true } },
    ], vitals())
    expect(out.target.hp).toBeLessThan(14)
    const directive = out.directives.find((d) => d.kind === 'knockback')!
    expect(directive.params['prone']).toBe(true)
  })

  it('fearAttack: 저항 판정이 돌고 광역이면 지시 추가', () => {
    let sawFail = false
    for (let seed = 0; seed < 200 && !sawFail; seed++) {
      const out = applyEffects(createRNG(seed), data, [
        { hook: 'fearAttack', params: { radius: 10 } },
      ], vitals())
      expect(out.directives.some((d) => d.kind === 'fearAttackOnOthers')).toBe(true)
      if (out.applied.some((a) => a.hook === 'fearAttack' && a.detail.startsWith('공포:'))) {
        sawFail = true
      }
    }
    expect(sawFail).toBe(true)
  })

  it('boon/bane 는 판정 보정으로, manual 은 그대로 반환', () => {
    const out = applyEffects(createRNG(9), data, [
      { hook: 'boon', params: { roll: { skills: ['evade'] } } },
      { hook: 'manual' },
    ], vitals())
    expect(out.rollModifiers.boons).toBe(1)
    expect(out.rollModifiers.selector?.skills).toContain('evade')
    expect(out.manual).toHaveLength(1)
  })
})

describe('능력 발동', () => {
  const actor = () => ({ wp: 10, abilities: { 'hot-temper': 1, 'deep-trance': 1, veteran: 1 } })

  it('미보유·WP 부족·패시브 거부', () => {
    expect(activateAbility(data, actor(), 'dual-wield')).toEqual({ rejected: 'not-owned' })
    expect(activateAbility(data, { ...actor(), wp: 0 }, 'hot-temper')).toEqual({
      rejected: 'not-enough-wp',
    })
    expect(activateAbility(data, actor(), 'deep-trance')).toEqual({ rejected: 'passive-ability' })
  })

  it('발동 성공: WP 비용과 효과 반환', () => {
    const out = activateAbility(data, actor(), 'hot-temper')
    if ('rejected' in out) throw new Error(out.rejected)
    expect(out.wpSpent).toBe(3)
    expect(out.effects.length).toBeGreaterThan(0)
  })
})

describe('와일드카드·습득 요건', () => {
  it('와일드카드 그룹이 데이터에서 계산된다', () => {
    expect(resolveSkillWildcard(data, 'anyWeapon')).toContain('swords')
    expect(resolveSkillWildcard(data, 'anyWeapon')).toContain('bows')
    const melee = resolveSkillWildcard(data, 'anyMeleeWeapon')
    expect(melee).toContain('swords')
    expect(melee).not.toContain('bows')
    const strMelee = resolveSkillWildcard(data, 'anyStrMeleeWeapon')
    expect(strMelee).toContain('swords')
    expect(strMelee).not.toContain('knives') // AGL
    expect(resolveSkillWildcard(data, 'anyMagic')).toContain('spirit-magic')
  })

  it('요건 충족 검사', () => {
    const veteran = data.abilities.find((a) => a.id === 'veteran')!
    expect(meetsRequirement(data, { swords: 12 }, veteran)).toBe(true)
    expect(meetsRequirement(data, { swords: 11 }, veteran)).toBe(false)
    expect(meetsRequirement(data, { bows: 12 }, veteran)).toBe(true) // anyWeapon
  })

  it('습득: 요건 미달·중복(비스택) 거부, 스택 능력은 중첩', () => {
    const actor = { skillLevels: { swords: 12 }, abilities: { veteran: 1 } as Record<string, number> }
    expect(learnAbility(data, actor, 'veteran')).toEqual({ rejected: 'already-owned' })
    expect(
      learnAbility(data, { ...actor, skillLevels: { swords: 5 } }, 'dual-wield'),
    ).toEqual({ rejected: 'requirement' })

    const robust1 = learnAbility(data, actor, 'robust')
    if ('rejected' in robust1) throw new Error(robust1.rejected)
    const robust2 = learnAbility(data, { ...actor, abilities: robust1.abilities }, 'robust')
    if ('rejected' in robust2) throw new Error(robust2.rejected)
    expect(robust2.abilities['robust']).toBe(2)
  })
})

describe('트리거', () => {
  it('스트레치 휴식 트리거 효과 추출 (깊은 명상)', () => {
    const effects = triggeredEffects(data, { 'deep-trance': 1 }, 'stretchRest')
    expect(effects.some((e) => e.hook === 'heal')).toBe(true)

    const bonus = stretchRestBonus(data, { 'deep-trance': 1 }, ['scared', 'angry'])
    expect(bonus.hpDice).toBe('D6')
    expect(bonus.wpDice).toBe('D6')
    expect(bonus.extraConditions).toEqual(['scared'])
  })

  it('트리거 없는 능력은 추출되지 않는다', () => {
    expect(triggeredEffects(data, { 'hot-temper': 1 }, 'stretchRest')).toHaveLength(0)
  })
})

describe('사고표 위력 비례 적용', () => {
  it('damagePerPowerLevel / wpDrainPerPowerLevel', () => {
    const dmgRow = data.tables
      .find((t) => t.id === 'magical-mishap')!
      .rows.find((r) => r.extra?.['damagePerPowerLevel'])!
    const out = applyMishapRow(createRNG(10), data, dmgRow, vitals(), 3)
    // 위력 3 → 3D6, 최소 3
    expect(14 - out.target.hp).toBeGreaterThanOrEqual(3)

    const wpRow = data.tables
      .find((t) => t.id === 'magical-mishap')!
      .rows.find((r) => r.extra?.['wpDrainPerPowerLevel'])!
    const out2 = applyMishapRow(createRNG(11), data, wpRow, vitals(), 2)
    expect(10 - out2.target.wp).toBeGreaterThanOrEqual(2)
  })

  it('상태이상 행은 구조화 훅으로 적용된다', () => {
    const condRow = data.tables
      .find((t) => t.id === 'magical-mishap')!
      .rows.find((r) => r.effects.some((e) => e.hook === 'condition'))!
    const out = applyMishapRow(createRNG(12), data, condRow, vitals(), 1)
    expect(out.target.conditions.length).toBe(1)
  })
})
