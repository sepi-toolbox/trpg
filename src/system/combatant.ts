/**
 * 전투 참가자 — PC/NPC 를 전투 엔진이 다루는 공통 형태로 어댑팅한다.
 * (몬스터는 7단계에서 이 모듈을 확장)
 */
import type { GameData, AttributeId, ConditionId, Weapon } from './types'
import type { Character } from './character'
import { damageBonus, maxHp } from './character'

export interface Combatant {
  id: string
  name: string
  side: 'party' | 'enemy'
  kind: 'pc' | 'npc'
  hp: number
  maxHp: number
  /** NPC 미니언은 null (WP 미사용) */
  wp: number | null
  conditions: ConditionId[]
  /** 스킬 id → 레벨. NPC는 기재된 것만 — 없는 스킬은 기본치 5 */
  skills: Record<string, number>
  /** PC만 보유. NPC 능력치 판정은 규칙상 발생하지 않거나 GM 재량 */
  attributes: Record<AttributeId, number> | null
  /** STR/AGL 피해 보너스 주사위 (null = 없음) */
  damageBonusStr: string | null
  damageBonusAgl: string | null
  weaponsAtHand: string[]
  /** 현재 뽑아 든 무기 (최대 2, 양손 무기면 1) */
  drawnWeaponIds: string[]
  armorId: string | null
  helmetId: string | null
  prone: boolean
  /** 이번 라운드 선제 카드 (없으면 null) */
  card: number | null
  /** 이번 라운드에 턴을 소모했는가 (카드 뒤집힘 — 리액션 불가) */
  acted: boolean
  /** 파손된 무기 id */
  damagedWeaponIds: string[]
  /** 죽음 판정 진행 상태 (0 HP 일 때만) */
  deathRolls: { successes: number; failures: number } | null
  dead: boolean
  /** 동물 등 자연 무기 하나로 싸우는 참가자 (무기 대신 사용) */
  naturalAttack?: { skillLevel: number; damage: string; name: string } | null
  /** 라운드당 이동력 (미기재 시 게임 루프 기본값) */
  movement?: number
  /** 보유 능력의 패시브 마커 훅 목록 (parryRangedWithMelee 등) */
  abilityHooks?: string[]
}

/** NPC 미기재 스킬 기본치 */
export const NPC_DEFAULT_SKILL = 5
/** 몬스터(및 규칙상 고정치) 회피·패리 기본치 — 7단계에서 사용 */
export const MONSTER_DEFENSE_SKILL = 15

export function skillLevelOf(c: Combatant, skillId: string): number {
  return c.skills[skillId] ?? (c.kind === 'pc' ? 0 : NPC_DEFAULT_SKILL)
}

export function combatantFromCharacter(data: GameData, character: Character): Combatant {
  // 손에 든 무기가 하나도 없으면 맨손(격투)으로 싸운다
  const atHand = character.weaponsAtHand.length > 0 ? [...character.weaponsAtHand] : ['unarmed']
  const abilityHooks = Object.keys(character.abilities).flatMap((id) =>
    (data.abilities.find((a) => a.id === id)?.effects ?? []).map((e) => e.hook as string),
  )
  return {
    id: 'pc',
    name: character.name,
    side: 'party',
    kind: 'pc',
    hp: character.hp,
    maxHp: maxHp(data, character),
    wp: character.wp,
    conditions: [...character.conditions],
    skills: { ...character.skillLevels },
    attributes: { ...character.attributes },
    damageBonusStr: damageBonus(data, character.attributes.str),
    damageBonusAgl: damageBonus(data, character.attributes.agl),
    weaponsAtHand: atHand,
    drawnWeaponIds: atHand.slice(0, 1),
    armorId: character.armorId,
    helmetId: character.helmetId,
    prone: false,
    card: null,
    acted: false,
    damagedWeaponIds: [],
    deathRolls: null,
    dead: false,
    abilityHooks,
  }
}

export function combatantFromNpc(data: GameData, npcId: string, uid?: string): Combatant {
  const npc = data.npcs.find((n) => n.id === npcId)
  if (!npc) throw new Error(`없는 NPC: ${npcId}`)

  const weaponIds = npc.gearIds.filter((g) => data.weapons.some((w) => w.id === g))
  const armorId = npc.gearIds.find((g) =>
    data.armor.some((a) => a.id === g && a.kind === 'armor'),
  )
  const helmetId = npc.gearIds.find((g) =>
    data.armor.some((a) => a.id === g && a.kind === 'helmet'),
  )

  let hp = npc.hp
  let wp = npc.wp
  // 보스의 강골/집중 스택 반영
  for (const { abilityId, count } of npc.heroicAbilities) {
    const ability = data.abilities.find((a) => a.id === abilityId)
    for (const e of ability?.effects ?? []) {
      if (e.hook === 'maxHpBonus') hp += (Number(e.params?.['amount']) || 0) * count
      if (e.hook === 'maxWpBonus' && wp !== null) wp += (Number(e.params?.['amount']) || 0) * count
    }
  }

  return {
    id: uid ?? npc.id,
    name: npc.name,
    side: 'enemy',
    kind: 'npc',
    hp,
    maxHp: hp,
    wp,
    conditions: [],
    skills: { ...npc.skills },
    attributes: null,
    damageBonusStr: npc.damageBonus.str ?? null,
    damageBonusAgl: npc.damageBonus.agl ?? null,
    weaponsAtHand: weaponIds.slice(0, 3),
    drawnWeaponIds: weaponIds.slice(0, 1),
    armorId: armorId ?? null,
    helmetId: helmetId ?? null,
    prone: false,
    card: null,
    acted: false,
    damagedWeaponIds: [],
    deathRolls: null,
    dead: false,
  }
}

/** 동물 → 전투 참가자. 자연 무기(naturalAttack) 하나로 싸운다. */
export function combatantFromAnimal(data: GameData, animalId: string, uid?: string): Combatant {
  const animal = data.animals.find((a) => a.id === animalId)
  if (!animal) throw new Error(`없는 동물: ${animalId}`)
  return {
    id: uid ?? animal.id,
    name: animal.name,
    side: 'enemy',
    kind: 'npc',
    hp: animal.hp,
    maxHp: animal.hp,
    wp: null,
    conditions: [],
    skills: { ...animal.skills },
    attributes: null,
    damageBonusStr: null,
    damageBonusAgl: null,
    weaponsAtHand: [],
    drawnWeaponIds: [],
    armorId: null,
    helmetId: null,
    prone: false,
    card: null,
    acted: false,
    damagedWeaponIds: [],
    deathRolls: null,
    dead: false,
    naturalAttack: { skillLevel: animal.attack.skillLevel, damage: animal.attack.damage, name: animal.name },
    movement: animal.movement,
  }
}

export function weaponOf(data: GameData, weaponId: string): Weapon {
  const w = data.weapons.find((x) => x.id === weaponId)
  if (!w) throw new Error(`없는 무기: ${weaponId}`)
  return w
}

/**
 * 유효 방어구 등급 = 갑옷 + 투구 (+피해 유형 보정, 옵션 룰).
 */
export function armorRating(
  data: GameData,
  c: Combatant,
  damageType: 'slashing' | 'piercing' | 'bludgeoning' | null,
): number {
  let total = 0
  for (const id of [c.armorId, c.helmetId]) {
    if (!id) continue
    const piece = data.armor.find((a) => a.id === id)
    if (!piece) continue
    total += piece.rating
    if (data.config.damageTypes && damageType) {
      total += piece.typeModifiers[damageType] ?? 0
    }
  }
  return total
}

/**
 * 무기 STR 요구 검사.
 * - 미달: 공격·패리에 베인
 * - 절반 미만: 사용 불가
 * - 한손 무기를 양손으로 쥐면 요구 -3
 * NPC 는 능력치가 없으므로 항상 충족으로 본다.
 */
export function strRequirementState(
  data: GameData,
  c: Combatant,
  weaponId: string,
  twoHandedGrip = false,
): 'ok' | 'bane' | 'unusable' {
  const weapon = weaponOf(data, weaponId)
  if (weapon.strRequirement === null || c.attributes === null) return 'ok'
  const requirement =
    twoHandedGrip && weapon.grip === '1H' ? weapon.strRequirement - 3 : weapon.strRequirement
  const str = c.attributes.str
  if (str < requirement / 2) return 'unusable'
  if (str < requirement) return 'bane'
  return 'ok'
}
