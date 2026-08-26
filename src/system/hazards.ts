/**
 * 상태이상 관리 · 휴식 · 위험 요소 (공포, 독, 질병, 낙하, 익사, 굶주림, 추위, 수면 부족).
 *
 * 이 모듈은 캐릭터의 생명 자원(HP/WP/상태이상)에 작용하는 규칙을 다룬다.
 * 전투 밖 상태를 다루므로 Character 의 부분집합(Vitals)에 대해 동작한다 —
 * 전투 중이면 게임 루프가 Combatant ↔ Character 를 동기화한다.
 */
import type { RNG } from './rng'
import { rollDie } from './rng'
import { roll } from './dice'
import type { SkillRollResult } from './roll'
import { conditionBanes, rollD20, rollOpenOpposed } from './roll'
import type {
  AttributeId,
  ConditionId,
  GameData,
  RollTableRow,
} from './types'

/** HP/WP/상태이상/능력치 — Character 가 이 형태를 만족한다 */
export interface Vitals {
  hp: number
  wp: number
  conditions: ConditionId[]
  attributes: Record<AttributeId, number>
}

export const ALL_CONDITIONS: ConditionId[] = [
  'exhausted', 'sickly', 'dazed', 'angry', 'scared', 'disheartened',
]

/* ─────────────────────────── 상태이상 부여/해소 ─────────────────────────── */

export interface SufferConditionResult<T extends Vitals> {
  vitals: T
  /** 실제로 부여된 상태이상 (오버플로면 null) */
  gained: ConditionId | null
  /** 6종을 다 가진 상태에서 추가로 받으면 D6 WP, WP 없으면 D6 HP 상실 */
  overflow: { wpLost: number; hpLost: number } | null
}

/**
 * 상태이상 부여.
 * 이미 가진 것을 받으면 다른 것을 골라야 한다(chosen 이 그 선택).
 * 6종을 다 가졌으면 대신 D6 WP 상실, WP 도 없으면 D6 HP 상실.
 */
export function sufferCondition<T extends Vitals>(
  rng: RNG,
  vitals: T,
  condition: ConditionId,
  fallbackChoice?: ConditionId,
): SufferConditionResult<T> {
  const has = new Set(vitals.conditions)

  if (has.size >= 6) {
    if (vitals.wp > 0) {
      const lost = Math.min(vitals.wp, rollDie(rng, 6))
      return { vitals: { ...vitals, wp: vitals.wp - lost }, gained: null, overflow: { wpLost: lost, hpLost: 0 } }
    }
    const lost = Math.min(vitals.hp, rollDie(rng, 6))
    return { vitals: { ...vitals, hp: vitals.hp - lost }, gained: null, overflow: { wpLost: 0, hpLost: lost } }
  }

  let toGain = condition
  if (has.has(toGain)) {
    // 이미 가진 상태이상 → 다른 것 선택 (미지정 시 목록 순서에서 첫 미보유)
    toGain =
      fallbackChoice && !has.has(fallbackChoice)
        ? fallbackChoice
        : ALL_CONDITIONS.find((c) => !has.has(c))!
  }

  return {
    vitals: { ...vitals, conditions: [...vitals.conditions, toGain] },
    gained: toGain,
    overflow: null,
  }
}

/** 상태이상 해소. 'all' 또는 선택 목록. */
export function healConditions<T extends Vitals>(
  vitals: T,
  which: 'all' | ConditionId[],
): T {
  if (which === 'all') return { ...vitals, conditions: [] }
  return { ...vitals, conditions: vitals.conditions.filter((c) => !which.includes(c)) }
}

/* ─────────────────────────── 휴식 ─────────────────────────── */

export interface RestUsage {
  /** 이번 시프트에 라운드 휴식을 썼는가 */
  roundRestUsed: boolean
  /** 이번 시프트에 스트레치 휴식을 썼는가 */
  stretchRestUsed: boolean
}

export const FRESH_REST_USAGE: RestUsage = { roundRestUsed: false, stretchRestUsed: false }

export interface RestResult<T extends Vitals> {
  vitals: T
  usage: RestUsage
  hpHealed: number
  wpHealed: number
  conditionsHealed: ConditionId[]
  rejected?: 'already-used-this-shift'
}

function clampHeal(current: number, max: number, amount: number): number {
  return Math.min(max - current, Math.max(0, amount))
}

/** 라운드 휴식: D6 WP. 시프트당 1회. */
export function roundRest<T extends Vitals>(
  rng: RNG,
  vitals: T,
  maxWp: number,
  usage: RestUsage,
): RestResult<T> {
  if (usage.roundRestUsed) {
    return { vitals, usage, hpHealed: 0, wpHealed: 0, conditionsHealed: [], rejected: 'already-used-this-shift' }
  }
  const healed = clampHeal(vitals.wp, maxWp, rollDie(rng, 6))
  return {
    vitals: { ...vitals, wp: vitals.wp + healed },
    usage: { ...usage, roundRestUsed: true },
    hpHealed: 0,
    wpHealed: healed,
    conditionsHealed: [],
  }
}

export interface StretchRestOptions {
  /** 간호인의 치료 판정 성공 → HP 회복이 2D6 (간호인은 이 스트레치에 쉬지 못함) */
  caregiverSuccess?: boolean
  /** 해소할 상태이상 (1개 선택) */
  healCondition?: ConditionId
  /** 능력 보정 (별지기 깊은 명상 등): 추가 HP/WP 주사위, 추가 상태이상 해소 수 */
  bonus?: { hpDice?: string; wpDice?: string; extraConditions?: ConditionId[] }
}

/** 스트레치 휴식: D6 HP(간호 시 2D6) + D6 WP + 상태이상 1. 시프트당 1회. */
export function stretchRest<T extends Vitals>(
  rng: RNG,
  vitals: T,
  maxHp: number,
  maxWp: number,
  usage: RestUsage,
  options: StretchRestOptions = {},
): RestResult<T> {
  if (usage.stretchRestUsed) {
    return { vitals, usage, hpHealed: 0, wpHealed: 0, conditionsHealed: [], rejected: 'already-used-this-shift' }
  }

  let hpRoll = roll(rng, options.caregiverSuccess ? '2D6' : 'D6').total
  let wpRoll = rollDie(rng, 6)
  if (options.bonus?.hpDice) hpRoll += roll(rng, options.bonus.hpDice).total
  if (options.bonus?.wpDice) wpRoll += roll(rng, options.bonus.wpDice).total

  const hpHealed = clampHeal(vitals.hp, maxHp, hpRoll)
  const wpHealed = clampHeal(vitals.wp, maxWp, wpRoll)

  const toHeal: ConditionId[] = []
  if (options.healCondition && vitals.conditions.includes(options.healCondition)) {
    toHeal.push(options.healCondition)
  } else if (vitals.conditions.length > 0) {
    toHeal.push(vitals.conditions[0]!)
  }
  for (const c of options.bonus?.extraConditions ?? []) {
    if (vitals.conditions.includes(c) && !toHeal.includes(c)) toHeal.push(c)
  }

  return {
    vitals: {
      ...healConditions(vitals, toHeal),
      hp: vitals.hp + hpHealed,
      wp: vitals.wp + wpHealed,
    },
    usage: { ...usage, stretchRestUsed: true },
    hpHealed,
    wpHealed,
    conditionsHealed: toHeal,
  }
}

/** 시프트 휴식: 전부 회복. 안전한 장소 전제(호출부 판단). 방해받으면 무효(호출부). */
export function shiftRest<T extends Vitals>(vitals: T, maxHp: number, maxWp: number): RestResult<T> {
  const conditionsHealed = [...vitals.conditions]
  return {
    vitals: { ...vitals, hp: maxHp, wp: maxWp, conditions: [] },
    usage: { ...FRESH_REST_USAGE }, // 새 시프트 — 사용 기록 초기화
    hpHealed: maxHp - vitals.hp,
    wpHealed: maxWp - vitals.wp,
    conditionsHealed,
  }
}

/* ─────────────────────────── 공포 ─────────────────────────── */

export interface FearAttackResult<T extends Vitals> {
  vitals: T
  resistRoll: SkillRollResult | null
  resisted: boolean
  /** 실패 시 공포표 행 */
  tableRow: RollTableRow | null
  /** 구조화 훅으로 자동 적용된 변화 요약 */
  applied: { wpLost: number; conditionsGained: ConditionId[] }
}

/**
 * 공포 공격: WIL 판정(액션 아님, 푸쉬 가능 — 푸쉬는 호출부).
 * 실패 → 공포표(D8). 표 행의 구조화 훅(drainWp, condition)은 즉시 적용,
 * manual 은 tableRow 로 반환해 호출부가 처리한다.
 * autoResist: 공포 무시 능력 보유 시.
 */
export function fearAttack<T extends Vitals>(
  rng: RNG,
  data: GameData,
  vitals: T,
  options: { bane?: boolean; autoResist?: boolean } = {},
): FearAttackResult<T> {
  if (options.autoResist) {
    return { vitals, resistRoll: null, resisted: true, tableRow: null, applied: { wpLost: 0, conditionsGained: [] } }
  }

  const banes = (options.bane ? 1 : 0) + conditionBanes(new Set(vitals.conditions), 'wil')
  const resistRoll = rollD20(rng, vitals.attributes.wil, { banes })
  if (resistRoll.success) {
    return { vitals, resistRoll, resisted: true, tableRow: null, applied: { wpLost: 0, conditionsGained: [] } }
  }

  const table = data.tables.find((t) => t.id === 'fear')
  if (!table) throw new Error('공포표(fear)가 없습니다')
  const eye = rollDie(rng, table.die)
  const row = table.rows.find((r) => eye >= r.min && eye <= r.max)!

  let out: T = vitals
  let wpLost = 0
  const conditionsGained: ConditionId[] = []

  for (const effect of row.effects) {
    if (effect.hook === 'drainWp') {
      const lost = Math.min(out.wp, roll(rng, String(effect.params?.['dice'])).total)
      wpLost += lost
      out = { ...out, wp: out.wp - lost }
    } else if (effect.hook === 'condition') {
      const c = effect.params?.['condition'] as ConditionId
      const result = sufferCondition(rng, out, c)
      out = result.vitals
      if (result.gained) conditionsGained.push(result.gained)
    }
    // manual 은 tableRow 로 전달
  }

  return { vitals: out, resistRoll, resisted: false, tableRow: row, applied: { wpLost, conditionsGained } }
}

/* ─────────────────────────── 독 ─────────────────────────── */

export type PoisonKind = 'lethal' | 'paralyzing' | 'sleeping'

export interface PoisonExposureResult<T extends Vitals> {
  vitals: T
  /** true = 독이 이김 → 완전 효과. false = 절반 효과(제한 효과) */
  fullEffect: boolean
  /** 완전/제한 공통으로 즉시 적용된 변화 */
  applied: { hpLost: number; conditionsGained: ConditionId[] }
  /** 지속 효과가 남는가 (치명독 라운드당 D6, 마비/수면독 매턴 CON 판정) — 진행은 호출부 */
  ongoing: PoisonKind | null
}

/**
 * 독 노출: 열린 대결 — 독의 강도 vs 대상 CON.
 * 치명독: 완전 = 라운드당 D6 (해독 전까지) / 제한 = 다음 턴 D6 한 번
 * 마비독: 완전 = 탈진 + 매턴 CON 판정(실패 시 행동 불가, 1스트레치) / 제한 = 탈진
 * 수면독: 완전 = 휘청임 + 매턴 CON 판정(실패 시 1시프트 수면) / 제한 = 휘청임
 */
export function poisonExposure<T extends Vitals>(
  rng: RNG,
  vitals: T,
  kind: PoisonKind,
  potency: number,
): PoisonExposureResult<T> {
  const opposed = rollOpenOpposed(rng, potency, vitals.attributes.con)
  const fullEffect = opposed.winner === 'a'

  let out: T = vitals
  let hpLost = 0
  const conditionsGained: ConditionId[] = []

  const gainCondition = (c: ConditionId) => {
    const r = sufferCondition(rng, out, c)
    out = r.vitals
    if (r.gained) conditionsGained.push(r.gained)
  }

  if (kind === 'lethal') {
    if (!fullEffect) {
      // 제한 효과: 다음 턴에 D6 피해 한 번 — 즉시 적용으로 근사
      const dmg = Math.min(out.hp, rollDie(rng, 6))
      hpLost += dmg
      out = { ...out, hp: out.hp - dmg }
    }
    // 완전 효과는 ongoing 으로 — 라운드 진행은 호출부(lethalPoisonTick)
  } else if (kind === 'paralyzing') {
    gainCondition('exhausted')
  } else {
    gainCondition('dazed')
  }

  return {
    vitals: out,
    fullEffect,
    applied: { hpLost, conditionsGained },
    ongoing: fullEffect ? kind : null,
  }
}

/** 치명독 지속: 자기 턴마다 D6 피해 (해독 시 중단 — 호출부) */
export function lethalPoisonTick<T extends Vitals>(rng: RNG, vitals: T): { vitals: T; damage: number } {
  const dmg = Math.min(vitals.hp, rollDie(rng, 6))
  return { vitals: { ...vitals, hp: vitals.hp - dmg }, damage: dmg }
}

/** 마비/수면독 지속: 매턴 CON 판정(액션 아님). 실패 = 그 턴 행동 불가 / 잠듦 */
export function poisonTickRoll(rng: RNG, vitals: Vitals): SkillRollResult {
  return rollD20(rng, vitals.attributes.con)
}

/* ─────────────────────────── 질병 ─────────────────────────── */

export interface DiseaseState {
  virulence: number
  /** 발병했는가 (첫 판정 패배 후 1일 뒤) */
  active: boolean
}

export interface DiseaseRollResult<T extends Vitals> {
  vitals: T
  cured: boolean
  hpLost: number
  becameSick: boolean
}

/**
 * 질병 판정 (노출 시 1회, 이후 매일):
 * 열린 대결 — 병독성 vs CON (간호인이 있으면 치료 스킬로 대신, 약초 조합 보온).
 * 지는 순간 발병: 병약 + D6 HP. 앓는 동안 매일 판정, 실패마다 D6.
 * 이기면 완치. 앓는 동안 회복 불가(호출부가 회복 차단). 0 HP 도달 시 하루 뒤 사망(호출부).
 */
export function diseaseRoll<T extends Vitals>(
  rng: RNG,
  vitals: T,
  disease: DiseaseState,
  options: { healerSkillLevel?: number; herbalBoon?: boolean } = {},
): DiseaseRollResult<T> & { disease: DiseaseState } {
  const defenderTarget = options.healerSkillLevel ?? vitals.attributes.con
  const mods = options.herbalBoon ? { boons: 1 } : {}
  const opposed = rollOpenOpposed(rng, disease.virulence, defenderTarget, {}, mods)

  if (opposed.winner === 'b') {
    return { vitals, cured: true, hpLost: 0, becameSick: false, disease: { ...disease, active: false } }
  }

  let out: T = vitals
  let becameSick = false
  if (!disease.active) {
    const suffered = sufferCondition(rng, out, 'sickly')
    out = suffered.vitals
    becameSick = true
  }
  const dmg = Math.min(out.hp, rollDie(rng, 6))
  out = { ...out, hp: out.hp - dmg }

  return { vitals: out, cured: false, hpLost: dmg, becameSick, disease: { ...disease, active: true } }
}

/* ─────────────────────────── 낙하 ─────────────────────────── */

/**
 * 낙하 피해: ⌊높이/2⌋ 개의 D6 (타격, 방어구 무효). 2m 미만 무해.
 * 곡예 성공 시 주사위 절반(올림). 곡예 판정은 호출부가 굴려 성공 여부만 전달.
 */
export function fallDamage(rng: RNG, heightMeters: number, acrobaticsSuccess: boolean): {
  dice: number
  damage: number
} {
  if (heightMeters < 2) return { dice: 0, damage: 0 }
  let dice = Math.floor(heightMeters / 2)
  if (acrobaticsSuccess) dice = Math.ceil(dice / 2)
  let damage = 0
  for (let i = 0; i < dice; i++) damage += rollDie(rng, 6)
  return { dice, damage }
}

/* ─────────────────────────── 익사 ─────────────────────────── */

/** 물속 숨 참기: 매라운드 CON 판정(액션 아님). 실패 → 익사 시작(라운드당 D6). */
export function holdBreathRoll(rng: RNG, vitals: Vitals): SkillRollResult {
  return rollD20(rng, vitals.attributes.con)
}

export function drowningTick<T extends Vitals>(rng: RNG, vitals: T): { vitals: T; damage: number } {
  const dmg = Math.min(vitals.hp, rollDie(rng, 6))
  return { vitals: { ...vitals, hp: vitals.hp - dmg }, damage: dmg }
}

/* ─────────────────────────── 굶주림 · 추위 · 수면 부족 ─────────────────────────── */

/** 굶주림: 하루 1식 미달 → 회복 불가 + 하루 1 피해. (회복 차단은 호출부 상태 플래그) */
export function starvationDailyTick<T extends Vitals>(vitals: T): T {
  return { ...vitals, hp: Math.max(0, vitals.hp - 1) }
}

/**
 * 추위 판정 실패: D6 HP + D6 WP 상실, 회복 불가 상태로.
 * (판정 자체는 야외술 스킬 — 담요 없으면 베인, 모피 보온 — 호출부가 굴림)
 */
export function coldExposureFailure<T extends Vitals>(rng: RNG, vitals: T): {
  vitals: T
  hpLost: number
  wpLost: number
} {
  const hpLost = Math.min(vitals.hp, rollDie(rng, 6))
  const wpLost = Math.min(vitals.wp, rollDie(rng, 6))
  return { vitals: { ...vitals, hp: vitals.hp - hpLost, wp: vitals.wp - wpLost }, hpLost, wpLost }
}

/** 수면 부족: 3시프트 무수면 이후 깨어 있는 시프트마다 D6 WP 상실. 0 WP → 쓰러져 잠듦. */
export function sleepDeprivationTick<T extends Vitals>(rng: RNG, vitals: T): {
  vitals: T
  wpLost: number
  collapsed: boolean
} {
  const wpLost = Math.min(vitals.wp, rollDie(rng, 6))
  const wp = vitals.wp - wpLost
  return { vitals: { ...vitals, wp }, wpLost, collapsed: wp === 0 }
}

/* ─────────────────────────── 중상 (옵션 룰) ─────────────────────────── */

export interface SevereInjuryResult {
  conRoll: SkillRollResult
  injured: boolean
  row: RollTableRow | null
  /** 치유 기간 (일). permanent 면 null */
  healingDays: number | null
}

/**
 * 0 HP 에서 생환한 뒤: CON 판정 — 실패하면 중상표(D20).
 * 치유 기간은 표의 extra.healingTime 주사위로 굴린다.
 * (간호를 받으면 기간 절반 — 호출부에서 halveHealingDays 적용)
 */
export function rollSevereInjury(rng: RNG, data: GameData, vitals: Vitals): SevereInjuryResult {
  if (!data.config.severeInjuries) {
    return { conRoll: rollD20(rng, 20), injured: false, row: null, healingDays: null }
  }
  const conRoll = rollD20(rng, vitals.attributes.con)
  if (conRoll.success) return { conRoll, injured: false, row: null, healingDays: null }

  const table = data.tables.find((t) => t.id === 'severe-injuries')
  if (!table) throw new Error('중상표(severe-injuries)가 없습니다')
  const eye = rollDie(rng, table.die)
  const row = table.rows.find((r) => eye >= r.min && eye <= r.max)!

  const notation = row.extra?.['healingTime'] as string | undefined
  const healingDays = notation ? roll(rng, notation).total : null

  return { conRoll, injured: true, row, healingDays }
}

export function halveHealingDays(days: number): number {
  return Math.ceil(days / 2)
}
