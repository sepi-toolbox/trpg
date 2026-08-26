import { describe, expect, it } from 'vitest'
import { createRNG } from './rng'
import { loadGameData } from './load'
import {
  castSpell,
  checkCast,
  isHealingSpell,
  learnSchool,
  learnSpellFromGrimoire,
  learnSpellFromTeacher,
  metalRestriction,
  powerFromBody,
  prepareSpells,
  rollSpellDice,
  spellOf,
  wpCost,
} from './magic'
import type { CasterState } from './magic'

const data = loadGameData()

function caster(overrides: Partial<CasterState> = {}): CasterState {
  return {
    wp: 14,
    conditions: [],
    skillLevels: { 'spirit-magic': 12, languages: 8 },
    knownSpellIds: ['storm-lash', 'mend-flesh', 'unbind', 'spark-flick'],
    preparedSpellIds: ['storm-lash', 'mend-flesh', 'unbind'],
    armorIds: [],
    atHandIds: ['staff'],
    ...overrides,
  }
}

const allReq = { word: true, gesture: true, focus: true, ingredient: true }

describe('금속 제한', () => {
  it('금속 갑옷·손의 금속 무기·금속 아이템이 시전을 막는다', () => {
    expect(metalRestriction(data, caster())).toBe(false) // 지팡이는 목제
    expect(metalRestriction(data, caster({ armorIds: ['chainmail'] }))).toBe(true)
    expect(metalRestriction(data, caster({ atHandIds: ['knife'] }))).toBe(true)
    expect(metalRestriction(data, caster({ atHandIds: ['quiver-iron'] }))).toBe(true)
    expect(metalRestriction(data, caster({ armorIds: ['leather-armor'] }))).toBe(false)
  })
})

describe('WP 비용', () => {
  it('트릭 1, 위력 주문 2×위력, 위력 없는 주문 2', () => {
    expect(wpCost(spellOf(data, 'spark-flick'), 3)).toBe(1)
    expect(wpCost(spellOf(data, 'storm-lash'), 1)).toBe(2)
    expect(wpCost(spellOf(data, 'storm-lash'), 3)).toBe(6)
  })
})

describe('시전 가능 검사', () => {
  it('모르는 주문·미준비·요구 조건·WP 부족·잘못된 위력을 거부한다', () => {
    const c = caster()
    expect(checkCast(data, c, { spellId: 'ember-bolt', available: allReq })).toEqual({
      rejected: 'unknown-spell',
    })
    // spark-flick 은 트릭 — 준비 불필요. 미준비 spell 검사용으로 knownSpellIds 에 있는 spell 하나를 준비 해제
    const unprepared = caster({ preparedSpellIds: ['mend-flesh', 'unbind'] })
    expect(checkCast(data, unprepared, { spellId: 'storm-lash', available: allReq })).toEqual({
      rejected: 'not-prepared',
    })
    // 그리무아 시전은 허용
    const viaGrimoire = checkCast(data, unprepared, {
      spellId: 'storm-lash',
      available: allReq,
      fromGrimoire: true,
    })
    expect('rejected' in viaGrimoire).toBe(false)

    // 동작 불가(결박 등)
    expect(
      checkCast(data, c, { spellId: 'storm-lash', available: { word: true, gesture: false } }),
    ).toEqual({ rejected: 'requirement' })

    expect(checkCast(data, caster({ wp: 1 }), { spellId: 'storm-lash', available: allReq })).toEqual({
      rejected: 'not-enough-wp',
    })
    expect(
      checkCast(data, c, { spellId: 'storm-lash', powerLevel: 4, available: allReq }),
    ).toEqual({ rejected: 'bad-power-level' })
  })

  it('금속을 걸치면 거부', () => {
    expect(
      checkCast(data, caster({ armorIds: ['chainmail'] }), {
        spellId: 'storm-lash',
        available: allReq,
      }),
    ).toEqual({ rejected: 'metal' })
  })

  it('일반 마법은 아는 유파 아무 스킬로나 시전', () => {
    const out = checkCast(data, caster(), { spellId: 'unbind', available: allReq })
    if ('rejected' in out) throw new Error(out.rejected)
    expect(out.schoolSkillId).toBe('spirit-magic')
  })
})

describe('시전', () => {
  it('트릭은 자동 성공 + 1 WP', () => {
    const out = castSpell(createRNG(1), data, caster(), {
      spellId: 'spark-flick',
      available: allReq,
    })
    if ('rejected' in out) throw new Error(out.rejected)
    expect(out.success).toBe(true)
    expect(out.roll).toBeNull()
    expect(out.wpSpent).toBe(1)
  })

  it('실패해도 WP 는 소모된다', () => {
    let sawFailure = false
    for (let seed = 0; seed < 300 && !sawFailure; seed++) {
      const out = castSpell(createRNG(seed), data, caster(), {
        spellId: 'storm-lash',
        powerLevel: 2,
        available: allReq,
      })
      if ('rejected' in out) continue
      expect(out.wpSpent).toBe(4)
      if (!out.success) sawFailure = true
    }
    expect(sawFailure).toBe(true)
  })

  it('용과 마(사고표)가 발생한다', () => {
    let sawDragon = false
    let sawMishap = false
    for (let seed = 0; seed < 3000 && !(sawDragon && sawMishap); seed++) {
      const out = castSpell(createRNG(seed), data, caster(), {
        spellId: 'storm-lash',
        available: allReq,
      })
      if ('rejected' in out) continue
      if (out.dragon) sawDragon = true
      if (out.roll?.demon) {
        sawMishap = true
        expect(out.mishap).not.toBeNull()
        expect(out.success).toBe(false)
      }
    }
    expect(sawDragon).toBe(true)
    expect(sawMishap).toBe(true)
  })

  it('그리무아 시전은 시간이 2배로 표기된다', () => {
    const unprepared = caster({ preparedSpellIds: [] })
    const out = castSpell(createRNG(5), data, unprepared, {
      spellId: 'storm-lash',
      available: allReq,
      fromGrimoire: true,
    })
    if ('rejected' in out) throw new Error(out.rejected)
    expect(out.castingTimeSpent).toContain('×2')
  })
})

describe('몸에서 힘 끌어내기', () => {
  it('WP 1 이하에서만, 치유 주문 불가, 굴림 = 획득 WP = 피해', () => {
    expect(powerFromBody(createRNG(1), { wp: 5 }, 6, false)).toEqual({ rejected: 'wp-too-high' })
    expect(powerFromBody(createRNG(1), { wp: 1 }, 6, true)).toEqual({ rejected: 'healing-spell' })
    expect(powerFromBody(createRNG(1), { wp: 0 }, 7, false)).toEqual({ rejected: 'bad-die' })
    const out = powerFromBody(createRNG(2), { wp: 0 }, 12, false)
    if ('rejected' in out) throw new Error('거부됨')
    expect(out.wpGained).toBe(out.damage)
    expect(out.wpGained).toBeGreaterThanOrEqual(1)
    expect(out.wpGained).toBeLessThanOrEqual(12)
  })

  it('치유 주문 판별', () => {
    expect(isHealingSpell(spellOf(data, 'mend-flesh'))).toBe(true)
    expect(isHealingSpell(spellOf(data, 'storm-lash'))).toBe(false)
  })
})

describe('준비 주문', () => {
  it('한도 초과·미습득·트릭 준비를 거부한다', () => {
    const c = caster()
    expect(prepareSpells(data, c, ['storm-lash', 'mend-flesh'], 1)).toEqual({
      rejected: 'over-limit',
    })
    const unknown = prepareSpells(data, c, ['ember-bolt'], 5)
    expect('rejected' in unknown && unknown.rejected).toBe('unknown-spell')
    const trick = prepareSpells(data, c, ['spark-flick'], 5)
    expect('rejected' in trick && trick.rejected).toBe('trick')
    const ok = prepareSpells(data, c, ['storm-lash', 'unbind'], 5)
    expect(ok).toEqual({ preparedSpellIds: ['storm-lash', 'unbind'] })
  })
})

describe('습득', () => {
  const ctx = () => ({
    caster: caster({ knownSpellIds: ['storm-lash', 'spark-flick'] }),
    int: 15,
    languagesLevel: 10,
  })

  it('이미 아는 주문·유파 없음·전제 미충족 거부', () => {
    expect(learnSpellFromTeacher(createRNG(1), data, ctx(), 'storm-lash')).toEqual({
      rejected: 'already-known',
    })
    // ember-bolt 는 원소술 전제 — 정령술사는 거부
    const out = learnSpellFromTeacher(createRNG(1), data, ctx(), 'ember-bolt')
    expect('rejected' in out).toBe(true)
  })

  it('스승 학습은 INT 보온, 그리무아 독학은 언어 판정', () => {
    // mend-flesh 를 모르는 상태로
    const c = ctx()
    let teacherOk = 0
    let grimoireOk = 0
    for (let seed = 0; seed < 300; seed++) {
      const t = learnSpellFromTeacher(createRNG(seed), data, c, 'mend-flesh')
      if (!('rejected' in t) && t.learned) teacherOk++
      const g = learnSpellFromGrimoire(createRNG(seed), data, c, 'mend-flesh')
      if (!('rejected' in g) && g.learned) grimoireOk++
    }
    // INT 15 + 보온 > 언어 10 — 스승 쪽 성공률이 높다
    expect(teacherOk).toBeGreaterThan(grimoireOk)
  })

  it('새 유파: 마법 재능 필요, 성공 시 INT 기본치', () => {
    const noTalent = learnSchool(
      createRNG(1), data,
      { int: 15, hasMagicTalent: false, currentSkillLevels: {} },
      'elemental-magic', 6,
    )
    expect('rejected' in noTalent).toBe(true)

    let learned = false
    for (let seed = 0; seed < 100 && !learned; seed++) {
      const out = learnSchool(
        createRNG(seed), data,
        { int: 15, hasMagicTalent: true, currentSkillLevels: { 'spirit-magic': 12 } },
        'elemental-magic', 6,
      )
      if ('rejected' in out) throw new Error(out.rejected)
      if (out.learned) {
        learned = true
        expect(out.newLevel).toBe(6)
      }
    }
    expect(learned).toBe(true)
  })
})

describe('위력 반영 주사위', () => {
  it('위력이 오르면 perPowerLevel 주사위가 추가된다', () => {
    const spell = spellOf(data, 'storm-lash') // 2D6, 위력당 +D6
    const p1 = rollSpellDice(createRNG(1), spell, 1, 'damage')!
    const p3 = rollSpellDice(createRNG(1), spell, 3, 'damage')!
    expect(p1.rolls).toHaveLength(2)
    expect(p3.rolls).toHaveLength(4)
  })

  it('치유 주문의 위력 반영', () => {
    const spell = spellOf(data, 'mend-flesh') // 2D6, 위력당 +D6 (heal)
    const p2 = rollSpellDice(createRNG(2), spell, 2, 'heal')!
    expect(p2.rolls).toHaveLength(3)
  })

  it('해당 훅이 없으면 null', () => {
    expect(rollSpellDice(createRNG(3), spellOf(data, 'unbind'), 1, 'damage')).toBeNull()
  })
})
