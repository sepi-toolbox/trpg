/**
 * 몬스터 — 흉포도 턴, 자동 명중 공격표, 저항/면역, 몬스터 상대 규칙.
 *
 * 원문 핵심:
 *  - 몬스터는 명중을 굴리지 않는다 — 공격표(D6)의 공격이 자동 명중
 *  - 같은 공격 연속 불가: 같은 눈이 두 번 나오면 다음 항목(6→1)
 *  - 흉포도 = 라운드당 선제 카드 수 = 행동 수
 *  - 몬스터의 회피(전부 가능)·패리(무기 소지 시)는 고정 스킬 15,
 *    사용할 때마다 카드 1장(행동 1회) 소모
 *  - 저항 = 방어구 적용 후 절반(올림), 면역 = 무효
 *  - 공포에 면역, 설득 불가(persuadable 예외), 무장 해제·붙잡기 불가,
 *    넘어뜨리기는 EVADE 15 (다리 4개 이상이면 공격자 베인), 어둠 무시
 */
import type { RNG } from './rng'
import { rollDie } from './rng'
import type { RollModifiers, SkillRollResult } from './roll'
import { rollD20, rollOpposed } from './roll'
import type { DamageType, GameData, Monster, MonsterAttack } from './types'
import type { Combatant } from './combatant'
import { gatherMods, type AttackRoll } from './combat'
import { skillLevelOf, weaponOf } from './combatant'

/* ─────────────────────────── 몬스터 전투 상태 ─────────────────────────── */

export interface MonsterCombatant {
  id: string
  monsterId: string
  name: string
  hp: number
  maxHp: number
  /** 자연 방어구 (null = 없음) */
  armor: number | null
  ferocity: number
  /** 이번 라운드 남은 행동(카드) 수 — 회피/패리도 여기서 차감 */
  actionsLeft: number
  /** 직전 공격표 눈 (연속 방지용) */
  lastAttackRoll: number | null
  prone: boolean
  dead: boolean
}

export function monsterOf(data: GameData, monsterId: string): Monster {
  const m = data.monsters.find((x) => x.id === monsterId)
  if (!m) throw new Error(`없는 몬스터: ${monsterId}`)
  return m
}

export function spawnMonster(data: GameData, monsterId: string, uid?: string): MonsterCombatant {
  const def = monsterOf(data, monsterId)
  return {
    id: uid ?? def.id,
    monsterId: def.id,
    name: def.name,
    hp: def.hp,
    maxHp: def.hp,
    armor: def.armor,
    ferocity: def.ferocity,
    actionsLeft: def.ferocity,
    lastAttackRoll: null,
    prone: false,
    dead: false,
  }
}

/** 라운드 시작: 행동 수 재충전 (선제 카드는 combat.drawInitiative 에 ferocity 로 요청) */
export function refreshMonsterRound(m: MonsterCombatant): MonsterCombatant {
  return { ...m, actionsLeft: m.ferocity }
}

/* ─────────────────────────── 공격표 굴림 ─────────────────────────── */

export interface MonsterAttackPick {
  /** 실제 굴린 눈 */
  rolled: number
  /** 연속 방지 조정 후 채택된 눈 */
  chosen: number
  attack: MonsterAttack
}

/**
 * 공격표에서 이번 행동의 공격을 뽑는다.
 * 같은 눈 연속이면 다음 항목(6→1 순환). GM 선택 방식은 chooseAttack 사용.
 */
export function rollMonsterAttack(
  rng: RNG,
  data: GameData,
  monster: MonsterCombatant,
): { monster: MonsterCombatant; pick: MonsterAttackPick } {
  const def = monsterOf(data, monster.monsterId)
  const rolled = rollDie(rng, 6)
  const chosen = rolled === monster.lastAttackRoll ? (rolled % 6) + 1 : rolled
  const attack = def.attacks.find((a) => a.roll === chosen)
  if (!attack) throw new Error(`몬스터 ${def.id} 공격표에 눈 ${chosen} 이 없음`)
  return {
    monster: { ...monster, lastAttackRoll: chosen, actionsLeft: monster.actionsLeft - 1 },
    pick: { rolled, chosen, attack },
  }
}

/** 공격을 직접 선택 (연속 제한은 동일 적용) */
export function chooseMonsterAttack(
  data: GameData,
  monster: MonsterCombatant,
  roll: number,
): { monster: MonsterCombatant; pick: MonsterAttackPick } | { rejected: 'repeat' | 'no-such-attack' } {
  if (roll === monster.lastAttackRoll) return { rejected: 'repeat' }
  const def = monsterOf(data, monster.monsterId)
  const attack = def.attacks.find((a) => a.roll === roll)
  if (!attack) return { rejected: 'no-such-attack' }
  return {
    monster: { ...monster, lastAttackRoll: roll, actionsLeft: monster.actionsLeft - 1 },
    pick: { rolled: roll, chosen: roll, attack },
  }
}

/* ─────────────────────────── 방어측 리액션 (PC가 몬스터 공격을 받을 때) ─────────────────────────── */

export type MonsterAttackReactionRejection =
  | 'cannot-dodge' //  이 공격은 회피 불가
  | 'cannot-parry' //  이 공격은 패리 불가 (기본값)
  | 'already-acted'

/**
 * 몬스터 공격은 자동 명중 — 방어자는 회피(기본 가능)나
 * 패리(공격에 canParry 명시 시)만 시도할 수 있다. 리액션 규칙은 일반 전투와 동일.
 */
export function reactToMonsterAttack(
  rng: RNG,
  data: GameData,
  defender: Combatant,
  attack: MonsterAttack,
  reaction: 'dodge' | 'parry',
  parryWeaponId?: string,
): { result: SkillRollResult; avoided: boolean } | { rejected: MonsterAttackReactionRejection } {
  if (defender.acted) return { rejected: 'already-acted' }

  if (reaction === 'dodge') {
    if (!attack.canDodge) return { rejected: 'cannot-dodge' }
    const mods = gatherMods(data, defender, 'evade')
    const result = rollD20(rng, skillLevelOf(defender, 'evade'), mods)
    return { result, avoided: result.success }
  }

  if (!attack.canParry) return { rejected: 'cannot-parry' }
  const weapon = weaponOf(data, parryWeaponId ?? defender.drawnWeaponIds[0]!)
  const mods = gatherMods(data, defender, weapon.skillId)
  const result = rollD20(rng, skillLevelOf(defender, weapon.skillId), mods)
  return { result, avoided: result.success }
}

/* ─────────────────────────── 몬스터가 받는 피해 ─────────────────────────── */

export interface MonsterDamageResult {
  monster: MonsterCombatant
  /** 면역으로 무효화됨 */
  immune: boolean
  /** 저항으로 절반 적용됨 */
  resisted: boolean
  absorbed: number
  taken: number
}

/**
 * 몬스터 피해 적용: 방어구 차감 → 저항 절반(올림) → 면역 무효.
 * 몬스터는 죽음 판정 없이 0 HP 에서 쓰러진다.
 */
export function applyDamageToMonster(
  data: GameData,
  monster: MonsterCombatant,
  damage: { total: number; damageType: DamageType | null; ignoreArmor: boolean; armorMultiplier?: number },
): MonsterDamageResult {
  const def = monsterOf(data, monster.monsterId)

  if (damage.damageType && def.immunities.includes(damage.damageType)) {
    return { monster, immune: true, resisted: false, absorbed: 0, taken: 0 }
  }

  const rating = damage.ignoreArmor ? 0 : (monster.armor ?? 0) * (damage.armorMultiplier ?? 1)
  let afterArmor = Math.max(0, damage.total - rating)
  const absorbed = damage.total - afterArmor

  let resisted = false
  if (damage.damageType && def.resistances.includes(damage.damageType)) {
    afterArmor = Math.ceil(afterArmor / 2)
    resisted = true
  }

  const hp = Math.max(0, monster.hp - afterArmor)
  return {
    monster: { ...monster, hp, dead: hp === 0 },
    immune: false,
    resisted,
    absorbed,
    taken: afterArmor,
  }
}

/* ─────────────────────────── 몬스터의 회피·패리 ─────────────────────────── */

export type MonsterDefenseRejection = 'no-actions-left' | 'cannot-parry-unarmed'

/**
 * 몬스터가 PC 공격에 리액션: 고정 스킬(defenseSkill, 기본 15) 판정.
 * 성공 시 공격 무효. 행동(카드) 1회 소모. 크리티컬 공격은 용으로만 방어.
 */
export function monsterDefense(
  rng: RNG,
  data: GameData,
  monster: MonsterCombatant,
  attack: Pick<AttackRoll, 'critical'>,
  kind: 'dodge' | 'parry',
  hasWeapon = false,
): { monster: MonsterCombatant; result: SkillRollResult; avoided: boolean } | { rejected: MonsterDefenseRejection } {
  if (monster.actionsLeft <= 0) return { rejected: 'no-actions-left' }
  if (kind === 'parry' && !hasWeapon) return { rejected: 'cannot-parry-unarmed' }

  const def = monsterOf(data, monster.monsterId)
  const result = rollD20(rng, def.defenseSkill)
  const avoided = attack.critical ? result.dragon : result.success

  return {
    monster: { ...monster, actionsLeft: monster.actionsLeft - 1 },
    result,
    avoided,
  }
}

/* ─────────────────────────── 몬스터 상대 특수 규칙 ─────────────────────────── */

export const MONSTER_TOPPLE_EVADE = 15

/**
 * 몬스터 넘어뜨리기: 공격자 무기 스킬 vs 고정 EVADE 15.
 * 다리 4개 이상이면 공격자 베인. toppling 무기 보온은 일반 규칙과 동일.
 */
export function toppleMonster(
  rng: RNG,
  data: GameData,
  attacker: Combatant,
  weaponId: string,
  monster: MonsterCombatant,
  options: { fourOrMoreLegs?: boolean } = {},
): { success: boolean; monster: MonsterCombatant } {
  const weapon = weaponOf(data, weaponId)
  const mods: RollModifiers = {
    boons: weapon.features.includes('toppling') ? 1 : 0,
    banes: options.fourOrMoreLegs ? 1 : 0,
  }
  const opposed = rollOpposed(
    rng,
    skillLevelOf(attacker, weapon.skillId),
    MONSTER_TOPPLE_EVADE,
    gatherMods(data, attacker, weapon.skillId, mods),
  )
  return {
    success: opposed.success,
    monster: opposed.success ? { ...monster, prone: true } : monster,
  }
}

/** 몬스터에게 불가능한 행동 — 게임 루프가 UI에서 막을 때 사용 */
export function monsterInteractionRules(data: GameData, monsterId: string): {
  canDisarm: false
  canGrapple: false
  canShove: false
  immuneToFear: true
  immuneToPoison: true
  persuadable: boolean
  seesInDarkness: true
} {
  const def = monsterOf(data, monsterId)
  return {
    canDisarm: false,
    canGrapple: false,
    canShove: false,
    immuneToFear: true,
    immuneToPoison: true,
    persuadable: def.persuadable,
    seesInDarkness: true,
  }
}

/* ─────────────────────────── 크기 → 봉쇄 면적 ─────────────────────────── */

/** 크기별 봉쇄 면적(한 변 m). small·swarm 은 봉쇄 불가(0) */
export function blockingSize(size: Monster['size']): number {
  switch (size) {
    case 'small':
    case 'swarm':
      return 0
    case 'normal':
      return 2
    case 'large':
      return 4
    case 'huge':
      return 8
  }
}
