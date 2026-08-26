import type { RNG } from './rng'
import { rollDie } from './rng'
import type { AbilityKey, Abilities, RollMode } from './types'

/** 능력치 → 보정치. 표준 (점수-10)/2 내림. */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2)
}

/** 레벨 → 숙련 보너스. 1~4렙 +2, 5~8렙 +3, 9~12렙 +4 … */
export function proficiencyBonus(level: number): number {
  return 2 + Math.floor(Math.max(1, level - 1) / 4)
}

/**
 * 레벨 → 한 턴 공격 횟수 (5레벨 추가 공격, 10레벨 3회).
 *
 * 이 규칙이 없으면 영웅의 초당 피해량이 레벨과 무관하게 고정돼
 * 후반 층에서 몬스터 생명력을 절대 못 깎는다. 밸런스 시뮬레이션으로 확인한 사항.
 */
export function attacksPerTurn(level: number): number {
  return 1 + Math.floor(level / 5)
}

export interface CheckResult {
  /** 채택된 d20 눈 */
  natural: number
  /** 굴린 모든 d20 눈 (유리/불리 확인용) */
  allRolls: number[]
  modifier: number
  total: number
  dc: number
  success: boolean
  criticalSuccess: boolean
  criticalFailure: boolean
  mode: RollMode
}

/** d20 판정. 자연 20은 무조건 성공, 자연 1은 무조건 실패. */
export function check(
  rng: RNG,
  options: {
    dc: number
    modifier?: number
    mode?: RollMode
  },
): CheckResult {
  const mode = options.mode ?? 'normal'
  const modifier = options.modifier ?? 0

  const allRolls = [rollDie(rng, 20)]
  if (mode !== 'normal') allRolls.push(rollDie(rng, 20))

  const natural =
    mode === 'advantage'
      ? Math.max(...allRolls)
      : mode === 'disadvantage'
        ? Math.min(...allRolls)
        : allRolls[0]!

  const total = natural + modifier
  const criticalSuccess = natural === 20
  const criticalFailure = natural === 1

  return {
    natural,
    allRolls,
    modifier,
    total,
    dc: options.dc,
    success: criticalSuccess ? true : criticalFailure ? false : total >= options.dc,
    criticalSuccess,
    criticalFailure,
    mode,
  }
}

/** 능력치 판정 — 숙련이면 숙련 보너스가 더해진다. */
export function abilityCheck(
  rng: RNG,
  args: {
    abilities: Abilities
    ability: AbilityKey
    dc: number
    level?: number
    proficient?: boolean
    mode?: RollMode
  },
): CheckResult {
  const mod =
    abilityModifier(args.abilities[args.ability]) +
    (args.proficient ? proficiencyBonus(args.level ?? 1) : 0)
  return check(rng, { dc: args.dc, modifier: mod, mode: args.mode })
}
