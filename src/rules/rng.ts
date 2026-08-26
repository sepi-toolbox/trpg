/**
 * 결정론적 난수원(seeded RNG).
 *
 * 규칙 검증을 하려면 "같은 시드 = 같은 전투 결과"가 보장돼야 한다.
 * Math.random()을 직접 쓰지 않고 전 규칙이 이 인터페이스만 받도록 강제한다.
 */
export interface RNG {
  /** [0, 1) 구간의 실수 */
  next(): number
  /** 현재 내부 상태. 세이브/리플레이용. */
  state(): number
}

/** mulberry32 — 짧고 분포가 충분히 균일한 32bit PRNG */
export function createRNG(seed: number): RNG {
  let a = seed >>> 0
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    state() {
      return a
    },
  }
}

/** 문자열 시드를 32bit 정수로 (플레이어가 "고블린소굴" 같은 시드를 입력할 수 있게) */
export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** 1..sides 정수 */
export function rollDie(rng: RNG, sides: number): number {
  if (!Number.isInteger(sides) || sides < 1) {
    throw new Error(`잘못된 주사위 면 수: ${sides}`)
  }
  return Math.floor(rng.next() * sides) + 1
}

/** 배열에서 하나 균등 선택 */
export function pick<T>(rng: RNG, items: readonly T[]): T {
  if (items.length === 0) throw new Error('빈 배열에서 뽑을 수 없습니다')
  return items[Math.floor(rng.next() * items.length)]!
}

/**
 * 가중치 테이블에서 선택. 데이터 테이블(조우표, 전리품표)에 그대로 대응한다.
 * 가중치는 양의 정수를 권장.
 */
export function pickWeighted<T extends { weight: number }>(
  rng: RNG,
  items: readonly T[],
): T {
  const total = items.reduce((sum, it) => sum + it.weight, 0)
  if (total <= 0) throw new Error('가중치 합이 0 이하입니다')
  let roll = rng.next() * total
  for (const item of items) {
    roll -= item.weight
    if (roll < 0) return item
  }
  return items[items.length - 1]!
}
