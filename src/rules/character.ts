import type { RNG } from './rng'
import { rollDie } from './rng'
import { parseDice, roll } from './dice'
import { abilityModifier, proficiencyBonus } from './check'
import { ABILITY_KEYS } from './types'
import type { Abilities, Character, ClassDef, SkillDef } from './types'
import { ARMOR_BY_ID, CLASS_BY_ID, SKILL_BY_ID, WEAPON_BY_ID } from '../data'

/** 4d6 중 가장 낮은 눈 하나를 버리고 합산 — 고전적인 능력치 생성법 */
export function rollAbilityScore(rng: RNG): number {
  const dice = [rollDie(rng, 6), rollDie(rng, 6), rollDie(rng, 6), rollDie(rng, 6)]
  dice.sort((a, b) => a - b)
  return dice[1]! + dice[2]! + dice[3]!
}

export function rollAbilities(rng: RNG): Abilities {
  const out = {} as Abilities
  for (const key of ABILITY_KEYS) out[key] = rollAbilityScore(rng)
  return out
}

/** 표준 배열 값 — 높은 순 */
export const STANDARD_VALUES = [15, 14, 13, 12, 10, 8] as const

/** 표준 배열 기본형 (클래스 미지정 시) */
export const STANDARD_ARRAY: Abilities = {
  str: 15,
  dex: 14,
  con: 13,
  int: 12,
  wis: 10,
  cha: 8,
}

/**
 * 값 목록을 클래스 우선순위대로 배분한다.
 * 표준 배열이든 굴린 값이든 같은 규칙을 태워서 클래스 간 출발선을 맞춘다.
 */
export function assignByPriority(values: readonly number[], cls: ClassDef): Abilities {
  const sorted = [...values].sort((a, b) => b - a)
  const out = {} as Abilities
  const order = [
    ...cls.abilityPriority,
    ...ABILITY_KEYS.filter((k) => !cls.abilityPriority.includes(k)),
  ]
  order.forEach((key, i) => {
    out[key] = sorted[i] ?? 10
  })
  return out
}

/** 클래스에 맞춘 표준 배열 */
export function standardArrayFor(cls: ClassDef): Abilities {
  return assignByPriority(STANDARD_VALUES, cls)
}

/** 4d6 굴림을 클래스 우선순위대로 배분 */
export function rollAbilitiesFor(rng: RNG, cls: ClassDef): Abilities {
  const values = ABILITY_KEYS.map(() => rollAbilityScore(rng))
  return assignByPriority(values, cls)
}

export function applyClassBonus(base: Abilities, cls: ClassDef): Abilities {
  const out = { ...base }
  for (const key of ABILITY_KEYS) {
    out[key] = base[key] + (cls.abilityBonus[key] ?? 0)
  }
  return out
}

/** 레벨 1 캐릭터 생성. 1레벨 생명력은 주사위 최대치 고정(초반 즉사 방지). */
export function createCharacter(
  rng: RNG,
  args: { name: string; classId: string; abilities: Abilities },
): Character {
  const cls = CLASS_BY_ID[args.classId]
  if (!cls) throw new Error(`없는 클래스: ${args.classId}`)

  const abilities = applyClassBonus(args.abilities, cls)
  const conMod = abilityModifier(abilities.con)
  const maxHp = maxHpForLevel(cls, 1, conMod, rng)

  const skillUses: Record<string, number> = {}
  for (const id of cls.skills) {
    const skill = SKILL_BY_ID[id]
    if (skill) skillUses[id] = skill.uses
  }

  return {
    name: args.name.trim() || '이름 없는 모험가',
    classId: cls.id,
    level: 1,
    abilities,
    maxHp,
    hp: maxHp,
    weaponId: cls.startingWeapon,
    armorId: cls.startingArmor,
    proficiencies: cls.proficiencies,
    skills: cls.skills,
    skillUses,
    xp: 0,
    buffTurns: 0,
  }
}

/**
 * 1레벨 생명력 하한선.
 * 이게 없으면 1레벨 마법사(1d6)가 고블린 2방에 죽어서 게임이 성립하지 않는다.
 */
export const BASE_HP_BONUS = 4

/** 1레벨은 주사위 최대치 고정, 2레벨부터 굴려서 누적 */
function maxHpForLevel(cls: ClassDef, level: number, conMod: number, rng: RNG): number {
  const spec = parseDice(cls.hitDie)
  let hp = spec.count * spec.sides + spec.modifier + conMod + BASE_HP_BONUS
  for (let l = 2; l <= level; l++) {
    hp += Math.max(1, roll(rng, cls.hitDie).total + conMod)
  }
  return Math.max(1, hp)
}

/**
 * 레벨업에 필요한 누적 경험치.
 * 5개 층 1회 주파로 얻는 총 경험치(대략 2000~2500)에 맞춰 잡았다.
 * 여기를 건드리면 게임 길이 전체가 흔들리므로 engine 테스트로 가드해 둔다.
 */
export const XP_THRESHOLDS = [0, 120, 300, 600, 1000, 1500, 2200, 3000, 4000]

export function levelForXp(xp: number): number {
  let level = 1
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]!) level = i + 1
  }
  return level
}

/** 경험치를 더하고, 레벨이 올랐으면 생명력을 굴려 올린다. */
export function gainXp(
  rng: RNG,
  character: Character,
  amount: number,
): { character: Character; leveledTo: number | null } {
  const xp = character.xp + amount
  const newLevel = levelForXp(xp)
  if (newLevel === character.level) {
    return { character: { ...character, xp }, leveledTo: null }
  }

  const cls = CLASS_BY_ID[character.classId]!
  const conMod = abilityModifier(character.abilities.con)
  let maxHp = character.maxHp
  for (let l = character.level + 1; l <= newLevel; l++) {
    maxHp += Math.max(1, roll(rng, cls.hitDie).total + conMod)
  }

  // 레벨업 시 기술 사용 횟수 회복
  const skillUses = { ...character.skillUses }
  for (const id of character.skills) {
    const skill = SKILL_BY_ID[id]
    if (skill) skillUses[id] = skill.uses
  }

  return {
    character: {
      ...character,
      xp,
      level: newLevel,
      maxHp,
      // 레벨업은 완전 회복 — 장기 탐험의 유일한 페이스 조절 장치다.
      hp: maxHp,
      skillUses,
    },
    leveledTo: newLevel,
  }
}

/** 방어도 = 갑옷 기본값 + (민첩 보정, 갑옷 상한 적용) + 버프 */
export function defenseOf(character: Character, buffBonus = 0): number {
  const armor = ARMOR_BY_ID[character.armorId]
  if (!armor) throw new Error(`없는 방어구: ${character.armorId}`)
  const dexMod = abilityModifier(character.abilities.dex)
  const applied = armor.dexCap === null ? dexMod : Math.min(dexMod, armor.dexCap)
  return armor.baseDefense + applied + buffBonus
}

/** 명중 보정 = 무기 능력치 보정 + 숙련 보너스(해당 능력치에 숙련일 때) */
export function attackBonusOf(character: Character): number {
  const weapon = WEAPON_BY_ID[character.weaponId]
  if (!weapon) throw new Error(`없는 무기: ${character.weaponId}`)
  const mod = abilityModifier(character.abilities[weapon.ability])
  const prof = character.proficiencies.includes(weapon.ability)
    ? proficiencyBonus(character.level)
    : 0
  return mod + prof
}

export function skillsOf(character: Character): SkillDef[] {
  return character.skills.map((id) => SKILL_BY_ID[id]).filter(Boolean) as SkillDef[]
}

/** 긴 휴식 — 생명력 전체 회복 + 기술 사용 횟수 초기화 */
export function longRest(character: Character): Character {
  const skillUses: Record<string, number> = {}
  for (const id of character.skills) {
    const skill = SKILL_BY_ID[id]
    if (skill) skillUses[id] = skill.uses
  }
  return { ...character, hp: character.maxHp, skillUses, buffTurns: 0 }
}
