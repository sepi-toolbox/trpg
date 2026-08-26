import { describe, expect, it } from 'vitest'
import { createRNG } from '../system/rng'
import { loadGameData } from '../system/load'
import { autoPlay, simulate } from './autopilot'
import { runDebrief } from './session'

const data = loadGameData()

describe('게임 루프 자동 플레이', () => {
  it('전사: 여러 시드에서 사망 또는 클리어로 끝난다 (진행 불가 없음)', () => {
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
      const out = autoPlay(data, seed, 'fighter')
      expect(['cleared', 'dead'], `시드 ${seed}: ${out.outcome}`).toContain(out.outcome)
    }
  })

  it('술사도 끝까지 플레이 가능하다', () => {
    for (const seed of [101, 202, 303]) {
      const out = autoPlay(data, seed, 'mage')
      expect(['cleared', 'dead']).toContain(out.outcome)
    }
  })

  it('같은 시드는 같은 결말 (전 구간 결정론)', () => {
    const a = autoPlay(data, 42, 'fighter')
    const b = autoPlay(data, 42, 'fighter')
    expect(a.outcome).toBe(b.outcome)
    expect(a.state.day).toBe(b.state.day)
    expect(a.state.log.map((l) => l.text)).toEqual(b.state.log.map((l) => l.text))
  })

  it('밸런스 가드레일: 클리어 가능하되 쉽지 않고, 엔진 결함 없음', () => {
    const s = simulate(data, 'fighter', 40)
    expect(s.broken, '진행 불가/타임아웃 발생 — 엔진 결함').toBe(0)
    expect(s.cleared, '클리어 불가능 — 밸런스 붕괴').toBeGreaterThan(0)
    expect(s.cleared / s.runs, '너무 쉬움').toBeLessThan(0.9)
  })

  it('정산: 성장 마크가 굴려지고 소거된다', () => {
    for (let seed = 0; seed < 40; seed++) {
      const out = autoPlay(data, seed, 'fighter')
      if (out.outcome !== 'cleared') continue
      const debriefed = runDebrief(createRNG(seed), out.state, ['awareness'])
      expect(debriefed.debrief).not.toBeNull()
      expect(debriefed.character.advancementMarks).toEqual([])
      return
    }
    throw new Error('클리어 시드를 찾지 못함')
  })
})
