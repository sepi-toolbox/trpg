import { describe, expect, it } from 'vitest'
import { createRNG } from './rng'
import { loadGameData } from './load'
import {
  ALL_CONDITIONS,
  FRESH_REST_USAGE,
  coldExposureFailure,
  diseaseRoll,
  fallDamage,
  fearAttack,
  healConditions,
  lethalPoisonTick,
  poisonExposure,
  rollSevereInjury,
  roundRest,
  shiftRest,
  sleepDeprivationTick,
  starvationDailyTick,
  stretchRest,
  sufferCondition,
} from './hazards'
import type { Vitals } from './hazards'
import type { ConditionId } from './types'

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

describe('상태이상 부여', () => {
  it('기본 부여', () => {
    const out = sufferCondition(createRNG(1), vitals(), 'scared')
    expect(out.gained).toBe('scared')
    expect(out.vitals.conditions).toContain('scared')
  })

  it('이미 가진 상태이상 → 다른 것으로 대체', () => {
    const v = vitals({ conditions: ['scared'] })
    const out = sufferCondition(createRNG(2), v, 'scared', 'angry')
    expect(out.gained).toBe('angry')
    const auto = sufferCondition(createRNG(3), v, 'scared')
    expect(auto.gained).not.toBe('scared')
    expect(auto.gained).not.toBeNull()
  })

  it('6종 보유 시 D6 WP 상실, WP 없으면 D6 HP 상실', () => {
    const full = vitals({ conditions: [...ALL_CONDITIONS] })
    const out = sufferCondition(createRNG(4), full, 'scared')
    expect(out.gained).toBeNull()
    expect(out.overflow!.wpLost).toBeGreaterThanOrEqual(1)
    expect(out.vitals.wp).toBeLessThan(10)

    const noWp = vitals({ conditions: [...ALL_CONDITIONS], wp: 0 })
    const out2 = sufferCondition(createRNG(5), noWp, 'scared')
    expect(out2.overflow!.hpLost).toBeGreaterThanOrEqual(1)
    expect(out2.vitals.hp).toBeLessThan(14)
  })
})

describe('휴식', () => {
  it('라운드 휴식: D6 WP, 시프트당 1회', () => {
    const v = vitals({ wp: 3 })
    const out = roundRest(createRNG(10), v, 10, FRESH_REST_USAGE)
    expect(out.wpHealed).toBeGreaterThanOrEqual(1)
    expect(out.vitals.wp).toBeLessThanOrEqual(10)
    const again = roundRest(createRNG(11), out.vitals, 10, out.usage)
    expect(again.rejected).toBe('already-used-this-shift')
  })

  it('스트레치 휴식: HP+WP+상태이상 1, 간호 시 2D6 HP', () => {
    const v = vitals({ hp: 1, wp: 1, conditions: ['scared', 'angry'] })
    const out = stretchRest(createRNG(12), v, 14, 10, FRESH_REST_USAGE, {
      healCondition: 'angry',
    })
    expect(out.hpHealed).toBeGreaterThanOrEqual(1)
    expect(out.hpHealed).toBeLessThanOrEqual(6)
    expect(out.conditionsHealed).toEqual(['angry'])
    expect(out.vitals.conditions).toEqual(['scared'])

    // 간호: 최소 2 이상 회복
    let minHealed = 99
    for (let seed = 0; seed < 50; seed++) {
      const o = stretchRest(createRNG(seed), vitals({ hp: 1 }), 14, 10, FRESH_REST_USAGE, {
        caregiverSuccess: true,
      })
      minHealed = Math.min(minHealed, o.hpHealed)
    }
    expect(minHealed).toBeGreaterThanOrEqual(2)
  })

  it('능력 보정(깊은 명상류): 추가 주사위와 추가 상태이상 해소', () => {
    const v = vitals({ hp: 1, wp: 1, conditions: ['scared', 'angry'] })
    const out = stretchRest(createRNG(13), v, 30, 30, FRESH_REST_USAGE, {
      healCondition: 'angry',
      bonus: { hpDice: 'D6', wpDice: 'D6', extraConditions: ['scared'] },
    })
    expect(out.hpHealed).toBeGreaterThanOrEqual(2) // D6+D6 최소 2
    expect(out.vitals.conditions).toEqual([])
  })

  it('시프트 휴식: 전부 회복 + 사용 기록 초기화', () => {
    const v = vitals({ hp: 1, wp: 0, conditions: ['scared', 'dazed'] })
    const out = shiftRest(v, 14, 10, )
    expect(out.vitals.hp).toBe(14)
    expect(out.vitals.wp).toBe(10)
    expect(out.vitals.conditions).toEqual([])
    expect(out.usage).toEqual(FRESH_REST_USAGE)
  })

  it('회복은 최대치를 넘지 않는다', () => {
    const out = stretchRest(createRNG(14), vitals(), 14, 10, FRESH_REST_USAGE)
    expect(out.vitals.hp).toBe(14)
    expect(out.vitals.wp).toBe(10)
  })
})

describe('공포', () => {
  it('WIL 성공 시 저항, 자동 저항 능력', () => {
    let resisted = 0
    let failed = 0
    for (let seed = 0; seed < 200; seed++) {
      const out = fearAttack(createRNG(seed), data, vitals())
      if (out.resisted) resisted++
      else {
        failed++
        expect(out.tableRow).not.toBeNull()
      }
    }
    expect(resisted).toBeGreaterThan(0)
    expect(failed).toBeGreaterThan(0)

    const auto = fearAttack(createRNG(1), data, vitals(), { autoResist: true })
    expect(auto.resisted).toBe(true)
    expect(auto.resistRoll).toBeNull()
  })

  it('공포표의 구조화 효과(WP 상실·상태이상)가 자동 적용된다', () => {
    let sawStructured = false
    for (let seed = 0; seed < 500 && !sawStructured; seed++) {
      const out = fearAttack(createRNG(seed), data, vitals())
      if (!out.resisted && (out.applied.wpLost > 0 || out.applied.conditionsGained.length > 0)) {
        sawStructured = true
      }
    }
    expect(sawStructured).toBe(true)
  })

  it('겁먹음(WIL) 상태는 공포 저항에 베인을 준다', () => {
    const scared = vitals({ conditions: ['scared'] })
    const out = fearAttack(createRNG(50), data, scared)
    if (out.resistRoll) expect(out.resistRoll.mode).toBe('bane')
  })
})

describe('독', () => {
  it('강도 vs CON 열린 대결 — 완전/제한 효과가 갈린다', () => {
    let full = 0
    let limited = 0
    for (let seed = 0; seed < 300; seed++) {
      const out = poisonExposure(createRNG(seed), vitals(), 'lethal', 12)
      if (out.fullEffect) {
        full++
        expect(out.ongoing).toBe('lethal')
      } else {
        limited++
        expect(out.ongoing).toBeNull()
        expect(out.applied.hpLost).toBeGreaterThanOrEqual(1) // 제한: D6 한 번
      }
    }
    expect(full).toBeGreaterThan(0)
    expect(limited).toBeGreaterThan(0)
  })

  it('마비독은 탈진, 수면독은 휘청임', () => {
    for (let seed = 0; seed < 50; seed++) {
      const p = poisonExposure(createRNG(seed), vitals(), 'paralyzing', 12)
      expect(p.applied.conditionsGained).toContain('exhausted')
      const s = poisonExposure(createRNG(seed + 100), vitals(), 'sleeping', 12)
      expect(s.applied.conditionsGained).toContain('dazed')
    }
  })

  it('치명독 지속: 라운드당 D6', () => {
    const out = lethalPoisonTick(createRNG(60), vitals({ hp: 10 }))
    expect(out.damage).toBeGreaterThanOrEqual(1)
    expect(out.damage).toBeLessThanOrEqual(6)
    expect(out.vitals.hp).toBe(10 - out.damage)
  })
})

describe('질병', () => {
  it('지면 발병(병약 + D6), 이기면 완치', () => {
    let sick = 0
    let cured = 0
    for (let seed = 0; seed < 300; seed++) {
      const out = diseaseRoll(createRNG(seed), vitals(), { virulence: 12, active: false })
      if (out.cured) cured++
      else {
        sick++
        expect(out.becameSick).toBe(true)
        expect(out.vitals.conditions).toContain('sickly')
        expect(out.hpLost).toBeGreaterThanOrEqual(1)
        expect(out.disease.active).toBe(true)
      }
    }
    expect(sick).toBeGreaterThan(0)
    expect(cured).toBeGreaterThan(0)
  })

  it('간호인은 치료 스킬로 대신 판정한다', () => {
    // 치료 18이면 CON 14보다 유리 — 승률이 높아야 한다
    const winRate = (healer?: number) => {
      let wins = 0
      for (let seed = 0; seed < 400; seed++) {
        const out = diseaseRoll(createRNG(seed), vitals(), { virulence: 12, active: true }, {
          healerSkillLevel: healer,
        })
        if (out.cured) wins++
      }
      return wins
    }
    expect(winRate(18)).toBeGreaterThan(winRate(undefined))
  })
})

describe('낙하', () => {
  it('⌊높이/2⌋ D6, 2m 미만 무해, 곡예 성공 시 절반(올림)', () => {
    expect(fallDamage(createRNG(70), 1, false)).toEqual({ dice: 0, damage: 0 })
    const ten = fallDamage(createRNG(71), 10, false)
    expect(ten.dice).toBe(5)
    expect(ten.damage).toBeGreaterThanOrEqual(5)
    expect(ten.damage).toBeLessThanOrEqual(30)
    const acro = fallDamage(createRNG(72), 10, true)
    expect(acro.dice).toBe(3) // ceil(5/2)
    const seven = fallDamage(createRNG(73), 7, false)
    expect(seven.dice).toBe(3)
  })
})

describe('굶주림·추위·수면 부족', () => {
  it('굶주림: 하루 1 피해', () => {
    expect(starvationDailyTick(vitals({ hp: 5 })).hp).toBe(4)
    expect(starvationDailyTick(vitals({ hp: 0 })).hp).toBe(0)
  })

  it('추위 실패: D6 HP + D6 WP', () => {
    const out = coldExposureFailure(createRNG(80), vitals())
    expect(out.hpLost).toBeGreaterThanOrEqual(1)
    expect(out.wpLost).toBeGreaterThanOrEqual(1)
  })

  it('수면 부족: 시프트당 D6 WP, 0 도달 시 쓰러짐', () => {
    const out = sleepDeprivationTick(createRNG(81), vitals({ wp: 2 }))
    expect(out.wpLost).toBeGreaterThanOrEqual(1)
    if (out.vitals.wp === 0) expect(out.collapsed).toBe(true)
  })
})

describe('중상 (옵션 룰)', () => {
  it('CON 실패 시 중상표를 굴리고 치유 기간이 나온다', () => {
    let injured = 0
    let clean = 0
    for (let seed = 0; seed < 300; seed++) {
      const out = rollSevereInjury(createRNG(seed), data, vitals())
      if (out.injured) {
        injured++
        expect(out.row).not.toBeNull()
        const permanent = out.row!.extra?.['permanent'] === true
        if (!permanent && out.row!.extra?.['healingTime']) {
          expect(out.healingDays).toBeGreaterThanOrEqual(1)
        }
      } else clean++
    }
    expect(injured).toBeGreaterThan(0)
    expect(clean).toBeGreaterThan(0)
  })

  it('토글이 꺼져 있으면 중상 없음', () => {
    const off = { ...data, config: { ...data.config, severeInjuries: false } }
    const out = rollSevereInjury(createRNG(1), off, vitals())
    expect(out.injured).toBe(false)
  })
})

describe('healConditions', () => {
  it('선택 해소와 전체 해소', () => {
    const v = vitals({ conditions: ['scared', 'angry', 'dazed'] as ConditionId[] })
    expect(healConditions(v, ['angry']).conditions).toEqual(['scared', 'dazed'])
    expect(healConditions(v, 'all').conditions).toEqual([])
  })
})
