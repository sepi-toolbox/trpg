/**
 * 전투 — 선제 카드, 공격 해결(근접/원거리), 리액션(패리/회피), 피해, 죽음 판정.
 *
 * 원문 핵심:
 *  - 선제: 1~10 카드를 라운드마다 무작위 분배. 낮은 수부터 행동
 *  - 턴 = 이동 + 액션 1. 리액션(패리/회피)은 자기 턴을 소모(카드 뒤집기)
 *  - 명중: 무기 스킬 D20 하향. 용 = 크리티컬(3택1), 마 = 빗나감 + 사고표(토글)
 *  - 패리/회피는 명중 후·피해 굴림 전에 선언. 크리티컬은 용을 굴려야만 막을 수 있다
 *  - 피해: 무기 주사위 + 피해 보너스 − 방어구. 근접 피해가 전부 흡수되면
 *    공격 무기가 그 피해를 받는다(내구도)
 *  - 0 HP: 죽음 판정(CON) — 3성공 회복 / 3실패 사망, 용=2성공, 마=2실패.
 *    한 방에 −최대HP 이하로 떨어지면 즉사
 *
 * 이 모듈은 "판정 한 번"을 해결하는 순수 함수들이다.
 * 라운드 루프·타게팅·이동은 게임 루프(10단계)의 몫.
 */
import type { RNG } from './rng'
import { rollDie } from './rng'
import { roll, rollDoubled, rollWithExtraDice, parseDice } from './dice'
import type { RollModifiers, SkillRollResult } from './roll'
import { conditionBanes, rollD20, rollOpposed } from './roll'
import type { DamageType, GameData, RollTableRow, Weapon } from './types'
import type { Combatant } from './combatant'
import {
  armorRating,
  skillLevelOf,
  strRequirementState,
  weaponOf,
} from './combatant'

/* ─────────────────────────── 선제 카드 ─────────────────────────── */

export const INITIATIVE_DECK = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const

export interface InitiativeRequest {
  combatantId: string
  /** 뽑을 카드 수 (흉포도. PC/NPC = 1) */
  cards: number
  /** 기습 성공자: 원하는 카드를 먼저 고른다 */
  choosesCard?: boolean
}

export interface InitiativeAssignment {
  combatantId: string
  cards: number[]
}

/**
 * 라운드 시작 선제 분배.
 * 총 요구 카드가 10을 넘으면 덱을 11, 12… 로 확장한다 (해석 결정 — PLAN.md).
 * choosesCard 참가자는 남은 덱에서 가장 낮은 카드를 받는 것으로 근사한다
 * (실제 선택 UI는 게임 루프에서 — 엔진은 결정론적 기본값 제공).
 */
export function drawInitiative(rng: RNG, requests: InitiativeRequest[]): InitiativeAssignment[] {
  const totalCards = requests.reduce((sum, r) => sum + r.cards, 0)
  const deck: number[] = []
  for (let n = 1; n <= Math.max(10, totalCards); n++) deck.push(n)

  // 셔플 (Fisher–Yates, 시드 RNG)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j]!, deck[i]!]
  }

  const assignments: InitiativeAssignment[] = []
  const remaining = [...deck]

  // 기습 성공자 먼저: 남은 카드 중 최저를 가져간다
  for (const req of requests.filter((r) => r.choosesCard)) {
    const cards: number[] = []
    for (let i = 0; i < req.cards; i++) {
      const best = Math.min(...remaining)
      remaining.splice(remaining.indexOf(best), 1)
      cards.push(best)
    }
    assignments.push({ combatantId: req.combatantId, cards })
  }

  for (const req of requests.filter((r) => !r.choosesCard)) {
    const cards: number[] = []
    for (let i = 0; i < req.cards; i++) cards.push(remaining.shift()!)
    assignments.push({ combatantId: req.combatantId, cards: cards.sort((a, b) => a - b) })
  }

  return assignments
}

/**
 * 대기(카드 교환) 유효성 — 내 카드보다 뒤 순번이고, 아직 행동/대기하지 않은 상대.
 * 교환 자체는 게임 루프가 수행.
 */
export function canSwapInitiative(myCard: number, theirCard: number, theyActed: boolean): boolean {
  return theirCard > myCard && !theyActed
}

/* ─────────────────────────── 판정 보정 집계 ─────────────────────────── */

/**
 * 스킬 판정에 걸리는 베인을 상태이상·장비에서 집계한다.
 * (상황 보정 — 어둠, 조준 방해 등 — 은 호출부가 extra 로 넘긴다)
 */
export function gatherMods(
  data: GameData,
  c: Combatant,
  skillId: string,
  extra: RollModifiers = {},
): RollModifiers {
  let banes = extra.banes ?? 0
  const boons = extra.boons ?? 0

  const skill = data.skills.find((s) => s.id === skillId)
  if (skill) {
    banes += conditionBanes(new Set(c.conditions), skill.attribute)
  }
  // 갑옷·투구 착용 페널티
  for (const id of [c.armorId, c.helmetId]) {
    if (!id) continue
    const piece = data.armor.find((a) => a.id === id)
    if (piece?.baneSkillIds.includes(skillId)) banes += 1
  }
  return { boons, banes }
}

/** 원거리 공격 시 방어구(그레이트 헬름)의 원거리 베인 */
function rangedArmorBanes(data: GameData, c: Combatant): number {
  let banes = 0
  for (const id of [c.armorId, c.helmetId]) {
    if (!id) continue
    const piece = data.armor.find((a) => a.id === id)
    if (piece?.baneRangedAttacks) banes += 1
  }
  return banes
}

/* ─────────────────────────── 공격 (명중 단계) ─────────────────────────── */

export type CriticalChoice =
  | 'doubleDice' //   피해 주사위 2배
  | 'extraAttack' //  다른 적에게 즉시 추가 공격 (자유 액션)
  | 'ignoreArmor' //  방어구 무시 — 관통 피해일 때만 (옵션 룰 damageTypes)

export interface AttackContext {
  kind: 'melee' | 'ranged'
  /** 무기 피해 유형 선택 (복수 유형 무기는 선언) */
  damageType: DamageType | null
  /** 암습: 회피·패리 불가, 보온, subtle 무기면 주사위 +1 */
  sneak?: boolean
  /** 한손 무기를 양손으로 쥠 (STR 요구 -3) */
  twoHandedGrip?: boolean
  /** 상황 보정 (어둠, 장거리, 2m 이내 사격, 엎드린 대상 등) */
  extra?: RollModifiers
}

export interface AttackRoll {
  attackerId: string
  defenderId: string
  weaponId: string
  context: AttackContext
  result: SkillRollResult
  /** 용 — 크리티컬. 패리/회피에 용이 필요 */
  critical: boolean
  /** 마 — 사고표 굴림 결과 (토글 켜졌을 때) */
  mishap: RollTableRow | null
  /** 엎드린 대상 공격 보너스가 적용되는가 (근접 + 대상 prone) */
  proneBonus: boolean
}

export type AttackRejection = 'unusable-weapon' | 'weapon-damaged' | 'not-drawn'

/**
 * 명중 판정. 성공해도 피해는 아직 — 방어측 리액션 선언 후 rollDamage 로 잇는다.
 */
export function rollAttack(
  rng: RNG,
  data: GameData,
  attacker: Combatant,
  weaponId: string,
  defender: { id: string; prone: boolean },
  context: AttackContext,
): AttackRoll | { rejected: AttackRejection } {
  if (!attacker.drawnWeaponIds.includes(weaponId)) return { rejected: 'not-drawn' }
  if (attacker.damagedWeaponIds.includes(weaponId)) return { rejected: 'weapon-damaged' }

  const weapon = weaponOf(data, weaponId)
  const strState = strRequirementState(data, attacker, weaponId, context.twoHandedGrip)
  if (strState === 'unusable') return { rejected: 'unusable-weapon' }

  const extra: RollModifiers = { ...(context.extra ?? {}) }
  let banes = extra.banes ?? 0
  let boons = extra.boons ?? 0

  if (strState === 'bane') banes += 1
  if (context.kind === 'ranged') banes += rangedArmorBanes(data, attacker)
  if (context.sneak) boons += 1
  // 엎드린 대상에 대한 근접 공격: 보온 + 피해 D6 추가
  const proneBonus = context.kind === 'melee' && defender.prone
  if (proneBonus) boons += 1

  const mods = gatherMods(data, attacker, weapon.skillId, { boons, banes })
  const result = rollD20(rng, skillLevelOf(attacker, weapon.skillId), mods)

  let mishap: RollTableRow | null = null
  if (result.demon && data.config.mishapTables) {
    const tableId = context.kind === 'melee' ? 'melee-mishap' : 'ranged-mishap'
    const table = data.tables.find((t) => t.id === tableId)
    if (table) {
      const eye = rollDie(rng, table.die)
      mishap = table.rows.find((r) => eye >= r.min && eye <= r.max) ?? null
    }
  }

  return {
    attackerId: attacker.id,
    defenderId: defender.id,
    weaponId,
    context,
    result,
    critical: result.dragon,
    mishap,
    proneBonus,
  }
}

/* ─────────────────────────── 리액션 (패리/회피) ─────────────────────────── */

export type ReactionRejection =
  | 'already-acted' //  이번 라운드 턴 소모됨
  | 'sneak-attack' //   암습은 리액션 불가
  | 'shield-required' // 원거리 패리는 방패 필요
  | 'weapon-damaged'
  | 'not-drawn'
  | 'no-parry-weapon' // 플레일 등 패리 불가 무기
  | 'unarmed' //        맨손 패리 불가

/** 방패 패리에 쓸 수 있는 스킬: STR 기반 근접 무기 스킬 (KNIVES·STAVES 제외 규칙을 데이터로 판별) */
function shieldParrySkill(data: GameData, c: Combatant): string {
  const candidates = data.skills.filter(
    (s) => s.kind === 'weapon' && s.attribute === 'str',
  )
  // 보유 레벨이 가장 높은 스킬 사용
  let best = candidates[0]!.id
  for (const s of candidates) {
    if (skillLevelOf(c, s.id) > skillLevelOf(c, best)) best = s.id
  }
  return best
}

export interface ParryOutcome {
  result: SkillRollResult
  parried: boolean
  /** 용 패리 — 즉시 반격 (자동 명중, 회피·패리 불가). 원거리 패리에는 없음 */
  counterattack: boolean
  /** 패리 성공 시 피해가 내구도를 넘으면 무기 파손 */
  weaponId: string
}

/**
 * 패리 시도. 성공 시 피해 0 — 단, 피해가 내구도를 넘으면 무기 파손(checkDurability).
 * 크리티컬 공격은 용을 굴려야만 패리된다.
 */
export function tryParry(
  rng: RNG,
  data: GameData,
  defender: Combatant,
  attack: AttackRoll,
  parryWeaponId: string,
): ParryOutcome | { rejected: ReactionRejection } {
  if (defender.acted) return { rejected: 'already-acted' }
  if (attack.context.sneak) return { rejected: 'sneak-attack' }
  if (!defender.drawnWeaponIds.includes(parryWeaponId)) return { rejected: 'not-drawn' }
  if (defender.damagedWeaponIds.includes(parryWeaponId)) return { rejected: 'weapon-damaged' }

  const weapon = weaponOf(data, parryWeaponId)
  if (weapon.features.includes('noParry')) return { rejected: 'no-parry-weapon' }
  if (weapon.features.includes('unarmed')) return { rejected: 'unarmed' }
  if (attack.context.kind === 'ranged' && weapon.category !== 'shield') {
    return { rejected: 'shield-required' }
  }

  const skillId =
    weapon.category === 'shield' ? shieldParrySkill(data, defender) : weapon.skillId

  const strState = strRequirementState(data, defender, parryWeaponId)
  const extra: RollModifiers = { banes: strState === 'bane' ? 1 : 0 }
  const mods = gatherMods(data, defender, skillId, extra)
  const result = rollD20(rng, skillLevelOf(defender, skillId), mods)

  // 크리티컬은 용으로만 막는다
  const parried = attack.critical ? result.dragon : result.success

  // 용 패리 = 반격. 단 공격자도 용이면(크리티컬) 반격 없음. 원거리 공격도 없음.
  const counterattack =
    parried && result.dragon && !attack.critical && attack.context.kind === 'melee'

  return { result, parried, counterattack, weaponId: parryWeaponId }
}

export interface DodgeOutcome {
  result: SkillRollResult
  dodged: boolean
}

/** 회피 시도 (EVADE). 성공 시 피해 0 + 2m 이동 가능(이동은 게임 루프). */
export function tryDodge(
  rng: RNG,
  data: GameData,
  defender: Combatant,
  attack: AttackRoll,
): DodgeOutcome | { rejected: ReactionRejection } {
  if (defender.acted) return { rejected: 'already-acted' }
  if (attack.context.sneak) return { rejected: 'sneak-attack' }

  const mods = gatherMods(data, defender, 'evade')
  const result = rollD20(rng, skillLevelOf(defender, 'evade'), mods)
  const dodged = attack.critical ? result.dragon : result.success
  return { result, dodged }
}

/* ─────────────────────────── 피해 ─────────────────────────── */

export interface DamageRoll {
  /** 방어구 차감 전 총 피해 */
  total: number
  weaponDice: number[]
  bonusDice: number[]
  ignoreArmor: boolean
  damageType: DamageType | null
  breakdown: string
}

/**
 * 피해 굴림.
 *  - 무기 주사위 (+암습 subtle 시 +1개, 엎드린 대상 +D6)
 *  - 크리티컬 doubleDice: 무기 주사위만 2배 (보너스 제외)
 *  - 피해 보너스: 무기 스킬의 능력치(STR/AGL) 기준. noDamageBonus 무기는 없음
 */
export function rollDamage(
  rng: RNG,
  data: GameData,
  attacker: Combatant,
  attack: AttackRoll,
  criticalChoice: CriticalChoice | null,
): DamageRoll {
  const weapon = weaponOf(data, attack.weaponId)
  const subtleSneak = attack.context.sneak && weapon.features.includes('subtle')

  let weaponResult
  if (criticalChoice === 'doubleDice') {
    weaponResult = subtleSneak
      ? // 2배와 암습 +1 이 겹치면: (개수+1)×2 가 아니라 개수×2 +1 로 처리 (잠정 해석)
        rollWithExtraDice(rng, doubledNotation(weapon), 1)
      : rollDoubled(rng, weapon.damage)
  } else {
    weaponResult = rollWithExtraDice(rng, weapon.damage, subtleSneak ? 1 : 0)
  }

  const bonusDice: number[] = []
  let bonusTotal = 0

  if (!weapon.features.includes('noDamageBonus')) {
    const skill = data.skills.find((s) => s.id === weapon.skillId)
    const bonus = skill?.attribute === 'agl' ? attacker.damageBonusAgl : attacker.damageBonusStr
    if (bonus) {
      const r = roll(rng, bonus)
      bonusDice.push(...r.rolls)
      bonusTotal += r.total
    }
  }

  if (attack.proneBonus) {
    const r = roll(rng, 'D6')
    bonusDice.push(...r.rolls)
    bonusTotal += r.total
  }

  const ignoreArmor =
    criticalChoice === 'ignoreArmor' &&
    data.config.damageTypes &&
    attack.context.damageType === 'piercing'

  return {
    total: weaponResult.total + bonusTotal,
    weaponDice: weaponResult.rolls,
    bonusDice,
    ignoreArmor,
    damageType: attack.context.damageType,
    breakdown: `${weaponResult.rolls.join('+')}${weaponResult.modifier ? `+${weaponResult.modifier}` : ''}${bonusDice.length ? ` + 보너스 ${bonusDice.join('+')}` : ''}`,
  }
}

function doubledNotation(weapon: Weapon): string {
  const spec = parseDice(weapon.damage)
  return `${spec.count * 2}D${spec.sides}${spec.modifier ? (spec.modifier > 0 ? `+${spec.modifier}` : spec.modifier) : ''}`
}

export interface DamageApplication {
  defender: Combatant
  /** 방어구가 흡수한 양 */
  absorbed: number
  /** 실제로 깎인 HP */
  taken: number
  /** 근접 피해 전부 흡수 → 공격 무기가 받는 피해 (내구도 검사용) */
  reflectedToWeapon: number
  droppedToZero: boolean
  instantDeath: boolean
}

/**
 * 피해 적용.
 *  - 방어구 차감 (ignoreArmor 시 무시)
 *  - HP 0 도달: 쓰러짐 + 죽음 판정 시작 (음수 기록 없음)
 *  - 한 방에 −최대HP 이하: 즉사
 *  - 0 HP 상태에서 추가 피해: 죽음 판정 실패 1회 (호출부에서 applyDamage 결과로 처리)
 */
export function applyDamage(
  data: GameData,
  defender: Combatant,
  damage: DamageRoll,
  options: { melee: boolean },
): DamageApplication {
  const rating = damage.ignoreArmor ? 0 : armorRating(data, defender, damage.damageType)
  const afterArmor = Math.max(0, damage.total - rating)
  const absorbed = damage.total - afterArmor

  // 근접 피해가 전부 흡수되면 공격 무기가 피해를 받는다 (관통 제외 — 내구도 검사에서)
  const reflectedToWeapon = options.melee && afterArmor === 0 ? damage.total : 0

  const wasZero = defender.hp === 0
  const newHp = Math.max(0, defender.hp - afterArmor)
  const droppedToZero = !wasZero && newHp === 0 && afterArmor > 0

  // 즉사: 한 번의 공격으로 음수 최대HP 에 도달
  const overkill = afterArmor - defender.hp
  const instantDeath = overkill >= defender.maxHp

  let deathRolls = defender.deathRolls
  if (droppedToZero && !instantDeath) deathRolls = { successes: 0, failures: 0 }
  // 0 HP 에서 추가 피해 = 죽음 판정 실패 1회
  if (wasZero && afterArmor > 0 && deathRolls) {
    deathRolls = { ...deathRolls, failures: deathRolls.failures + 1 }
  }

  const dead =
    instantDeath ||
    (defender.kind === 'npc' && newHp === 0) || // 미니언·NPC 는 0 HP 즉시 무력화(생사는 GM — 여기선 사망 처리)
    (deathRolls !== null && deathRolls.failures >= 3)

  return {
    defender: {
      ...defender,
      hp: newHp,
      prone: newHp === 0 ? true : defender.prone,
      deathRolls: dead ? null : deathRolls,
      dead,
    },
    absorbed,
    taken: afterArmor,
    reflectedToWeapon,
    droppedToZero,
    instantDeath,
  }
}

/**
 * 패리 성공 시 내구도 검사: 피해가 내구도를 넘으면 무기 파손.
 * 관통 피해는 패리 무기를 파손시키지 않는다.
 */
export function checkParryDurability(
  data: GameData,
  defender: Combatant,
  weaponId: string,
  damage: DamageRoll,
): { defender: Combatant; broken: boolean } {
  const weapon = weaponOf(data, weaponId)
  if (damage.damageType === 'piercing' && data.config.damageTypes) {
    return { defender, broken: false }
  }
  if (weapon.durability === null || damage.total <= weapon.durability) {
    return { defender, broken: false }
  }
  return {
    defender: { ...defender, damagedWeaponIds: [...defender.damagedWeaponIds, weaponId] },
    broken: true,
  }
}

/** 완전 흡수로 무기에 반사된 피해의 내구도 검사 (공격자 무기) */
export function checkAttackerWeaponDurability(
  data: GameData,
  attacker: Combatant,
  weaponId: string,
  reflected: number,
): { attacker: Combatant; broken: boolean } {
  const weapon = weaponOf(data, weaponId)
  if (weapon.durability === null || reflected <= weapon.durability) {
    return { attacker, broken: false }
  }
  return {
    attacker: { ...attacker, damagedWeaponIds: [...attacker.damagedWeaponIds, weaponId] },
    broken: true,
  }
}

/* ─────────────────────────── 거리·사거리 ─────────────────────────── */

/** 근접 간격: 기본 2m, long 무기는 4m */
export function weaponReach(weapon: Weapon): number {
  return weapon.features.includes('long') ? 4 : 2
}

/**
 * 원거리 유효 사거리(m). 투척 무기는 STR 기반 ("STR" | "STRx2").
 * 유효 사거리의 2배까지는 베인을 받고 쏠 수 있다. 근접 전용 무기는 null.
 */
export function effectiveRange(weapon: Weapon, strScore: number | null): number | null {
  const isRangedUse = weapon.category === 'ranged' || weapon.features.includes('thrown')
  if (!isRangedUse) return null
  if (typeof weapon.range === 'number') return weapon.range
  if (weapon.range === 'STR') return strScore ?? 10
  if (weapon.range === 'STRx2') return (strScore ?? 10) * 2
  return null
}

/**
 * 원거리 공격 거리 판정.
 *  - 2m 이내: 사격 가능하나 베인
 *  - 유효 사거리 이내: 정상
 *  - 유효 사거리 ×2 이내: 베인
 *  - 그 밖: 불가
 */
export function rangedDistanceState(
  weapon: Weapon,
  strScore: number | null,
  distance: number,
): 'point-blank' | 'normal' | 'long' | 'out-of-range' {
  const range = effectiveRange(weapon, strScore)
  if (range === null || distance > range * 2) return 'out-of-range'
  if (distance <= 2) return 'point-blank'
  if (distance <= range) return 'normal'
  return 'long'
}

/* ─────────────────────────── 특수 공격 (옵션 룰) ─────────────────────────── */

export type SpecialAttackKind = 'topple' | 'disarm' | 'grapple' | 'findWeakSpot'

/**
 * 넘어뜨리기: 내 무기 스킬 vs 상대 EVADE 대결. toppling 무기면 보온.
 * 회피·패리 불가. 성공 시 상대 prone.
 */
export function trySpecialTopple(
  rng: RNG,
  data: GameData,
  attacker: Combatant,
  weaponId: string,
  defender: Combatant,
): { success: boolean; defender: Combatant } {
  const weapon = weaponOf(data, weaponId)
  const boons = weapon.features.includes('toppling') ? 1 : 0
  const activeMods = gatherMods(data, attacker, weapon.skillId, { boons })
  const opposed = rollOpposed(
    rng,
    skillLevelOf(attacker, weapon.skillId),
    skillLevelOf(defender, 'evade'),
    activeMods,
    gatherMods(data, defender, 'evade'),
  )
  return {
    success: opposed.success,
    defender: opposed.success ? { ...defender, prone: true } : defender,
  }
}

/**
 * 무장 해제: 내 무기 스킬 vs 상대 무기 스킬. 상대가 양손으로 들면 베인.
 * 방패·자연 무기 불가. 성공 시 무기가 D6m 날아간다(위치는 게임 루프).
 */
export function trySpecialDisarm(
  rng: RNG,
  data: GameData,
  attacker: Combatant,
  weaponId: string,
  defender: Combatant,
  targetWeaponId: string,
): { success: boolean; defender: Combatant; distance: number | null; rejected?: string } {
  const target = weaponOf(data, targetWeaponId)
  if (target.category === 'shield') {
    return { success: false, defender, distance: null, rejected: '방패는 무장 해제 불가' }
  }
  if (target.features.includes('unarmed')) {
    return { success: false, defender, distance: null, rejected: '자연 무기는 무장 해제 불가' }
  }

  const weapon = weaponOf(data, weaponId)
  const banes = target.grip === '2H' ? 1 : 0
  const opposed = rollOpposed(
    rng,
    skillLevelOf(attacker, weapon.skillId),
    skillLevelOf(defender, target.skillId),
    gatherMods(data, attacker, weapon.skillId, { banes }),
    gatherMods(data, defender, target.skillId),
  )
  if (!opposed.success) return { success: false, defender, distance: null }

  return {
    success: true,
    defender: {
      ...defender,
      drawnWeaponIds: defender.drawnWeaponIds.filter((w) => w !== targetWeaponId),
      weaponsAtHand: defender.weaponsAtHand.filter((w) => w !== targetWeaponId),
    },
    distance: rollDie(rng, 6),
  }
}

/**
 * 붙잡기: 인간형 상대에게 격투(BRAWLING) 대결. 회피·패리 불가.
 *  - 실패: 내가 넘어진다
 *  - 성공: 둘 다 넘어지고 상대는 붙잡힘 — 상대는 벗어나기(격투 대결, 상대에겐 자유 행동)만 가능
 *  - 붙잡은 쪽은 조르기(보온 맨손 공격, 회피·패리 불가)와 놓아주기(자유)만 가능
 * 몬스터는 붙잡을 수 없다 (원문 — 호출부에서 거부).
 */
export function trySpecialGrapple(
  rng: RNG,
  data: GameData,
  attacker: Combatant,
  defender: Combatant,
): { success: boolean; attacker: Combatant; defender: Combatant } {
  const opposed = rollOpposed(
    rng,
    skillLevelOf(attacker, 'brawling'),
    skillLevelOf(defender, 'brawling'),
    gatherMods(data, attacker, 'brawling'),
    gatherMods(data, defender, 'brawling'),
  )
  if (!opposed.success) {
    return { success: false, attacker: { ...attacker, prone: true }, defender }
  }
  return {
    success: true,
    attacker: { ...attacker, prone: true },
    defender: { ...defender, prone: true },
  }
}

/** 붙잡힌 쪽의 벗어나기 — 격투 대결 (벗어나는 쪽 기준 판정, 성공 시 풀려남) */
export function tryBreakFree(
  rng: RNG,
  data: GameData,
  grappled: Combatant,
  grappler: Combatant,
): { freed: boolean } {
  const opposed = rollOpposed(
    rng,
    skillLevelOf(grappled, 'brawling'),
    skillLevelOf(grappler, 'brawling'),
    gatherMods(data, grappled, 'brawling'),
    gatherMods(data, grappler, 'brawling'),
  )
  return { freed: opposed.success }
}

/**
 * 약점 찌르기: 관통 무기로 베인을 받고 공격 — 명중 시 방어구 무시.
 * rollAttack 을 context.extra.banes+1 로 부르고, 피해에 ignoreArmor 를 세팅하는
 * 헬퍼. (옵션 룰 specialAttacks + damageTypes)
 */
export function findWeakSpotContext(base: AttackContext): AttackContext {
  return {
    ...base,
    damageType: 'piercing',
    extra: { ...(base.extra ?? {}), banes: (base.extra?.banes ?? 0) + 1 },
  }
}

/* ─────────────────────────── 죽음 판정 ─────────────────────────── */

export interface DeathRollResult {
  combatant: Combatant
  roll: SkillRollResult
  /** 이번 굴림으로 더해진 성공/실패 수 */
  successesAdded: number
  failuresAdded: number
  recovered: boolean
  died: boolean
  recoveredHp: number
}

/**
 * 죽음 판정 (자기 턴마다, CON 하향).
 * 용 = 성공 2회, 마 = 실패 2회. 3성공 → D6 HP 회복, 3실패 → 사망.
 * 푸쉬 불가 (호출부에서도 금지).
 */
export function deathRoll(rng: RNG, combatant: Combatant): DeathRollResult {
  if (!combatant.deathRolls || combatant.attributes === null) {
    throw new Error('죽음 판정 상태가 아닙니다')
  }

  const result = rollD20(rng, combatant.attributes.con)
  const successesAdded = result.dragon ? 2 : result.success ? 1 : 0
  const failuresAdded = result.demon ? 2 : result.success ? 0 : 1

  const successes = combatant.deathRolls.successes + successesAdded
  const failures = combatant.deathRolls.failures + failuresAdded

  if (failures >= 3) {
    return {
      combatant: { ...combatant, dead: true, deathRolls: null },
      roll: result,
      successesAdded,
      failuresAdded,
      recovered: false,
      died: true,
      recoveredHp: 0,
    }
  }
  if (successes >= 3) {
    const hp = rollDie(rng, 6)
    return {
      combatant: { ...combatant, hp, deathRolls: null },
      roll: result,
      successesAdded,
      failuresAdded,
      recovered: true,
      died: false,
      recoveredHp: hp,
    }
  }
  return {
    combatant: { ...combatant, deathRolls: { successes, failures } },
    roll: result,
    successesAdded,
    failuresAdded,
    recovered: false,
    died: false,
    recoveredHp: 0,
  }
}

/**
 * 소생 (치료 스킬, 액션): 0 HP 대상 옆에서. 붕대 없으면 베인.
 * 성공 → 죽음 판정 중단 + D6 HP. 자기 자신에게는 불가(호출부 검증).
 */
export function trySaveLife(
  rng: RNG,
  data: GameData,
  healer: Combatant,
  target: Combatant,
  hasBandages: boolean,
): { healer: Combatant; target: Combatant; result: SkillRollResult; saved: boolean } {
  const mods = gatherMods(data, healer, 'healing', { banes: hasBandages ? 0 : 1 })
  const result = rollD20(rng, skillLevelOf(healer, 'healing'), mods)
  if (!result.success || target.hp > 0 || target.dead) {
    return { healer, target, result, saved: false }
  }
  return {
    healer,
    target: { ...target, hp: rollDie(rng, 6), deathRolls: null },
    result,
    saved: true,
  }
}
