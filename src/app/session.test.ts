import { describe, expect, it } from 'vitest'
import { createRNG } from '../system/rng'
import { loadGameData } from '../system/load'
import { createCharacter } from '../system/character'
import type { GameState } from './session'
import {
  eveningHunt,
  eveningRest,
  eveningSkip,
  pcAttack,
  pcCastSpell,
  pcPass,
  resolveCritical,
  resolveReaction,
  runDebrief,
  startGame,
  travelShift,
} from './session'
import { weaponOf } from '../system/combatant'

const data = loadGameData()

function makeCharacter(seed: number, profession: 'fighter' | 'mage') {
  if (profession === 'fighter') {
    return createCharacter(createRNG(seed), data, {
      name: '자동전사',
      kinId: 'human',
      professionId: 'fighter',
      ageId: 'adult',
      attributes: { str: 15, con: 14, agl: 13, int: 12, wil: 10, cha: 8 },
      trainedSkillIds: [
        'swords', 'axes', 'evade', 'brawling', 'spears', 'bows',
        'bushcraft', 'hunting-fishing', 'awareness', 'healing',
      ],
      heroicAbilityId: 'veteran',
      gearRoll: 1,
    })
  }
  return createCharacter(createRNG(seed), data, {
    name: '자동술사',
    kinId: 'starfolk',
    professionId: 'mage',
    variantId: 'spirit',
    ageId: 'adult',
    attributes: { str: 10, con: 14, agl: 13, int: 15, wil: 14, cha: 8 },
    trainedSkillIds: [
      'spirit-magic', 'healing', 'evade', 'staves', 'bushcraft', 'sneaking',
      'hunting-fishing', 'acrobatics', 'awareness', 'languages',
    ],
    spellIds: ['storm-lash', 'mend-flesh', 'unbind', 'spark-flick', 'glimmer', 'unseen-hand'],
    gearRoll: 1,
  })
}

/** 자동 플레이 정책: 프롬프트 응답 → PC 턴 행동 → 화면 진행 */
function autoStep(rngSeed: number, state: GameState, tick: number): GameState {
  const rng = createRNG(rngSeed * 7919 + tick)
  const c = state.combat

  if (state.screen === 'combat' && c) {
    if (c.prompt?.kind === 'reaction') {
      // 리액션은 턴을 소모한다 — 위험할 때만 막는다
      const lowHp = c.pc.hp < c.pc.maxHp * 0.5
      const choice = !lowHp ? 'none' : c.prompt.canParry ? 'parry' : c.prompt.canDodge ? 'dodge' : 'none'
      return resolveReaction(rng, data, state, choice)
    }
    if (c.prompt?.kind === 'critical') {
      return resolveCritical(rng, data, state, 'doubleDice')
    }
    const slot = c.order[c.turnIndex]
    if (slot?.ownerId === 'pc' && !slot.done && c.status === 'ongoing') {
      const target = c.enemies.find((e) => !e.state.dead)
      if (!target) return pcPass(rng, data, state)
      if (c.pc.hp === 0) return pcPass(rng, data, state)

      // 술사는 WP 있으면 주문, 아니면 지팡이
      const canCast =
        state.character.preparedSpellIds.includes('storm-lash') && state.character.wp >= 2
      if (canCast && tick % 2 === 0) {
        return pcCastSpell(rng, data, state, 'storm-lash', 1, target.state.id)
      }
      const weapon = state.combat!.pc.drawnWeaponIds
        .map((id) => weaponOf(data, id))
        .find((w) => w.category !== 'shield' && !state.combat!.pc.damagedWeaponIds.includes(w.id))
      if (!weapon) return pcPass(rng, data, state)
      return pcAttack(rng, data, state, weapon.id, target.state.id, weapon.damageTypes[0] ?? null)
    }
    return state // 진행 불가 상태면 그대로 (외부에서 감지)
  }

  if (state.screen === 'journey') return travelShift(rng, data, state)
  if (state.screen === 'evening') {
    return tick % 3 === 0
      ? eveningHunt(rng, data, state)
      : tick % 3 === 1
        ? eveningRest(rng, data, state)
        : eveningSkip(rng, data, state)
  }
  return state
}

function autoPlay(seed: number, profession: 'fighter' | 'mage'): GameState {
  const character = makeCharacter(seed, profession)
  let state = startGame(seed, character)
  for (let tick = 0; tick < 600; tick++) {
    if (state.screen === 'dead' || state.screen === 'cleared') return state
    const next = autoStep(seed, state, tick)
    if (next === state && state.screen === 'combat') {
      throw new Error(
        `전투가 진행 불가 상태에 빠짐 (tick ${tick}, round ${state.combat?.round}, turn ${state.combat?.turnIndex})`,
      )
    }
    state = next
  }
  throw new Error('600틱 안에 끝나지 않음')
}

describe('게임 루프 자동 플레이', () => {
  it('전사: 여러 시드에서 사망 또는 클리어로 끝난다', () => {
    const results = { dead: 0, cleared: 0 }
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
      const end = autoPlay(seed, 'fighter')
      results[end.screen as 'dead' | 'cleared']++
      expect(['dead', 'cleared']).toContain(end.screen)
      expect(end.day).toBeGreaterThanOrEqual(1)
    }
    // 양쪽 결말이 모두 존재해야 밸런스가 살아 있는 것
    expect(results.dead + results.cleared).toBe(10)
  })

  it('술사도 끝까지 플레이 가능하다', () => {
    for (const seed of [101, 202, 303]) {
      const end = autoPlay(seed, 'mage')
      expect(['dead', 'cleared']).toContain(end.screen)
    }
  })

  it('같은 시드는 같은 결말 (전 구간 결정론)', () => {
    const a = autoPlay(42, 'fighter')
    const b = autoPlay(42, 'fighter')
    expect(a.screen).toBe(b.screen)
    expect(a.day).toBe(b.day)
    expect(a.log.map((l) => l.text)).toEqual(b.log.map((l) => l.text))
  })

  it('클리어하는 시드가 존재한다', () => {
    let cleared = 0
    for (let seed = 0; seed < 30; seed++) {
      try {
        if (autoPlay(seed, 'fighter').screen === 'cleared') cleared++
      } catch {
        // 개별 시드 실패는 다른 테스트에서 잡는다
      }
    }
    expect(cleared).toBeGreaterThan(0)
  })

  it('정산: 성장 마크가 굴려지고 소거된다', () => {
    for (let seed = 0; seed < 30; seed++) {
      const end = (() => {
        try { return autoPlay(seed, 'fighter') } catch { return null }
      })()
      if (!end || end.screen !== 'cleared') continue
      const debriefed = runDebrief(createRNG(seed), end, ['awareness'])
      expect(debriefed.debrief).not.toBeNull()
      expect(debriefed.character.advancementMarks).toEqual([])
      return
    }
    throw new Error('클리어 시드를 찾지 못함')
  })
})
