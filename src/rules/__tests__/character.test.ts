import { describe, expect, it } from 'vitest'
import { createRNG } from '../rng'
import {
  STANDARD_ARRAY,
  assignByPriority,
  attackBonusOf,
  createCharacter,
  defenseOf,
  gainXp,
  levelForXp,
  longRest,
  rollAbilityScore,
} from '../character'
import { ABILITY_KEYS } from '../types'
import { CLASSES } from '../../data'

describe('rollAbilityScore', () => {
  it('4d6 중 최저 1개 제외 → 3~18 범위', () => {
    const rng = createRNG(1)
    for (let i = 0; i < 3000; i++) {
      const score = rollAbilityScore(rng)
      expect(score).toBeGreaterThanOrEqual(3)
      expect(score).toBeLessThanOrEqual(18)
    }
  })
})

describe('createCharacter', () => {
  it('모든 클래스가 생성 가능하고 파생 스탯이 유효하다', () => {
    for (const cls of CLASSES) {
      const rng = createRNG(77)
      const c = createCharacter(rng, {
        name: '테스터',
        classId: cls.id,
        abilities: STANDARD_ARRAY,
      })

      expect(c.level).toBe(1)
      expect(c.hp).toBe(c.maxHp)
      expect(c.maxHp).toBeGreaterThan(0)
      expect(defenseOf(c)).toBeGreaterThanOrEqual(10)
      expect(Number.isFinite(attackBonusOf(c))).toBe(true)
      for (const key of ABILITY_KEYS) expect(c.abilities[key]).toBeGreaterThan(0)
      // 클래스 기술 사용 횟수가 초기화돼 있어야 한다
      for (const id of c.skills) expect(c.skillUses[id]).toBeGreaterThan(0)
    }
  })

  it('이름이 비면 기본 이름을 넣는다', () => {
    const c = createCharacter(createRNG(2), {
      name: '   ',
      classId: 'warrior',
      abilities: STANDARD_ARRAY,
    })
    expect(c.name).toBe('이름 없는 모험가')
  })

  it('없는 클래스는 예외', () => {
    expect(() =>
      createCharacter(createRNG(3), {
        name: 'x',
        classId: 'nope',
        abilities: STANDARD_ARRAY,
      }),
    ).toThrow()
  })
})

describe('defenseOf', () => {
  it('갑옷의 민첩 상한을 넘겨 반영하지 않는다', () => {
    const rng = createRNG(5)
    const c = createCharacter(rng, {
      name: '민첩전사',
      classId: 'warrior', // 사슬 갑옷: 기본 14, 민첩 상한 +2
      abilities: { ...STANDARD_ARRAY, dex: 20 }, // 민첩 보정 +5
    })
    expect(defenseOf(c)).toBe(14 + 2)
  })
})

describe('경험치와 레벨', () => {
  it('누적 경험치 구간에 맞는 레벨을 준다', () => {
    expect(levelForXp(0)).toBe(1)
    expect(levelForXp(119)).toBe(1)
    expect(levelForXp(120)).toBe(2)
    expect(levelForXp(300)).toBe(3)
    expect(levelForXp(999999)).toBe(9)
  })

  it('레벨업하면 최대 생명력이 오르고 기술 사용 횟수가 회복된다', () => {
    const rng = createRNG(11)
    let c = createCharacter(rng, {
      name: '성장',
      classId: 'mage',
      abilities: STANDARD_ARRAY,
    })
    const firstSkill = c.skills[0]!
    c = { ...c, skillUses: { ...c.skillUses, [firstSkill]: 0 } }

    const before = c.maxHp
    const { character, leveledTo } = gainXp(rng, c, 120)

    expect(leveledTo).toBe(2)
    expect(character.maxHp).toBeGreaterThan(before)
    expect(character.skillUses[firstSkill]).toBeGreaterThan(0)
  })

  it('레벨업이 없으면 경험치만 누적된다', () => {
    const rng = createRNG(12)
    const c = createCharacter(rng, {
      name: '성장',
      classId: 'rogue',
      abilities: STANDARD_ARRAY,
    })
    const { character, leveledTo } = gainXp(rng, c, 50)
    expect(leveledTo).toBeNull()
    expect(character.xp).toBe(50)
    expect(character.level).toBe(1)
  })
})

describe('longRest', () => {
  it('생명력과 기술 사용 횟수를 완전히 회복한다', () => {
    const rng = createRNG(13)
    let c = createCharacter(rng, {
      name: '휴식',
      classId: 'cleric',
      abilities: STANDARD_ARRAY,
    })
    c = { ...c, hp: 1, skillUses: { mend: 0, blessing: 0 }, buffTurns: 3 }

    const rested = longRest(c)
    expect(rested.hp).toBe(rested.maxHp)
    expect(rested.skillUses['mend']).toBeGreaterThan(0)
    expect(rested.buffTurns).toBe(0)
  })
})

describe('assignByPriority', () => {
  it('높은 값을 클래스 우선순위 순서대로 꽂는다', () => {
    const mage = CLASSES.find((c) => c.id === 'mage')!
    const abilities = assignByPriority([15, 14, 13, 12, 10, 8], mage)
    expect(abilities[mage.abilityPriority[0]!]).toBe(15)
    expect(abilities[mage.abilityPriority[5]!]).toBe(8)
  })

  it('모든 클래스에서 값 6개가 빠짐없이 배분된다', () => {
    for (const cls of CLASSES) {
      const a = assignByPriority([15, 14, 13, 12, 10, 8], cls)
      expect(Object.values(a).sort((x, y) => y - x)).toEqual([15, 14, 13, 12, 10, 8])
    }
  })
})
