/**
 * 거리·사거리·붙잡기 — UI 연결 단계에서 추가된 엔진 규칙 검증.
 */
import { describe, expect, it } from 'vitest'
import { createRNG } from './rng'
import { loadGameData } from './load'
import {
  effectiveRange,
  rangedDistanceState,
  tryBreakFree,
  trySpecialGrapple,
  weaponReach,
} from './combat'
import { combatantFromNpc, weaponOf } from './combatant'

const data = loadGameData()

describe('근접 간격·원거리 사거리', () => {
  it('근접 간격: 기본 2m, long 무기 4m', () => {
    expect(weaponReach(weaponOf(data, 'broadsword'))).toBe(2)
    expect(weaponReach(weaponOf(data, 'long-spear'))).toBe(4)
  })

  it('유효 사거리: 원거리는 숫자, 투척은 STR 기반, 근접 전용은 null', () => {
    expect(effectiveRange(weaponOf(data, 'short-bow'), 12)).toBe(30)
    expect(effectiveRange(weaponOf(data, 'dagger'), 15)).toBe(15) // STR
    expect(effectiveRange(weaponOf(data, 'short-spear'), 15)).toBe(30) // STRx2
    expect(effectiveRange(weaponOf(data, 'broadsword'), 15)).toBeNull()
  })

  it('거리 판정: 2m 이내 근접 사격, 사거리 내 정상, ×2까지 베인, 그 밖 불가', () => {
    const bow = weaponOf(data, 'short-bow') // 사거리 30
    expect(rangedDistanceState(bow, null, 2)).toBe('point-blank')
    expect(rangedDistanceState(bow, null, 30)).toBe('normal')
    expect(rangedDistanceState(bow, null, 31)).toBe('long')
    expect(rangedDistanceState(bow, null, 60)).toBe('long')
    expect(rangedDistanceState(bow, null, 61)).toBe('out-of-range')
    expect(rangedDistanceState(weaponOf(data, 'broadsword'), 15, 10)).toBe('out-of-range')
  })
})

describe('붙잡기 (격투 대결)', () => {
  const grabber = () => combatantFromNpc(data, 'raider', 'grabber')
  const victim = () => combatantFromNpc(data, 'raider', 'victim')

  it('시도하면 공격자는 항상 넘어진다 (성공 시 상대도)', () => {
    for (let seed = 0; seed < 20; seed++) {
      const out = trySpecialGrapple(createRNG(seed), data, grabber(), victim())
      expect(out.attacker.prone).toBe(true)
      if (out.success) expect(out.defender.prone).toBe(true)
      else expect(out.defender.prone).toBe(false)
    }
  })

  it('성공과 실패가 모두 발생한다 (대결 판정)', () => {
    const results = new Set<boolean>()
    for (let seed = 0; seed < 40; seed++) {
      results.add(trySpecialGrapple(createRNG(seed), data, grabber(), victim()).success)
    }
    expect(results.has(true)).toBe(true)
    expect(results.has(false)).toBe(true)
  })

  it('벗어나기도 대결 — 성공·실패 모두 나온다', () => {
    const results = new Set<boolean>()
    for (let seed = 0; seed < 40; seed++) {
      results.add(tryBreakFree(createRNG(seed), data, victim(), grabber()).freed)
    }
    expect(results.has(true)).toBe(true)
    expect(results.has(false)).toBe(true)
  })
})
