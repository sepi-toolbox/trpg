/**
 * 캐릭터 — 생성 파이프라인, 파생치, 성장.
 *
 * 생성 순서(원문): 종족 → 고유 능력 → 직업 → 나이 → 이름 → 능력치 →
 * 파생치 → 훈련 스킬 → 영웅 능력(또는 마법) → 약점(옵션) → 장비 → 기념품(옵션)
 *
 * 이 모듈은 "규칙 계산"만 담당한다. 어떤 값을 고를지(직업 선택, 능력치 배치,
 * 스킬 선택)는 호출부(UI/자동생성기)의 몫이고, 여기서는 선택지가 규칙에
 * 맞는지 검사하고 결과를 조립한다.
 */
import type { RNG } from './rng'
import { rollDie } from './rng'
import { roll } from './dice'
import type {
  AgeRow,
  AttributeId,
  Ability,
  ConditionId,
  GameData,
  Kin,
  Profession,
  Skill,
} from './types'
import { ATTRIBUTES } from './types'

/* ─────────────────────────── 런타임 캐릭터 상태 ─────────────────────────── */

export interface CharacterGearItem {
  itemId: string
  qty: number
}

export interface Character {
  name: string
  kinId: string
  professionId: string
  /** 직업에 variants 가 있을 때만 (술사의 유파 등) */
  variantId: string | null
  ageId: AgeRow['id']
  attributes: Record<AttributeId, number>
  /** 스킬 id → 레벨. 핵심 스킬은 전부 존재(기본치), 마법 유파는 훈련 시에만 */
  skillLevels: Record<string, number>
  trainedSkillIds: string[]
  /** 능력 id → 보유 수 (stackable 능력은 2 이상 가능) */
  abilities: Record<string, number>
  /** 알고 있는 주문 id */
  knownSpellIds: string[]
  /** 준비된 주문 id (트릭 제외 — 트릭은 항상 준비 상태) */
  preparedSpellIds: string[]
  hp: number
  wp: number
  conditions: ConditionId[]
  /** 손에 지닌 무기/방패 id (최대 3) */
  weaponsAtHand: string[]
  armorId: string | null
  helmetId: string | null
  inventory: CharacterGearItem[]
  /** 화폐 (실버 단위 총합으로 관리, 표시할 때 환산) */
  silver: number
  /** 성장 마크가 찍힌 스킬 id */
  advancementMarks: string[]
  weaknessId: number | null
  mementoId: number | null
}

/* ─────────────────────────── 파생치 계산 ─────────────────────────── */

export function baseChance(data: GameData, attributeScore: number): number {
  const row = data.baseChanceTable.find(
    (r) => attributeScore >= r.min && attributeScore <= r.max,
  )
  if (!row) throw new Error(`기본치 표 범위 밖의 능력치: ${attributeScore}`)
  return row.baseChance
}

/** STR 또는 AGL 점수 → 피해 보너스 주사위 (null = 없음) */
export function damageBonus(data: GameData, attributeScore: number): string | null {
  const row = data.damageBonusTable.find(
    (r) => attributeScore >= r.min && attributeScore <= r.max,
  )
  if (!row) throw new Error(`피해 보너스 표 범위 밖: ${attributeScore}`)
  return row.bonus
}

export function movementOf(data: GameData, character: Character): number {
  const kin = kinOf(data, character)
  const mod = data.movementModTable.find(
    (r) => character.attributes.agl >= r.min && character.attributes.agl <= r.max,
  )
  if (!mod) throw new Error(`이동력 보정 표 범위 밖: AGL ${character.attributes.agl}`)
  return kin.movement + mod.mod
}

/** 최대 HP = CON + 강골류 보정 */
export function maxHp(data: GameData, character: Character): number {
  return character.attributes.con + abilityBonusTotal(data, character, 'maxHpBonus')
}

/** 최대 WP = WIL + 집중류 보정 */
export function maxWp(data: GameData, character: Character): number {
  return character.attributes.wil + abilityBonusTotal(data, character, 'maxWpBonus')
}

function abilityBonusTotal(data: GameData, character: Character, hook: string): number {
  let total = 0
  for (const [abilityId, count] of Object.entries(character.abilities)) {
    const ability = data.abilities.find((a) => a.id === abilityId)
    if (!ability) continue
    for (const effect of ability.effects) {
      if (effect.hook === hook) {
        total += (Number(effect.params?.['amount']) || 0) * count
      }
    }
  }
  return total
}

/** 준비 가능한 주문 수 = INT 기본치 (트릭 제외) */
export function preparedSpellLimit(data: GameData, character: Character): number {
  return baseChance(data, character.attributes.int)
}

/* ─────────────────────────── 생성: 능력치 굴림 ─────────────────────────── */

/** 4D6 중 최저 1개 제거 → 3~18 */
export function rollAttributeScore(rng: RNG): number {
  const dice = [rollDie(rng, 6), rollDie(rng, 6), rollDie(rng, 6), rollDie(rng, 6)]
  dice.sort((a, b) => a - b)
  return dice[1]! + dice[2]! + dice[3]!
}

/** 능력치 6개 굴림 (배치는 호출부) */
export function rollAttributeScores(rng: RNG): number[] {
  return ATTRIBUTES.map(() => rollAttributeScore(rng))
}

/** 나이 보정 적용 (상한 18, 하한 3은 원문에 없으나 표가 3부터라 3으로 클램프) */
export function applyAgeModifiers(
  attributes: Record<AttributeId, number>,
  age: AgeRow,
): Record<AttributeId, number> {
  const out = { ...attributes }
  for (const key of ATTRIBUTES) {
    const mod = age.attributeMods[key] ?? 0
    out[key] = Math.min(18, Math.max(3, out[key] + mod))
  }
  return out
}

/* ─────────────────────────── 생성: 검증 + 조립 ─────────────────────────── */

export interface CreationInput {
  name: string
  kinId: string
  professionId: string
  variantId?: string
  ageId: AgeRow['id']
  /** 배치 완료된 능력치 (나이 보정 전) */
  attributes: Record<AttributeId, number>
  /** 훈련 스킬: 직업 스킬 6종 + 나이별 자유 선택 */
  trainedSkillIds: string[]
  /** 시작 영웅 능력 (직업 후보 중 하나). 마법사는 생략 */
  heroicAbilityId?: string
  /** 마법사 전용: 시작 주문/트릭 선택 */
  spellIds?: string[]
  /** D6 장비 세트 눈 (생략 시 굴림) */
  gearRoll?: number
  weaknessId?: number | null
  mementoId?: number | null
}

export function kinOf(data: GameData, c: { kinId: string }): Kin {
  const kin = data.kin.find((k) => k.id === c.kinId)
  if (!kin) throw new Error(`없는 종족: ${c.kinId}`)
  return kin
}

export function professionOf(data: GameData, c: { professionId: string }): Profession {
  const p = data.professions.find((x) => x.id === c.professionId)
  if (!p) throw new Error(`없는 직업: ${c.professionId}`)
  return p
}

export function professionSkillIds(profession: Profession, variantId: string | null): string[] {
  if (profession.variants) {
    const v = profession.variants.find((x) => x.id === variantId)
    if (!v) throw new Error(`직업 ${profession.id} 에 없는 하위 선택지: ${variantId}`)
    return v.skillIds
  }
  if (!profession.skillIds) throw new Error(`직업 ${profession.id} 에 스킬 목록이 없음`)
  return profession.skillIds
}

function skillOf(data: GameData, id: string): Skill {
  const s = data.skills.find((x) => x.id === id)
  if (!s) throw new Error(`없는 스킬: ${id}`)
  return s
}

function abilityOf(data: GameData, id: string): Ability {
  const a = data.abilities.find((x) => x.id === id)
  if (!a) throw new Error(`없는 능력: ${id}`)
  return a
}

/**
 * 생성 입력을 검증하고 캐릭터를 조립한다.
 * 규칙 위반은 예외로 던진다 — UI 는 이 예외 메시지를 그대로 보여줄 수 있다.
 */
export function createCharacter(rng: RNG, data: GameData, input: CreationInput): Character {
  const kin = kinOf(data, input)
  const profession = professionOf(data, input)
  const variantId = input.variantId ?? null
  const profSkills = professionSkillIds(profession, variantId)

  const age = data.ageTable.find((a) => a.id === input.ageId)
  if (!age) throw new Error(`없는 나이: ${input.ageId}`)

  /* 훈련 스킬 검증: 총수 = 6 + 나이 추가분, 직업 스킬이 6종 이상 */
  const expectedTotal = 6 + age.extraTrainedSkills
  if (input.trainedSkillIds.length !== expectedTotal) {
    throw new Error(
      `훈련 스킬은 ${expectedTotal}종이어야 합니다 (현재 ${input.trainedSkillIds.length})`,
    )
  }
  if (new Set(input.trainedSkillIds).size !== input.trainedSkillIds.length) {
    throw new Error('훈련 스킬이 중복되었습니다')
  }
  const fromProfession = input.trainedSkillIds.filter((s) => profSkills.includes(s))
  if (fromProfession.length < 6) {
    throw new Error(`직업 스킬에서 6종을 골라야 합니다 (현재 ${fromProfession.length})`)
  }
  for (const s of input.trainedSkillIds) {
    const skill = skillOf(data, s)
    // 마법 유파는 직업(변형)에 포함된 경우에만 훈련 가능
    if (skill.kind === 'magic' && !profSkills.includes(s)) {
      throw new Error(`마법 유파 ${s} 는 이 직업으로 훈련할 수 없습니다`)
    }
  }

  /* 능력치: 나이 보정 적용 */
  const attributes = applyAgeModifiers(input.attributes, age)
  for (const key of ATTRIBUTES) {
    if (attributes[key] < 3 || attributes[key] > 18) {
      throw new Error(`능력치 ${key} 가 3~18 범위를 벗어남: ${attributes[key]}`)
    }
  }

  /* 스킬 레벨: 핵심 스킬 = 기본치, 훈련 스킬 = 기본치 ×2 */
  const skillLevels: Record<string, number> = {}
  for (const skill of data.skills) {
    const bc = baseChance(data, attributes[skill.attribute])
    if (skill.kind === 'magic') {
      if (input.trainedSkillIds.includes(skill.id)) skillLevels[skill.id] = bc * 2
      // 훈련 안 한 유파는 기본치 없음 (키 자체가 없음)
    } else {
      skillLevels[skill.id] = input.trainedSkillIds.includes(skill.id) ? bc * 2 : bc
    }
  }

  /* 능력: 종족 고유 + 시작 영웅 능력 (또는 마법) */
  const abilities: Record<string, number> = {}
  for (const id of kin.abilityIds) {
    abilityOf(data, id)
    abilities[id] = (abilities[id] ?? 0) + 1
  }

  const knownSpellIds: string[] = []
  if (profession.startingMagic) {
    if (input.heroicAbilityId) {
      throw new Error('마법 직업은 시작 영웅 능력을 가질 수 없습니다')
    }
    const magicSkillId = profSkills.find((s) => skillOf(data, s).kind === 'magic')
    if (!magicSkillId || !input.trainedSkillIds.includes(magicSkillId)) {
      throw new Error('마법 직업은 유파 스킬을 훈련해야 합니다')
    }
    const picks = input.spellIds ?? []
    const spells = picks.map((id) => {
      const sp = data.spells.find((x) => x.id === id)
      if (!sp) throw new Error(`없는 주문: ${id}`)
      if (sp.school !== 'general' && sp.school !== magicSkillId) {
        throw new Error(`주문 ${id} 는 유파 ${magicSkillId} 또는 일반 마법이 아닙니다`)
      }
      return sp
    })
    const spellCount = spells.filter((s) => s.kind === 'spell').length
    const trickCount = spells.filter((s) => s.kind === 'trick').length
    if (spellCount !== profession.startingMagic.spells) {
      throw new Error(`시작 주문은 랭크 1 ${profession.startingMagic.spells}개여야 합니다`)
    }
    if (trickCount !== profession.startingMagic.tricks) {
      throw new Error(`시작 트릭은 ${profession.startingMagic.tricks}개여야 합니다`)
    }
    for (const s of spells) {
      if (s.kind === 'spell' && s.rank !== 1) {
        throw new Error(`시작 주문은 랭크 1만 가능: ${s.id} (랭크 ${s.rank})`)
      }
    }
    knownSpellIds.push(...picks)
  } else {
    if (!input.heroicAbilityId) throw new Error('시작 영웅 능력을 골라야 합니다')
    if (!profession.heroicAbilityIds.includes(input.heroicAbilityId)) {
      throw new Error(`직업 ${profession.id} 의 시작 영웅 능력이 아닙니다: ${input.heroicAbilityId}`)
    }
    abilityOf(data, input.heroicAbilityId)
    abilities[input.heroicAbilityId] = (abilities[input.heroicAbilityId] ?? 0) + 1
  }

  /* 장비 세트 */
  const gearRoll = input.gearRoll ?? rollDie(rng, 6)
  const gearSet = profession.gearSets.find(
    (g) => gearRoll >= g.roll.min && gearRoll <= g.roll.max,
  )
  if (!gearSet) throw new Error(`장비 세트 표에 없는 눈: ${gearRoll}`)

  const weaponsAtHand: string[] = []
  let armorId: string | null = null
  let helmetId: string | null = null
  const inventory: CharacterGearItem[] = []

  for (const gi of gearSet.items) {
    const qty = typeof gi.qty === 'string' ? roll(rng, gi.qty).total : (gi.qty ?? 1)
    const weapon = data.weapons.find((w) => w.id === gi.itemId)
    const armor = data.armor.find((a) => a.id === gi.itemId)
    if (weapon) {
      if (weaponsAtHand.length < 3) weaponsAtHand.push(weapon.id)
      else inventory.push({ itemId: weapon.id, qty })
    } else if (armor) {
      if (armor.kind === 'helmet') helmetId = armor.id
      else armorId = armor.id
    } else {
      inventory.push({ itemId: gi.itemId, qty })
    }
  }

  const character: Character = {
    name: input.name.trim() || '이름 없는 모험가',
    kinId: kin.id,
    professionId: profession.id,
    variantId,
    ageId: age.id,
    attributes,
    skillLevels,
    trainedSkillIds: [...input.trainedSkillIds],
    abilities,
    knownSpellIds,
    preparedSpellIds: [],
    hp: 0,
    wp: 0,
    conditions: [],
    weaponsAtHand,
    armorId,
    helmetId,
    inventory,
    silver: roll(rng, gearSet.silver).total,
    advancementMarks: [],
    weaknessId: input.weaknessId ?? null,
    mementoId: input.mementoId ?? null,
  }

  /* 생성 직후: 알고 있는 주문을 한도까지 자동 준비 (트릭 제외) */
  const limit = preparedSpellLimit(data, character)
  character.preparedSpellIds = knownSpellIds
    .filter((id) => data.spells.find((s) => s.id === id)?.kind === 'spell')
    .slice(0, limit)

  character.hp = maxHp(data, character)
  character.wp = maxWp(data, character)
  return character
}

/* ─────────────────────────── 소지 한도 ─────────────────────────── */

/**
 * 소지 한도 = ⌈STR / 2⌉ (+배낭 2).
 * 손의 무기 3개, 착용한 갑옷·투구, tiny(무게 0)는 계산에서 제외.
 * 식량은 4개당 1 (weight 0.25), 동전은 100닢당 1.
 */
export function encumbrance(data: GameData, character: Character): {
  limit: number
  carried: number
  overEncumbered: boolean
} {
  const hasBackpack = character.inventory.some((i) => i.itemId === 'backpack')
  const limit = Math.ceil(character.attributes.str / 2) + (hasBackpack ? 2 : 0)

  let carried = 0
  for (const entry of character.inventory) {
    if (entry.itemId === 'backpack') continue
    const item = data.items.find((i) => i.id === entry.itemId)
    const weapon = data.weapons.find((w) => w.id === entry.itemId)
    const weight = item ? item.weight : weapon ? 1 : 1
    carried += weight * entry.qty
  }
  carried += Math.floor(character.silver / 100)

  return { limit, carried: Math.ceil(carried), overEncumbered: Math.ceil(carried) > limit }
}

/* ─────────────────────────── 성장 ─────────────────────────── */

/** 용/마를 굴렸을 때 스킬에 성장 마크를 찍는다 (스킬당 1개) */
export function markAdvancement(character: Character, skillId: string): Character {
  if (character.advancementMarks.includes(skillId)) return character
  return { ...character, advancementMarks: [...character.advancementMarks, skillId] }
}

/** 세션 종료 질문 5종 — 예라고 답한 수만큼 추가 마크 (스킬은 호출부가 선택) */
export const SESSION_QUESTIONS = [
  '게임 세션에 참여했는가?',
  '새로운 장소를 탐험했는가?',
  '위험한 적을 하나 이상 물리쳤는가?',
  '폭력을 쓰지 않고 장애물을 넘었는가?',
  '약점에 굴복했는가? (옵션 룰)',
] as const

export interface AdvancementRollResult {
  skillId: string
  roll: number
  before: number
  after: number
  improved: boolean
}

/**
 * 세션 종료: 마크가 찍힌 스킬마다 D20 — 현재 레벨 초과 시 +1 (최대 18).
 * 마크는 전부 지워진다.
 */
export function resolveAdvancement(
  rng: RNG,
  character: Character,
): { character: Character; results: AdvancementRollResult[] } {
  const results: AdvancementRollResult[] = []
  const skillLevels = { ...character.skillLevels }

  for (const skillId of character.advancementMarks) {
    const before = skillLevels[skillId] ?? 0
    const rolled = rollDie(rng, 20)
    const improved = rolled > before && before < 18
    const after = improved ? before + 1 : before
    skillLevels[skillId] = after
    results.push({ skillId, roll: rolled, before, after, improved })
  }

  return {
    character: { ...character, skillLevels, advancementMarks: [] },
    results,
  }
}

/**
 * 스승 훈련: 스킬 15 이상 + 나보다 높은 스승에게 1시프트 → 즉시 성장 굴림 1회.
 * 스승으로는 스킬당 1레벨만 올릴 수 있다는 제약은 호출부(세션 상태)가 관리.
 */
export function trainWithTeacher(
  rng: RNG,
  character: Character,
  skillId: string,
  teacherLevel: number,
): { character: Character; result: AdvancementRollResult | null; rejected?: string } {
  const current = character.skillLevels[skillId] ?? 0
  if (teacherLevel < 15) return { character, result: null, rejected: '스승의 스킬이 15 미만' }
  if (teacherLevel <= current) return { character, result: null, rejected: '스승이 나보다 낮거나 같음' }

  const rolled = rollDie(rng, 20)
  const improved = rolled > current && current < 18
  const after = improved ? current + 1 : current
  return {
    character: { ...character, skillLevels: { ...character.skillLevels, [skillId]: after } },
    result: { skillId, roll: rolled, before: current, after, improved },
  }
}

/** 스킬 18 도달 시 새 영웅 능력 획득 자격 (선택은 호출부) */
export function earnedHeroicAbility(before: number, after: number): boolean {
  return before < 18 && after >= 18
}
