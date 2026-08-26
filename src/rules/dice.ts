import type { RNG } from './rng'
import { rollDie } from './rng'

/** "2d6+3", "d20", "4d8-1", "3" 같은 표기를 파싱한 결과 */
export interface DiceSpec {
  count: number
  sides: number
  modifier: number
}

export interface DiceResult {
  /** 각 주사위 눈 */
  rolls: number[]
  modifier: number
  /** rolls 합 + modifier (최소 0으로 클램프하지 않음) */
  total: number
  notation: string
}

const DICE_PATTERN = /^\s*(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i
const FLAT_PATTERN = /^\s*([+-]?\d+)\s*$/

/**
 * 주사위 표기법 파서.
 * 데이터 테이블에 "1d8+2" 같은 문자열을 그대로 적고 엔진이 해석하게 하는 게 목적이다.
 */
export function parseDice(notation: string): DiceSpec {
  const flat = FLAT_PATTERN.exec(notation)
  if (flat) {
    return { count: 0, sides: 0, modifier: Number(flat[1]) }
  }

  const m = DICE_PATTERN.exec(notation)
  if (!m) throw new Error(`주사위 표기법을 해석할 수 없습니다: "${notation}"`)

  const count = m[1] === '' ? 1 : Number(m[1])
  const sides = Number(m[2])
  const sign = m[3] === '-' ? -1 : 1
  const modifier = m[4] ? sign * Number(m[4]) : 0

  if (count < 1 || count > 100) throw new Error(`주사위 개수 범위를 벗어남: ${count}`)
  if (sides < 2 || sides > 1000) throw new Error(`주사위 면 수 범위를 벗어남: ${sides}`)

  return { count, sides, modifier }
}

/** 표기법을 굴린다. */
export function roll(rng: RNG, notation: string): DiceResult {
  const spec = parseDice(notation)
  const rolls: number[] = []
  for (let i = 0; i < spec.count; i++) rolls.push(rollDie(rng, spec.sides))
  const total = rolls.reduce((a, b) => a + b, 0) + spec.modifier
  return { rolls, modifier: spec.modifier, total, notation }
}

/** 크리티컬: 주사위 개수를 2배로 굴린다(보정치는 1회만). */
export function rollCritical(rng: RNG, notation: string): DiceResult {
  const spec = parseDice(notation)
  const rolls: number[] = []
  for (let i = 0; i < spec.count * 2; i++) rolls.push(rollDie(rng, spec.sides))
  const total = rolls.reduce((a, b) => a + b, 0) + spec.modifier
  return { rolls, modifier: spec.modifier, total, notation: `크리티컬 ${notation}` }
}

/**
 * 표기법에 보정치를 더한 새 표기법을 만든다.
 * 데이터 테이블에는 "1d8+1"처럼 무기 고유 보정만 적고,
 * 능력치 보정은 런타임에 이 함수로 합친다.
 */
export function addModifier(notation: string, bonus: number): string {
  const { count, sides, modifier } = parseDice(notation)
  const total = modifier + bonus
  if (count === 0) return `${total}`
  if (total === 0) return `${count}d${sides}`
  return `${count}d${sides}${total > 0 ? '+' : '-'}${Math.abs(total)}`
}

/** 이론상 최소/최대. 밸런스 테이블 검산용. */
export function diceRange(notation: string): { min: number; max: number; avg: number } {
  const { count, sides, modifier } = parseDice(notation)
  const min = count * 1 + modifier
  const max = count * sides + modifier
  return { min, max, avg: (min + max) / 2 }
}
