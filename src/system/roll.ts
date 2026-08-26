/**
 * 판정 코어 — D20 하향 판정.
 *
 * 핵심 규칙:
 *  - D20 ≤ 목표치(스킬 레벨 또는 능력치) → 성공
 *  - 눈 1 = 용(龍): 목표치와 무관하게 성공. 전투·시전에서 특수 효과
 *  - 눈 20 = 마(魔): 무관하게 실패. 푸쉬 불가. 사고표 가능성
 *  - 보온/베인: D20을 하나 더 굴려 낮은/높은 눈 채택. 복수면 개수만큼 추가.
 *    보온 1개와 베인 1개는 상쇄
 *  - 판정 기회는 1번. 예외가 푸쉬(옵션 룰): 실패 시 상태이상을 받고 재굴림
 */
import type { RNG } from './rng'
import { rollDie } from './rng'
import type { AttributeId, ConditionId } from './types'

export const DRAGON = 1
export const DEMON = 20

export interface RollModifiers {
  /** 보온 수 (도움, 상황 이점, 능력 발동 등의 합) */
  boons?: number
  /** 베인 수 (상태이상, 장비 페널티, 상황 불리 등의 합) */
  banes?: number
}

export interface SkillRollResult {
  /** 채택된 눈 */
  natural: number
  /** 굴린 모든 D20 (검증·로그용) */
  allRolls: number[]
  target: number
  success: boolean
  dragon: boolean
  demon: boolean
  /** 상쇄 후 실제 적용된 모드 */
  mode: 'normal' | 'boon' | 'bane'
  /** 상쇄 후 추가 주사위 수 */
  extraDice: number
  /** 이 결과를 푸쉬할 수 있는가 (마가 아니고 실패했을 때) — 옵션 룰 게이트는 호출부 */
  pushable: boolean
}

/** 보온·베인 상쇄 계산 */
export function netModifier(mods: RollModifiers): {
  mode: 'normal' | 'boon' | 'bane'
  extraDice: number
} {
  const net = (mods.boons ?? 0) - (mods.banes ?? 0)
  if (net === 0) return { mode: 'normal', extraDice: 0 }
  return net > 0
    ? { mode: 'boon', extraDice: net }
    : { mode: 'bane', extraDice: -net }
}

/**
 * 스킬/능력치 공용 D20 판정.
 * target: 스킬 레벨(1~18) 또는 능력치(3~18).
 */
export function rollD20(rng: RNG, target: number, mods: RollModifiers = {}): SkillRollResult {
  const { mode, extraDice } = netModifier(mods)

  const allRolls = [rollDie(rng, 20)]
  for (let i = 0; i < extraDice; i++) allRolls.push(rollDie(rng, 20))

  const natural =
    mode === 'boon' ? Math.min(...allRolls) : mode === 'bane' ? Math.max(...allRolls) : allRolls[0]!

  const dragon = natural === DRAGON
  const demon = natural === DEMON
  const success = dragon ? true : demon ? false : natural <= target

  return {
    natural,
    allRolls,
    target,
    success,
    dragon,
    demon,
    mode,
    extraDice,
    pushable: !success && !demon,
  }
}

/**
 * 대결 판정 (능동측 기준).
 *  - 능동측 실패 → 상대와 무관하게 실패
 *  - 능동측 성공 + 상대 실패 → 성공
 *  - 양측 성공 → 능동측 눈 ≤ 상대 눈이면 성공 (동수는 능동측 승)
 * 전투에서는 능동측만 액션을 소모한다.
 */
export interface OpposedResult {
  active: SkillRollResult
  opposing: SkillRollResult
  success: boolean
}

export function rollOpposed(
  rng: RNG,
  activeTarget: number,
  opposingTarget: number,
  activeMods: RollModifiers = {},
  opposingMods: RollModifiers = {},
): OpposedResult {
  const active = rollD20(rng, activeTarget, activeMods)
  const opposing = rollD20(rng, opposingTarget, opposingMods)

  const success = !active.success
    ? false
    : !opposing.success
      ? true
      : active.natural <= opposing.natural

  return { active, opposing, success }
}

/**
 * 열린 대결 판정 (능동측 없음 — 팔씨름 등).
 * 양측 실패, 또는 양측 성공 + 동수면 재굴림. winner: 'a' | 'b'
 */
export function rollOpenOpposed(
  rng: RNG,
  targetA: number,
  targetB: number,
  modsA: RollModifiers = {},
  modsB: RollModifiers = {},
  maxRerolls = 100,
): { a: SkillRollResult; b: SkillRollResult; winner: 'a' | 'b'; rerolls: number } {
  for (let i = 0; i <= maxRerolls; i++) {
    const a = rollD20(rng, targetA, modsA)
    const b = rollD20(rng, targetB, modsB)

    if (a.success && !b.success) return { a, b, winner: 'a', rerolls: i }
    if (!a.success && b.success) return { a, b, winner: 'b', rerolls: i }
    if (a.success && b.success && a.natural !== b.natural) {
      return { a, b, winner: a.natural < b.natural ? 'a' : 'b', rerolls: i }
    }
    // 양측 실패 또는 성공 동수 → 재굴림
  }
  throw new Error('열린 대결 판정이 수렴하지 않음')
}

/* ─────────────────────── 상태이상 ↔ 판정 연결 ─────────────────────── */

export const CONDITION_ATTRIBUTE: Record<ConditionId, AttributeId> = {
  exhausted: 'str',
  sickly: 'con',
  dazed: 'agl',
  angry: 'int',
  scared: 'wil',
  disheartened: 'cha',
}

export const ATTRIBUTE_CONDITION: Record<AttributeId, ConditionId> = {
  str: 'exhausted',
  con: 'sickly',
  agl: 'dazed',
  int: 'angry',
  wil: 'scared',
  cha: 'disheartened',
}

/**
 * 현재 상태이상이 이 능력치 기반 판정에 주는 베인 수.
 * 능력치당 상태이상이 1개이므로 0 또는 1.
 */
export function conditionBanes(conditions: ReadonlySet<ConditionId>, attribute: AttributeId): number {
  return conditions.has(ATTRIBUTE_CONDITION[attribute]) ? 1 : 0
}

/* ─────────────────────── 푸쉬 굴림 (옵션 룰) ─────────────────────── */

export interface PushInput {
  /** 직전 판정 결과 */
  previous: SkillRollResult
  /** 현재 보유 상태이상 */
  conditions: ReadonlySet<ConditionId>
  /** 대가로 받을 상태이상 (이미 가진 것은 불가) */
  chosenCondition: ConditionId
}

export type PushRejection =
  | 'not-failed' //     성공한 판정은 푸쉬할 이유가 없음
  | 'demon' //          마는 푸쉬 불가
  | 'already-have' //   이미 가진 상태이상은 선택 불가
  | 'all-conditions' // 6종을 다 가지면 푸쉬 불가

export function canPush(input: Omit<PushInput, 'chosenCondition'>): PushRejection | null {
  if (input.previous.success) return 'not-failed'
  if (input.previous.demon) return 'demon'
  if (input.conditions.size >= 6) return 'all-conditions'
  return null
}

/**
 * 푸쉬 실행: 상태이상을 받고 같은 조건으로 재굴림.
 * 보온/베인이 있었으면 전부 다시 굴린다(원문). 새 결과가 무조건 적용된다.
 *
 * 주의: 새로 받은 상태이상이 판정 능력치와 겹치면 재굴림에 베인이 추가되는가?
 * → 잠정 해석: 아니오. 푸쉬의 상태이상은 "행동의 결과로 생긴 것"이므로
 *   재굴림 자체에는 반영하지 않는다. (PLAN.md 해석 결정 기록 / 질문 목록 참조)
 */
export function pushRoll(
  rng: RNG,
  input: PushInput,
  mods: RollModifiers = {},
): { result: SkillRollResult; gainedCondition: ConditionId } | { rejected: PushRejection } {
  const rejection = canPush(input)
  if (rejection) return { rejected: rejection }
  if (input.conditions.has(input.chosenCondition)) return { rejected: 'already-have' }

  return {
    result: rollD20(rng, input.previous.target, mods),
    gainedCondition: input.chosenCondition,
  }
}
