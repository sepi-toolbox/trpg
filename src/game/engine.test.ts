import { describe, expect, it } from 'vitest'
import { createRNG } from '../rules/rng'
import { standardArrayFor, createCharacter } from '../rules/character'
import { livingFoes, heroAttack } from '../rules/combat'
import { continueRun, enterRoom, settleCombat, startRun } from './engine'
import { simulateClass, simulateRun, stepRun } from './autoplay'
import { CLASSES, CLASS_BY_ID } from '../data'
import type { RunState } from './engine'

function newRun(seed: number, classId = 'warrior') {
  const rng = createRNG(seed)
  const character = createCharacter(rng, {
    name: '탐험가',
    classId,
    abilities: standardArrayFor(CLASS_BY_ID[classId]!),
  })
  return { rng, state: startRun(seed, character) }
}

/** 최소한의 플레이: 평타만 치고 이벤트는 계속 넘긴다 */
function naiveRun(seed: number, classId = 'warrior'): RunState {
  const { rng, state: initial } = newRun(seed, classId)
  let state = initial
  let guard = 0

  while (state.phase !== 'dead' && state.phase !== 'cleared') {
    if (guard++ > 3000) throw new Error('탐험이 끝나지 않음 — 무한 루프 의심')

    if (state.phase === 'exploring') {
      state = enterRoom(rng, state)
    } else if (state.phase === 'combat') {
      const combat = state.combat!
      if (combat.status !== 'ongoing') {
        state = settleCombat(rng, state)
      } else {
        const target = livingFoes(combat)[0]!
        state = { ...state, combat: heroAttack(rng, combat, target.id) }
      }
    } else {
      state = continueRun(state)
    }
  }
  return state
}

describe('탐험 진행', () => {
  it('여러 시드에서 반드시 사망 또는 클리어로 끝난다', () => {
    for (const seed of [1, 7, 42, 1234, 55555]) {
      expect(['dead', 'cleared']).toContain(naiveRun(seed).phase)
      expect(['dead', 'cleared']).toContain(simulateRun(seed, 'warrior').phase)
    }
  })

  it('같은 시드는 같은 탐험 결과를 재현한다', () => {
    const a = simulateRun(20260826, 'rogue')
    const b = simulateRun(20260826, 'rogue')
    expect(a.phase).toBe(b.phase)
    expect(a.gold).toBe(b.gold)
    expect(a.character.level).toBe(b.character.level)
    expect(a.log.map((l) => l.text)).toEqual(b.log.map((l) => l.text))
  })

  it('금화와 경험치는 줄어들지 않는다', () => {
    const rng = createRNG(88)
    const cls = CLASS_BY_ID['warrior']!
    let state = startRun(
      88,
      createCharacter(rng, {
        name: '탐험가',
        classId: 'warrior',
        abilities: standardArrayFor(cls),
      }),
    )

    let gold = 0
    let xp = 0
    let guard = 0

    while (state.phase !== 'dead' && state.phase !== 'cleared' && guard++ < 3000) {
      expect(state.gold).toBeGreaterThanOrEqual(gold)
      expect(state.character.xp).toBeGreaterThanOrEqual(xp)
      expect(state.character.hp).toBeGreaterThanOrEqual(0)
      expect(state.character.hp).toBeLessThanOrEqual(state.character.maxHp)
      gold = state.gold
      xp = state.character.xp
      const next = stepRun(rng, state)
      if (next === state) break
      state = next
    }
  })
})

/**
 * 밸런스 가드레일.
 * 데이터 테이블(JSON)만 고쳐도 게임이 성립 불가능해질 수 있어서
 * "모든 클래스가 클리어 가능하되, 아무나 쉽게 깨지는 않는다"를 테스트로 못박아 둔다.
 * 실패하면 npm run balance 로 실제 분포를 확인하고 조정할 것.
 */
describe('밸런스 가드레일', () => {
  const RUNS = 200
  const stats = CLASSES.map((c) => simulateClass(c.id, RUNS))

  it('모든 클래스가 최소 한 번은 던전을 클리어한다', () => {
    for (const s of stats) {
      expect(
        s.cleared,
        `${s.classId} 클리어 0회 — 이 클래스는 사실상 플레이 불가`,
      ).toBeGreaterThan(0)
    }
  })

  it('어떤 클래스도 절반 이상 클리어하지 않는다 (난이도가 살아 있어야 한다)', () => {
    for (const s of stats) {
      expect(s.clearRate, `${s.classId} 클리어율 ${s.clearRate}`).toBeLessThan(0.5)
    }
  })

  it('평균 도달 층이 2층 이상이다 (1층에서 전멸하면 안 된다)', () => {
    for (const s of stats) {
      expect(s.averageDepth, `${s.classId} 평균 ${s.averageDepth}`).toBeGreaterThan(2)
    }
  })

  it('1층 사망률이 40%를 넘지 않는다', () => {
    for (const s of stats) {
      const firstFloorDeaths = s.depthHistogram[0]! / s.runs
      expect(firstFloorDeaths, `${s.classId} 1층 사망률 ${firstFloorDeaths}`).toBeLessThan(
        0.4,
      )
    }
  })
})
