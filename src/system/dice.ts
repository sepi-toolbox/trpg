/**
 * 주사위 표기 파서·롤러.
 * 데이터 테이블의 "2D8+1", "D6", "5" 를 해석한다 (types.ts 의 DiceNotation).
 */
import type { RNG } from './rng'
import { rollDie } from './rng'

export interface DiceSpec {
  count: number
  sides: number
  modifier: number
}

const DICE_PATTERN = /^\s*(\d*)\s*[dD]\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/
const FLAT_PATTERN = /^\s*(\d+)\s*$/

export function parseDice(notation: string): DiceSpec {
  const flat = FLAT_PATTERN.exec(notation)
  if (flat) return { count: 0, sides: 0, modifier: Number(flat[1]) }

  const m = DICE_PATTERN.exec(notation)
  if (!m) throw new Error(`주사위 표기를 해석할 수 없습니다: "${notation}"`)

  const count = m[1] === '' ? 1 : Number(m[1])
  const sides = Number(m[2])
  const sign = m[3] === '-' ? -1 : 1
  const modifier = m[4] ? sign * Number(m[4]) : 0

  if (count < 1 || count > 100) throw new Error(`주사위 개수 범위 초과: ${count}`)
  if (sides < 2 || sides > 100) throw new Error(`주사위 면 수 범위 초과: ${sides}`)

  return { count, sides, modifier }
}

export interface DiceResult {
  rolls: number[]
  modifier: number
  total: number
  notation: string
}

export function roll(rng: RNG, notation: string): DiceResult {
  const spec = parseDice(notation)
  const rolls: number[] = []
  for (let i = 0; i < spec.count; i++) rolls.push(rollDie(rng, spec.sides))
  return {
    rolls,
    modifier: spec.modifier,
    total: rolls.reduce((a, b) => a + b, 0) + spec.modifier,
    notation,
  }
}

/**
 * 크리티컬(용) 피해: 주사위 개수 2배, 보정치는 1회.
 * "피해 보너스와 기타 보너스를 더하기 전의 주사위만 2배" — 원문.
 */
export function rollDoubled(rng: RNG, notation: string): DiceResult {
  const spec = parseDice(notation)
  const rolls: number[] = []
  for (let i = 0; i < spec.count * 2; i++) rolls.push(rollDie(rng, spec.sides))
  return {
    rolls,
    modifier: spec.modifier,
    total: rolls.reduce((a, b) => a + b, 0) + spec.modifier,
    notation: `${notation} (2배)`,
  }
}

/** 주사위 개수를 n개 늘려 굴린다 (암습 +1개 등). 음수면 줄인다(최소 0개). */
export function rollWithExtraDice(rng: RNG, notation: string, extra: number): DiceResult {
  const spec = parseDice(notation)
  const count = Math.max(0, spec.count + extra)
  const rolls: number[] = []
  for (let i = 0; i < count; i++) rolls.push(rollDie(rng, spec.sides))
  return {
    rolls,
    modifier: spec.modifier,
    total: rolls.reduce((a, b) => a + b, 0) + spec.modifier,
    notation: extra !== 0 ? `${notation} (주사위 ${extra > 0 ? '+' : ''}${extra})` : notation,
  }
}

/** 이론상 최소/최대/평균 — 밸런스 검산용 */
export function diceRange(notation: string): { min: number; max: number; avg: number } {
  const { count, sides, modifier } = parseDice(notation)
  const min = count + modifier
  const max = count * sides + modifier
  return { min, max, avg: (min + max) / 2 }
}
