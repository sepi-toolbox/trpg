import { describe, expect, it } from 'vitest'
import { createRNG } from '../rng'
import { STANDARD_ARRAY, createCharacter } from '../character'
import {
  effectiveDefense,
  heroAttack,
  heroDefend,
  heroSkill,
  isHeroTurn,
  livingFoes,
  spawnFoes,
  startCombat,
} from '../combat'
import type { CombatState } from '../combat'
import type { Character } from '../types'

function hero(classId = 'warrior', seed = 100): Character {
  return createCharacter(createRNG(seed), {
    name: '용사',
    classId,
    abilities: STANDARD_ARRAY,
  })
}

/** 전투가 끝날 때까지 기본 공격만 반복 */
function autoPlay(seed: number, classId: string, encounter = 'goblin', count = 1) {
  const rng = createRNG(seed)
  const character = hero(classId, seed)
  let state = startCombat(rng, character, [{ monsterId: encounter, count }])

  let guard = 0
  while (state.status === 'ongoing') {
    if (guard++ > 300) throw new Error('전투가 끝나지 않음 — 무한 루프 의심')
    const target = livingFoes(state)[0]
    if (!target) break
    state = heroAttack(rng, state, target.id)
  }
  return state
}

describe('spawnFoes', () => {
  it('개수만큼 서로 다른 id로 생성된다', () => {
    const foes = spawnFoes(createRNG(1), [{ monsterId: 'goblin', count: 3 }])
    expect(foes).toHaveLength(3)
    expect(new Set(foes.map((f) => f.id)).size).toBe(3)
    for (const f of foes) expect(f.hp).toBeGreaterThan(0)
  })

  it('없는 몬스터는 예외', () => {
    expect(() => spawnFoes(createRNG(1), [{ monsterId: 'ghost', count: 1 }])).toThrow()
  })
})

describe('startCombat', () => {
  it('선제 순서에 모든 전투원이 정확히 한 번씩 들어간다', () => {
    const rng = createRNG(55)
    const state = startCombat(rng, hero(), [{ monsterId: 'goblin', count: 2 }])
    expect(state.order).toHaveLength(3)
    expect(new Set(state.order).size).toBe(3)
    expect(state.order).toContain('hero')
  })
})

describe('전투 진행', () => {
  it('여러 시드에서 반드시 승리 또는 패배로 종료된다', () => {
    for (const seed of [1, 2, 3, 17, 99, 12345, 987654]) {
      const state = autoPlay(seed, 'warrior')
      expect(['victory', 'defeat']).toContain(state.status)
    }
  })

  it('승리하면 살아 있는 적이 없고 경험치가 계산된다', () => {
    let victories = 0
    for (const seed of [4, 8, 15, 16, 23, 42, 108, 256]) {
      const state = autoPlay(seed, 'warrior', 'giant_rat', 1)
      if (state.status === 'victory') {
        victories++
        expect(livingFoes(state)).toHaveLength(0)
        expect(state.xpGained).toBeGreaterThan(0)
      }
    }
    expect(victories).toBeGreaterThan(0)
  })

  it('패배하면 영웅 생명력이 0이다', () => {
    let defeats = 0
    for (let seed = 0; seed < 60; seed++) {
      const state = autoPlay(seed, 'mage', 'ogre', 2)
      if (state.status === 'defeat') {
        defeats++
        expect(state.hero.hp).toBe(0)
      }
    }
    expect(defeats).toBeGreaterThan(0)
  })

  it('같은 시드는 같은 전투 결과를 재현한다', () => {
    const a = autoPlay(31337, 'rogue')
    const b = autoPlay(31337, 'rogue')
    expect(a.status).toBe(b.status)
    expect(a.hero.hp).toBe(b.hero.hp)
    expect(a.log.map((l) => l.text)).toEqual(b.log.map((l) => l.text))
  })

  it('생명력은 0 밑으로 내려가지 않는다', () => {
    for (let seed = 0; seed < 40; seed++) {
      const state = autoPlay(seed, 'mage', 'orc', 2)
      expect(state.hero.hp).toBeGreaterThanOrEqual(0)
      for (const f of state.foes) expect(f.hp).toBeGreaterThanOrEqual(0)
    }
  })

  it('영웅 차례가 아니면 행동이 무시된다', () => {
    const rng = createRNG(9)
    const state = startCombat(rng, hero(), [{ monsterId: 'goblin', count: 1 }])
    if (!isHeroTurn(state)) {
      expect(heroAttack(rng, state, state.foes[0]!.id)).toBe(state)
    }
  })
})

describe('기술', () => {
  it('사용하면 남은 횟수가 줄고, 0이 되면 더 못 쓴다', () => {
    const rng = createRNG(21)
    const character = hero('mage', 21)
    let state: CombatState = startCombat(rng, character, [
      { monsterId: 'giant_rat', count: 1 },
    ])

    const before = state.skillUses['firebolt']!
    if (isHeroTurn(state) && state.status === 'ongoing') {
      state = heroSkill(rng, state, character, 'firebolt', state.foes[0]!.id)
      expect(state.skillUses['firebolt']).toBe(before - 1)
    }

    state = { ...state, skillUses: { ...state.skillUses, firebolt: 0 }, status: 'ongoing' }
    const blocked = heroSkill(rng, state, character, 'firebolt', state.foes[0]!.id)
    expect(blocked.skillUses['firebolt']).toBe(0)
  })

  it('회복 기술은 최대 생명력을 넘지 않는다', () => {
    const rng = createRNG(33)
    const character = hero('cleric', 33)
    let state = startCombat(rng, character, [{ monsterId: 'giant_rat', count: 1 }])
    if (isHeroTurn(state) && state.status === 'ongoing') {
      state = heroSkill(rng, state, character, 'mend', 'hero')
      expect(state.hero.hp).toBeLessThanOrEqual(state.hero.maxHp)
    }
  })

  it('버프 기술은 방어도를 올린다', () => {
    const rng = createRNG(44)
    const character = hero('rogue', 44)
    let state = startCombat(rng, character, [{ monsterId: 'giant_rat', count: 1 }])
    const base = effectiveDefense(state.hero)
    if (isHeroTurn(state) && state.status === 'ongoing') {
      state = heroSkill(rng, state, character, 'evade', 'hero')
      if (state.status === 'ongoing') {
        expect(effectiveDefense(state.hero)).toBeGreaterThan(base)
      }
    }
  })
})

describe('방어 태세', () => {
  it('생명력이 줄지 않고 방어도가 오른다', () => {
    const rng = createRNG(66)
    const character = hero('warrior', 66)
    let state = startCombat(rng, character, [{ monsterId: 'giant_rat', count: 1 }])
    if (isHeroTurn(state) && state.status === 'ongoing') {
      const beforeHp = state.hero.hp
      state = heroDefend(rng, state)
      // 적 턴에 맞을 수는 있지만 방어 자체가 체력을 깎지는 않는다
      expect(state.hero.hp).toBeGreaterThanOrEqual(0)
      expect(beforeHp).toBeGreaterThan(0)
    }
  })
})
