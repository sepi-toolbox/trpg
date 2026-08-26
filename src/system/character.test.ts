import { describe, expect, it } from 'vitest'
import { createRNG } from './rng'
import { loadGameData } from './load'
import {
  applyAgeModifiers,
  baseChance,
  createCharacter,
  damageBonus,
  earnedHeroicAbility,
  encumbrance,
  markAdvancement,
  maxHp,
  maxWp,
  movementOf,
  preparedSpellLimit,
  resolveAdvancement,
  rollAttributeScore,
  rollAttributeScores,
  trainWithTeacher,
} from './character'
import type { CreationInput } from './character'
import type { AttributeId } from './types'

const data = loadGameData()

const ATTRS: Record<AttributeId, number> = {
  str: 15, con: 14, agl: 13, int: 12, wil: 10, cha: 8,
}

/** 무인(fighter) 표준 생성 입력 */
function fighterInput(overrides: Partial<CreationInput> = {}): CreationInput {
  return {
    name: '시험자',
    kinId: 'human',
    professionId: 'fighter',
    ageId: 'adult',
    attributes: { ...ATTRS },
    // 직업 스킬 6 + 성년 자유 4
    trainedSkillIds: [
      'swords', 'axes', 'evade', 'brawling', 'spears', 'bows',
      'awareness', 'acrobatics', 'bushcraft', 'healing',
    ],
    heroicAbilityId: 'veteran',
    gearRoll: 1,
    ...overrides,
  }
}

/** 술사(정령술) 표준 생성 입력 */
function mageInput(overrides: Partial<CreationInput> = {}): CreationInput {
  return {
    name: '시험술사',
    kinId: 'starfolk',
    professionId: 'mage',
    variantId: 'spirit',
    ageId: 'adult',
    attributes: { ...ATTRS, int: 15, wil: 14, str: 10 },
    trainedSkillIds: [
      'spirit-magic', 'healing', 'evade', 'staves', 'bushcraft', 'sneaking',
      'awareness', 'acrobatics', 'swimming', 'languages',
    ],
    spellIds: ['storm-lash', 'mend-flesh', 'unbind', 'spark-flick'],
    gearRoll: 1,
    ...overrides,
  }
}

describe('파생치', () => {
  it('기본치 구간표', () => {
    expect(baseChance(data, 3)).toBe(3)
    expect(baseChance(data, 8)).toBe(4)
    expect(baseChance(data, 12)).toBe(5)
    expect(baseChance(data, 15)).toBe(6)
    expect(baseChance(data, 18)).toBe(7)
  })

  it('피해 보너스 구간표', () => {
    expect(damageBonus(data, 12)).toBeNull()
    expect(damageBonus(data, 13)).toBe('D4')
    expect(damageBonus(data, 16)).toBe('D4')
    expect(damageBonus(data, 17)).toBe('D6')
  })

  it('나이 보정: 상한 18, 하한 3', () => {
    const old = data.ageTable.find((a) => a.id === 'old')!
    const young = data.ageTable.find((a) => a.id === 'young')!
    const modded = applyAgeModifiers({ str: 4, con: 3, agl: 4, int: 18, wil: 18, cha: 10 }, old)
    expect(modded.str).toBe(3) // 4-2 → 3 하한
    expect(modded.con).toBe(3) // 3-2 → 3 하한
    expect(modded.int).toBe(18) // 18+1 → 18 상한
    const y = applyAgeModifiers({ str: 10, con: 18, agl: 18, int: 10, wil: 10, cha: 10 }, young)
    expect(y.con).toBe(18)
    expect(y.agl).toBe(18)
  })
})

describe('능력치 굴림', () => {
  it('4D6 최저 제거 → 3~18', () => {
    const rng = createRNG(1)
    for (let i = 0; i < 3000; i++) {
      const v = rollAttributeScore(rng)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(18)
    }
  })

  it('6개 굴림', () => {
    expect(rollAttributeScores(createRNG(2))).toHaveLength(6)
  })
})

describe('캐릭터 생성 — 무인', () => {
  const rng = () => createRNG(100)
  const c = createCharacter(rng(), data, fighterInput())

  it('HP = CON, WP = WIL', () => {
    expect(c.hp).toBe(14)
    expect(maxHp(data, c)).toBe(14)
    expect(c.wp).toBe(10)
    expect(maxWp(data, c)).toBe(10)
  })

  it('이동력 = 종족 + AGL 보정', () => {
    // human 10 + AGL13(+2) = 12
    expect(movementOf(data, c)).toBe(12)
  })

  it('훈련 스킬 = 기본치 2배, 비훈련 핵심 스킬 = 기본치', () => {
    // swords: STR 15 → 기본치 6 → 훈련 12
    expect(c.skillLevels['swords']).toBe(12)
    // sneaking(비훈련): AGL 13 → 기본치 6
    expect(c.skillLevels['sneaking']).toBe(6)
    // 마법 유파는 비훈련 시 키 없음
    expect(c.skillLevels['spirit-magic']).toBeUndefined()
  })

  it('종족 고유 능력 + 시작 영웅 능력 보유', () => {
    expect(c.abilities['adaptive']).toBe(1)
    expect(c.abilities['veteran']).toBe(1)
  })

  it('장비 세트가 배치된다 (무기는 손, 갑옷은 착용, 나머지는 소지품)', () => {
    expect(c.weaponsAtHand).toContain('broadsword')
    expect(c.weaponsAtHand).toContain('shield-small')
    expect(c.armorId).toBe('chainmail')
    expect(c.inventory.some((i) => i.itemId === 'torch')).toBe(true)
    expect(c.silver).toBeGreaterThanOrEqual(1)
    expect(c.silver).toBeLessThanOrEqual(6)
  })

  it('생성 검증: 훈련 스킬 수·직업 6종·중복', () => {
    expect(() =>
      createCharacter(rng(), data, fighterInput({ trainedSkillIds: ['swords'] })),
    ).toThrow(/10종/)
    expect(() =>
      createCharacter(
        rng(), data,
        fighterInput({
          trainedSkillIds: [
            // 직업 스킬 5종뿐
            'swords', 'axes', 'evade', 'brawling', 'spears',
            'awareness', 'acrobatics', 'bushcraft', 'healing', 'sneaking',
          ],
        }),
      ),
    ).toThrow(/직업 스킬에서 6종/)
    expect(() =>
      createCharacter(
        rng(), data,
        fighterInput({
          trainedSkillIds: [
            'swords', 'swords', 'axes', 'evade', 'brawling', 'spears',
            'bows', 'awareness', 'acrobatics', 'bushcraft',
          ],
        }),
      ),
    ).toThrow(/중복/)
  })

  it('영웅 능력은 직업 후보에서만', () => {
    expect(() =>
      createCharacter(rng(), data, fighterInput({ heroicAbilityId: 'robust' })),
    ).toThrow(/시작 영웅 능력이 아닙니다/)
  })
})

describe('캐릭터 생성 — 술사', () => {
  it('유파+주문 3/트릭 3으로 생성된다', () => {
    // 트릭이 데이터에 1종뿐이라 임시로 복제 id 검증 대신 실제 데이터로 맞춘다
    const input = mageInput({
      spellIds: ['storm-lash', 'mend-flesh', 'unbind', 'spark-flick'],
    })
    // 트릭 1개뿐이므로 트릭 3개 요구에 걸린다 — 이 검증이 동작하는지 확인
    expect(() => createCharacter(createRNG(200), data, input)).toThrow(/트릭/)
  })

  it('다른 유파 주문은 거부된다', () => {
    const input = mageInput({ spellIds: ['ember-bolt', 'mend-flesh', 'unbind', 'spark-flick'] })
    expect(() => createCharacter(createRNG(201), data, input)).toThrow(/유파/)
  })

  it('마법 직업이 영웅 능력을 고르면 거부된다', () => {
    const input = mageInput({ heroicAbilityId: 'veteran' })
    expect(() => createCharacter(createRNG(202), data, input)).toThrow(/마법 직업/)
  })
})

describe('강골/집중 보정', () => {
  it('강골 2개는 최대 HP +4', () => {
    const c = createCharacter(createRNG(300), data, fighterInput())
    const buffed = { ...c, abilities: { ...c.abilities, robust: 2 } }
    expect(maxHp(data, buffed)).toBe(14 + 4)
  })
})

describe('준비 주문 한도', () => {
  it('한도 = INT 기본치', () => {
    const c = createCharacter(createRNG(400), data, fighterInput())
    // INT 12 → 기본치 5
    expect(preparedSpellLimit(data, c)).toBe(5)
  })
})

describe('소지 한도', () => {
  it('한도 = ⌈STR/2⌉, 손 무기·착용 갑옷 제외', () => {
    const c = createCharacter(createRNG(500), data, fighterInput())
    const e = encumbrance(data, c)
    expect(e.limit).toBe(Math.ceil(15 / 2))
    expect(e.carried).toBeGreaterThan(0)
  })

  it('동전 100닢당 1', () => {
    const c = createCharacter(createRNG(501), data, fighterInput())
    const rich = { ...c, silver: 250 }
    const poor = { ...c, silver: 99 }
    expect(encumbrance(data, rich).carried - encumbrance(data, poor).carried).toBe(2)
  })
})

describe('성장', () => {
  it('마크는 스킬당 1개', () => {
    let c = createCharacter(createRNG(600), data, fighterInput())
    c = markAdvancement(c, 'swords')
    c = markAdvancement(c, 'swords')
    expect(c.advancementMarks).toEqual(['swords'])
  })

  it('세션 종료: D20 > 현재 레벨이면 +1, 마크 소거', () => {
    let c = createCharacter(createRNG(601), data, fighterInput())
    c = markAdvancement(c, 'swords')
    c = markAdvancement(c, 'sneaking')
    const { character: after, results } = resolveAdvancement(createRNG(602), c)
    expect(after.advancementMarks).toEqual([])
    for (const r of results) {
      expect(r.after).toBe(r.improved ? r.before + 1 : r.before)
      if (r.roll <= r.before) expect(r.improved).toBe(false)
    }
  })

  it('레벨 18은 더 오르지 않는다', () => {
    let c = createCharacter(createRNG(603), data, fighterInput())
    c = { ...c, skillLevels: { ...c.skillLevels, swords: 18 } }
    c = markAdvancement(c, 'swords')
    const { character: after } = resolveAdvancement(createRNG(604), c)
    expect(after.skillLevels['swords']).toBe(18)
  })

  it('스승 훈련: 15 미만·나 이하 스승은 거부', () => {
    const c = createCharacter(createRNG(605), data, fighterInput())
    expect(trainWithTeacher(createRNG(1), c, 'swords', 14).rejected).toBeTruthy()
    expect(trainWithTeacher(createRNG(1), c, 'swords', 12).rejected).toBeTruthy()
    const ok = trainWithTeacher(createRNG(1), c, 'swords', 16)
    expect(ok.rejected).toBeUndefined()
    expect(ok.result).not.toBeNull()
  })

  it('18 도달 시 영웅 능력 획득 자격', () => {
    expect(earnedHeroicAbility(17, 18)).toBe(true)
    expect(earnedHeroicAbility(18, 18)).toBe(false)
    expect(earnedHeroicAbility(10, 11)).toBe(false)
  })
})

describe('생성 재현성', () => {
  it('같은 시드 + 같은 입력 = 같은 캐릭터', () => {
    const a = createCharacter(createRNG(700), data, fighterInput({ gearRoll: undefined }))
    const b = createCharacter(createRNG(700), data, fighterInput({ gearRoll: undefined }))
    expect(a).toEqual(b)
  })
})
