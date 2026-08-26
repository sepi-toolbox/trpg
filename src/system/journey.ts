/**
 * 여정 — 이동, 길찾기, 사고, 야영, 사냥·낚시·채집·조리, 강행군.
 *
 * 원문 핵심:
 *  - 시프트 단위 이동: 도보 15km / 기승 30km. 하루 최대 2시프트,
 *    강행군으로 3번째 시프트 → 탈진 (이미 탈진이면 불가)
 *  - 길 없는 지형: 길잡이가 시프트마다 야외술 판정 (지도 없으면 베인, 망원경 보온).
 *    실패 → 사고표(D12). 용 → 지름길, 거리 2배
 *  - 야영: 각자 야외술 판정 (침낭 모피 없으면 베인). 실패 → 잔 것으로 안 침.
 *    텐트: 설치자 1인 판정 + 보온, 성공 시 수용 인원 전원 통과
 *  - 사냥: 추적 판정 → 사냥감표(D6) → 처치 판정(무기 스킬, 덫이면 사냥과 낚시).
 *    멧돼지는 실패 시 역습. 낚시: 낚싯대 D4 / 그물 D6. 채집: D3 (겨울 베인·가을 보온)
 *  - 날 것 섭취 → 병독성 10 질병 판정. 조리: 시프트당 10식, 야외술 판정
 */
import type { RNG } from './rng'
import { roll } from './dice'
import type { RollModifiers, SkillRollResult } from './roll'
import { conditionBanes, rollD20 } from './roll'
import type { ConditionId, GameData, RollTableRow } from './types'
import { rollDie } from './rng'

/** 여정 판정 주체의 최소 상태 */
export interface Traveler {
  skillLevels: Record<string, number>
  conditions: ConditionId[]
}

function travelerRoll(
  rng: RNG,
  data: GameData,
  traveler: Traveler,
  skillId: string,
  extra: RollModifiers = {},
): SkillRollResult {
  const skill = data.skills.find((s) => s.id === skillId)
  const banes =
    (extra.banes ?? 0) +
    (skill ? conditionBanes(new Set(traveler.conditions), skill.attribute) : 0)
  return rollD20(rng, traveler.skillLevels[skillId] ?? 0, { boons: extra.boons ?? 0, banes })
}

/* ─────────────────────────── 이동 ─────────────────────────── */

export const KM_PER_SHIFT_FOOT = 15
export const KM_PER_SHIFT_MOUNTED = 30
export const MAX_TRAVEL_SHIFTS_PER_DAY = 2

export type ForcedMarchRejection = 'already-exhausted' | 'over-limit'

/**
 * 강행군: 하루 3번째 이동 시프트. 탈진을 받는다.
 * 이미 탈진이면 불가. 하루 3시프트 초과는 절대 불가.
 */
export function forcedMarch(
  traveler: Traveler,
  shiftsTraveledToday: number,
): { conditions: ConditionId[] } | { rejected: ForcedMarchRejection } {
  if (shiftsTraveledToday >= 3) return { rejected: 'over-limit' }
  if (traveler.conditions.includes('exhausted')) return { rejected: 'already-exhausted' }
  return { conditions: [...traveler.conditions, 'exhausted'] }
}

/* ─────────────────────────── 길찾기 ─────────────────────────── */

export interface PathfindingOptions {
  hasMap?: boolean
  hasSpyglass?: boolean
  /** 험지 추가 베인 */
  difficultTerrain?: boolean
}

export interface PathfindingResult {
  roll: SkillRollResult
  /** 이번 시프트 이동 거리 배율: 용 2배 / 성공 1 / 실패 사고표에 따름 */
  distanceFactor: number
  mishap: RollTableRow | null
}

/**
 * 길 없는 지형 길찾기: 길잡이의 야외술 판정 (시프트마다).
 * 길·도로를 따라가면 판정 없음 (호출부 판단).
 */
export function pathfind(
  rng: RNG,
  data: GameData,
  pathfinder: Traveler,
  options: PathfindingOptions = {},
): PathfindingResult {
  const result = travelerRoll(rng, data, pathfinder, 'bushcraft', {
    boons: options.hasSpyglass ? 1 : 0,
    banes: (options.hasMap ? 0 : 1) + (options.difficultTerrain ? 1 : 0),
  })

  if (result.dragon) return { roll: result, distanceFactor: 2, mishap: null }
  if (result.success) return { roll: result, distanceFactor: 1, mishap: null }

  const table = data.tables.find((t) => t.id === 'journey-mishap')
  if (!table) throw new Error('여정 사고표(journey-mishap)가 없습니다')
  const eye = rollDie(rng, table.die)
  const row = table.rows.find((r) => eye >= r.min && eye <= r.max)!
  const factor = typeof row.extra?.['distanceFactor'] === 'number'
    ? (row.extra['distanceFactor'] as number)
    : 1

  return { roll: result, distanceFactor: factor, mishap: row }
}

/* ─────────────────────────── 야영 ─────────────────────────── */

export interface CampOptions {
  hasSleepingFur?: boolean
  /** 텐트 설치자로서 판정 (성공 시 수용 인원 전원 통과) */
  usingTent?: boolean
}

/**
 * 야영 판정 (개인별). 실패하면 그 시프트는 잔 것으로 치지 않고
 * 시프트 휴식으로도 쓸 수 없다.
 */
export function makeCamp(
  rng: RNG,
  data: GameData,
  traveler: Traveler,
  options: CampOptions = {},
): { roll: SkillRollResult; success: boolean } {
  const result = travelerRoll(rng, data, traveler, 'bushcraft', {
    boons: options.usingTent ? 1 : 0,
    banes: options.hasSleepingFur ? 0 : 1,
  })
  return { roll: result, success: result.success }
}

/* ─────────────────────────── 사냥 ─────────────────────────── */

export interface HuntResult {
  trackRoll: SkillRollResult
  /** 추적 실패면 null */
  animal: RollTableRow | null
  killRoll: SkillRollResult | null
  rations: number
  /** 멧돼지류 역습 발생 */
  attackedByPrey: boolean
  rejected?: 'no-weapon-or-trap' | 'trap-not-allowed'
}

/**
 * 사냥 (1시프트): 추적(사냥과 낚시) → 사냥감표 → 처치 판정.
 *  - method 'weapon': 처치는 무기 스킬 (weaponSkillId 로 판정)
 *  - method 'trap': 처치도 사냥과 낚시. 덫 불가 동물이면 거부
 * 멧돼지류(attacksOnFailure)는 처치 실패 시 역습 — 전투는 호출부.
 */
export function hunt(
  rng: RNG,
  data: GameData,
  hunter: Traveler,
  method: { kind: 'weapon'; weaponSkillId: string } | { kind: 'trap' },
): HuntResult {
  const trackRoll = travelerRoll(rng, data, hunter, 'hunting-fishing')
  if (!trackRoll.success) {
    return { trackRoll, animal: null, killRoll: null, rations: 0, attackedByPrey: false }
  }

  const table = data.tables.find((t) => t.id === 'hunting')
  if (!table) throw new Error('사냥감표(hunting)가 없습니다')
  const eye = rollDie(rng, table.die)
  const animal = table.rows.find((r) => eye >= r.min && eye <= r.max)!

  if (method.kind === 'trap' && animal.extra?.['trapAllowed'] !== true) {
    return {
      trackRoll, animal, killRoll: null, rations: 0,
      attackedByPrey: false, rejected: 'trap-not-allowed',
    }
  }

  const killSkill = method.kind === 'weapon' ? method.weaponSkillId : 'hunting-fishing'
  const killRoll = travelerRoll(rng, data, hunter, killSkill)

  if (!killRoll.success) {
    return {
      trackRoll, animal, killRoll, rations: 0,
      attackedByPrey: animal.extra?.['attacksOnFailure'] === true,
    }
  }

  const rations = roll(rng, String(animal.extra?.['rations'] ?? '1')).total
  return { trackRoll, animal, killRoll, rations, attackedByPrey: false }
}

/** 낚시 (1시프트): 낚싯대 D4 / 그물 D6 식량 */
export function fish(
  rng: RNG,
  data: GameData,
  fisher: Traveler,
  gear: 'rod' | 'net',
): { roll: SkillRollResult; rations: number } {
  const result = travelerRoll(rng, data, fisher, 'hunting-fishing')
  if (!result.success) return { roll: result, rations: 0 }
  return { roll: result, rations: rollDie(rng, gear === 'rod' ? 4 : 6) }
}

/** 채집 (1시프트): 야외술 — 겨울 베인, 가을 보온. 성공 시 D3 식량(식물). */
export function forage(
  rng: RNG,
  data: GameData,
  forager: Traveler,
  season: 'spring' | 'summer' | 'fall' | 'winter',
): { roll: SkillRollResult; rations: number } {
  const result = travelerRoll(rng, data, forager, 'bushcraft', {
    boons: season === 'fall' ? 1 : 0,
    banes: season === 'winter' ? 1 : 0,
  })
  if (!result.success) return { roll: result, rations: 0 }
  return { roll: result, rations: Math.ceil(rollDie(rng, 6) / 2) } // D3
}

/* ─────────────────────────── 조리 ─────────────────────────── */

export const RAW_FOOD_VIRULENCE = 10
export const COOK_BATCH = 10

/**
 * 조리 (1시프트, 최대 10식): 야외술 판정. 실패 = 날 것 취급.
 * 야전 취사도구·제대로 된 부엌은 보온 (부엌은 수량 무제한 — 호출부).
 * 날 고기·생선 섭취 → 병독성 10 질병 판정 (hazards.diseaseRoll). 식물은 날로 2식 = 1일치.
 */
export function cook(
  rng: RNG,
  data: GameData,
  cook: Traveler,
  rations: number,
  options: { hasFieldKitchen?: boolean; unlimitedBatch?: boolean } = {},
): { roll: SkillRollResult; cooked: number; raw: number } {
  const batch = options.unlimitedBatch ? rations : Math.min(rations, COOK_BATCH)
  const result = travelerRoll(rng, data, cook, 'bushcraft', {
    boons: options.hasFieldKitchen ? 1 : 0,
  })
  if (!result.success) return { roll: result, cooked: 0, raw: batch }
  return { roll: result, cooked: batch, raw: 0 }
}
