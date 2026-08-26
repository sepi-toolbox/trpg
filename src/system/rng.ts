/**
 * 시드 기반 결정론적 난수원.
 * 같은 시드 = 같은 결과. 규칙 검증과 리플레이의 전제 조건이므로
 * 시스템 전체에서 Math.random() 을 쓰지 않고 이 인터페이스만 사용한다.
 */
export interface RNG {
  /** [0, 1) */
  next(): number
  /** 현재 내부 상태 (세이브/리플레이용) */
  state(): number
}

/** mulberry32 */
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

/** 문자열 시드 → 32bit 정수 (FNV-1a) */
export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** 1..sides 정수. D3 = D6/2 올림 같은 변형은 호출부에서 처리한다. */
export function rollDie(rng: RNG, sides: number): number {
  if (!Number.isInteger(sides) || sides < 2) {
    throw new Error(`잘못된 주사위 면 수: ${sides}`)
  }
  return Math.floor(rng.next() * sides) + 1
}
