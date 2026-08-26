/**
 * 자동 플레이 정책 — 검증 하네스와 테스트가 공유하는 "평균적인 플레이어".
 *
 * 최적 플레이가 아니라 상식적인 판단을 흉내 낸다:
 *  - 리액션은 턴을 소모하므로 체력이 절반 이하일 때만
 *  - 술사는 WP 여유가 있으면 격턴으로 공격 주문
 *  - HP 40% 미만이면 치유 주문(있다면)
 *  - 저녁: 식량 부족하면 사냥, 다쳤으면 휴식, 아니면 취침
 *
 * 여기서 나오는 클리어율이 곧 이 게임의 체감 난이도 지표다 (npm run balance).
 */
import { createRNG } from '../system/rng'
import type { GameData } from '../system/types'
import { createCharacter } from '../system/character'
import type { Character } from '../system/character'
import { weaponOf } from '../system/combatant'
import { maxHp } from '../system/character'
import type { GameState } from './session'
import {
  eveningHunt,
  eveningRest,
  eveningSkip,
  pcAttack,
  pcCastSpell,
  pcEscapeBind,
  pcPass,
  resolveAmbush,
  resolveCritical,
  resolveReaction,
  startGame,
  travelShift,
} from './session'

export type AutoProfession = 'fighter' | 'mage'

export function makeAutoCharacter(data: GameData, seed: number, profession: AutoProfession): Character {
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

export function autoStep(data: GameData, rngSeed: number, state: GameState, tick: number): GameState {
  const rng = createRNG(rngSeed * 7919 + tick)
  const c = state.combat

  if (state.screen === 'combat' && c) {
    if (c.prompt?.kind === 'ambush') {
      // 평균적인 플레이어: 은신이 훈련돼 있으면 잠입, 아니면 정면 돌파
      const sneaky = (c.pc.skills['sneaking'] ?? 0) >= 10
      return resolveAmbush(rng, data, state, sneaky ? 'sneak' : 'open')
    }
    if (c.prompt?.kind === 'reaction') {
      const lowHp = c.pc.hp < c.pc.maxHp * 0.5
      const choice = !lowHp ? 'none' : c.prompt.canParry ? 'parry' : c.prompt.canDodge ? 'dodge' : 'none'
      return resolveReaction(rng, data, state, choice)
    }
    if (c.prompt?.kind === 'critical') {
      return resolveCritical(rng, data, state, 'doubleDice')
    }
    const slot = c.order[c.turnIndex]
    if (slot?.ownerId === 'pc' && !slot.done && c.status === 'ongoing') {
      // 결박·경직 — 벗어나기부터
      if (c.pcBind) return pcEscapeBind(rng, data, state)
      const target = c.enemies.find((e) => !e.state.dead)
      if (!target || c.pc.hp === 0) return pcPass(rng, data, state)

      // 위급하면 치유 주문
      const canHeal =
        state.character.preparedSpellIds.includes('mend-flesh') && state.character.wp >= 2
      if (canHeal && c.pc.hp < c.pc.maxHp * 0.4) {
        return pcCastSpell(rng, data, state, 'mend-flesh', 1, 'self')
      }
      // 술사는 격턴 공격 주문
      const canCast =
        state.character.preparedSpellIds.includes('storm-lash') && state.character.wp >= 2
      if (canCast && tick % 2 === 0) {
        return pcCastSpell(rng, data, state, 'storm-lash', 1, target.state.id)
      }
      const weapon = c.pc.drawnWeaponIds
        .map((id) => weaponOf(data, id))
        .find((w) => w.category !== 'shield' && !c.pc.damagedWeaponIds.includes(w.id))
      if (!weapon) return pcPass(rng, data, state)
      return pcAttack(rng, data, state, weapon.id, target.state.id, weapon.damageTypes[0] ?? null)
    }
    return state
  }

  if (state.screen === 'journey') return travelShift(rng, data, state)
  if (state.screen === 'evening') {
    if (state.rations <= 1) return eveningHunt(rng, data, state)
    if (state.character.hp < maxHp(data, state.character) * 0.7) return eveningRest(rng, data, state)
    return eveningSkip(rng, data, state)
  }
  return state
}

export interface AutoRunResult {
  state: GameState
  outcome: 'cleared' | 'dead' | 'stuck' | 'timeout'
  ticks: number
}

export function autoPlay(data: GameData, seed: number, profession: AutoProfession): AutoRunResult {
  const character = makeAutoCharacter(data, seed, profession)
  let state = startGame(seed, character)
  for (let tick = 0; tick < 800; tick++) {
    if (state.screen === 'dead') return { state, outcome: 'dead', ticks: tick }
    if (state.screen === 'cleared') return { state, outcome: 'cleared', ticks: tick }
    const next = autoStep(data, seed, state, tick)
    if (next === state && state.screen === 'combat') {
      return { state, outcome: 'stuck', ticks: tick }
    }
    state = next
  }
  return { state, outcome: 'timeout', ticks: 800 }
}

export interface BalanceStats {
  profession: AutoProfession
  runs: number
  cleared: number
  dead: number
  broken: number // stuck + timeout — 엔진 결함 신호
  averageDays: number
  deathAtBoss: number
}

export function simulate(data: GameData, profession: AutoProfession, runs: number): BalanceStats {
  let cleared = 0
  let dead = 0
  let broken = 0
  let deathAtBoss = 0
  let totalDays = 0

  for (let seed = 0; seed < runs; seed++) {
    const out = autoPlay(data, seed, profession)
    totalDays += out.state.day
    if (out.outcome === 'cleared') cleared++
    else if (out.outcome === 'dead') {
      dead++
      if (out.state.kmTraveled >= 60) deathAtBoss++
    } else broken++
  }

  return {
    profession,
    runs,
    cleared,
    dead,
    broken,
    averageDays: totalDays / runs,
    deathAtBoss,
  }
}
