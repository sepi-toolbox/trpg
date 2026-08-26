/**
 * 장비 세부 — 수리, 명품(mastercrafted), 광원 연소, 물체 파괴, 화폐, 과적.
 */
import type { RNG } from './rng'
import { rollDie } from './rng'
import { roll } from './dice'
import type { SkillRollResult } from './roll'
import { rollD20 } from './roll'
import type { Cost, GameData, Weapon } from './types'
import type { Combatant } from './combatant'
import { gatherMods } from './combat'
import { skillLevelOf } from './combatant'

/* ─────────────────────────── 화폐 ─────────────────────────── */

/** 실버 단위로 환산 (1골드 = 10실버 = 100코퍼) */
export function toSilver(cost: Cost): number {
  switch (cost.unit) {
    case 'gold':
      return cost.amount * 10
    case 'silver':
      return cost.amount
    case 'copper':
      return cost.amount / 10
  }
}

/** 실버 총액 → 골드/실버/코퍼 표시 */
export function formatSilver(silver: number): { gold: number; silver: number; copper: number } {
  const totalCopper = Math.round(silver * 10)
  return {
    gold: Math.floor(totalCopper / 100),
    silver: Math.floor((totalCopper % 100) / 10),
    copper: totalCopper % 10,
  }
}

/* ─────────────────────────── 명품 (Mastercrafted) ─────────────────────────── */

/** 명품 무기: 가격 ×10, STR 요구 −3, 내구도 +3 */
export function mastercrafted(weapon: Weapon): Weapon {
  return {
    ...weapon,
    id: `${weapon.id}-mastercrafted`,
    name: `명품 ${weapon.name}`,
    strRequirement: weapon.strRequirement === null ? null : Math.max(0, weapon.strRequirement - 3),
    durability: weapon.durability === null ? null : weapon.durability + 3,
    cost: weapon.cost ? { ...weapon.cost, amount: weapon.cost.amount * 10 } : null,
    supply: 'rare',
  }
}

/* ─────────────────────────── 수리 ─────────────────────────── */

export type RepairRejection = 'not-damaged' | 'no-tools'

/**
 * 파손 무기 수리: 제작(CRAFTING) 판정, 1시프트, 적절한 도구 필요.
 * 성공 시 파손 해제. 실패해도 재시도 가능(시프트 소모 — 시간은 호출부).
 */
export function repairWeapon(
  rng: RNG,
  data: GameData,
  crafter: Combatant,
  weaponId: string,
  hasTools: boolean,
): { crafter: Combatant; result: SkillRollResult; repaired: boolean } | { rejected: RepairRejection } {
  if (!crafter.damagedWeaponIds.includes(weaponId)) return { rejected: 'not-damaged' }
  if (!hasTools) return { rejected: 'no-tools' }

  const mods = gatherMods(data, crafter, 'crafting')
  const result = rollD20(rng, skillLevelOf(crafter, 'crafting'), mods)
  if (!result.success) return { crafter, result, repaired: false }

  return {
    crafter: {
      ...crafter,
      damagedWeaponIds: crafter.damagedWeaponIds.filter((w) => w !== weaponId),
    },
    result,
    repaired: true,
  }
}

/* ─────────────────────────── 광원 ─────────────────────────── */

export interface LightSource {
  itemId: string
  lit: boolean
  /** 남은 연료 (시프트 단위). 횃불·초는 1 */
  fuelShifts: number
}

export function lightSourceFromItem(data: GameData, itemId: string): LightSource {
  const item = data.items.find((i) => i.id === itemId)
  if (!item || item.extinguishDie === null) throw new Error(`광원이 아닙니다: ${itemId}`)
  return { itemId, lit: false, fuelShifts: 1 }
}

/**
 * 스트레치 경과(또는 극적 시점) 꺼짐 판정: 광원별 주사위에서 1이면 꺼진다.
 * 횃불은 무기로 쓸 때도 굴린다 (호출부).
 */
export function extinguishRoll(
  rng: RNG,
  data: GameData,
  source: LightSource,
): { source: LightSource; wentOut: boolean } {
  if (!source.lit) return { source, wentOut: false }
  const item = data.items.find((i) => i.id === source.itemId)
  const die = item?.extinguishDie ?? 6
  const wentOut = rollDie(rng, die) === 1
  return { source: wentOut ? { ...source, lit: false } : source, wentOut }
}

/** 시프트 경과: 연료 소진 */
export function burnShift(source: LightSource): { source: LightSource; wentOut: boolean } {
  if (!source.lit) return { source, wentOut: false }
  const fuelShifts = source.fuelShifts - 1
  if (fuelShifts <= 0) return { source: { ...source, lit: false, fuelShifts: 0 }, wentOut: true }
  return { source: { ...source, fuelShifts }, wentOut: false }
}

/* ─────────────────────────── 물체 파괴 ─────────────────────────── */

/**
 * 무생물(문·자물쇠 등) 공격: 자동 명중, 피해만 굴린다.
 * 물체의 방어 등급을 차감. 도구(지렛대 등)는 파손 위험 없이 고정 주사위.
 */
export function damageObject(
  rng: RNG,
  object: { hp: number; armorRating: number },
  damageNotation: string,
  options: { ignoreArmor?: boolean } = {},
): { object: { hp: number; armorRating: number }; taken: number; destroyed: boolean } {
  const rolled = roll(rng, damageNotation).total
  const taken = Math.max(0, rolled - (options.ignoreArmor ? 0 : object.armorRating))
  const hp = Math.max(0, object.hp - taken)
  return { object: { ...object, hp }, taken, destroyed: hp === 0 }
}

/* ─────────────────────────── 과적 이동 ─────────────────────────── */

/**
 * 과적 상태에서 이동하려면 STR 판정 (전투 라운드 이동·여정 시프트 도보 공통).
 * 실패 → 짐을 버리거나 제자리.
 */
export function overEncumberedMoveRoll(
  rng: RNG,
  data: GameData,
  mover: Combatant,
): SkillRollResult {
  if (mover.attributes === null) return rollD20(rng, 20) // NPC 는 항상 통과 취급
  const mods = gatherMods(data, mover, '') // 스킬 아님 — 능력치 직접 판정
  return rollD20(rng, mover.attributes.str, mods)
}
