import type { RNG } from '../rules/rng'
import { createRNG } from '../rules/rng'
import { createCharacter, standardArrayFor } from '../rules/character'
import { heroAttack, heroSkill, isHeroTurn, livingFoes } from '../rules/combat'
import { CLASS_BY_ID, SKILL_BY_ID } from '../data'
import { continueRun, enterRoom, settleCombat, startRun } from './engine'
import type { RunState } from './engine'

/**
 * "합리적인 플레이어" 정책.
 *
 * 밸런스 수치를 사람 손으로 재지 않기 위한 기준 정책이다.
 * 최적 플레이가 아니라 평균적인 판단을 흉내 내는 게 목적 —
 * 여기서 나오는 클리어율이 사실상 이 게임의 난이도 지표가 된다.
 *
 * 우선순위: 위험하면 회복 → 어려운 싸움 시작에 버프 → 기술 공격 → 평타
 */
export function decideAction(state: RunState): {
  kind: 'attack' | 'skill'
  skillId?: string
  targetId: string
} {
  const combat = state.combat!
  const foes = livingFoes(combat)
  const target = foes[0]!

  const usable = (id: string) => (combat.skillUses[id] ?? 0) > 0
  const byKind = (kind: string) =>
    state.character.skills.find((id) => SKILL_BY_ID[id]?.kind === kind && usable(id))

  const heal = byKind('heal')
  const buff = byKind('buff')
  const attack = byKind('attack')

  const hardFight = foes.length >= 2 || foes.some((f) => f.maxHp > combat.hero.maxHp)

  if (heal && combat.hero.hp < combat.hero.maxHp * 0.4) {
    return { kind: 'skill', skillId: heal, targetId: 'hero' }
  }
  if (buff && combat.hero.buffTurns === 0 && combat.round === 1 && hardFight) {
    return { kind: 'skill', skillId: buff, targetId: 'hero' }
  }
  if (attack) {
    return { kind: 'skill', skillId: attack, targetId: target.id }
  }
  return { kind: 'attack', targetId: target.id }
}

/** 한 턴 진행 */
export function stepRun(rng: RNG, state: RunState): RunState {
  switch (state.phase) {
    case 'exploring':
      return enterRoom(rng, state)
    case 'event':
      return continueRun(state)
    case 'combat': {
      const combat = state.combat!
      if (combat.status !== 'ongoing') return settleCombat(rng, state)
      if (!isHeroTurn(combat)) return state // 정상 흐름에서는 도달하지 않음

      const action = decideAction(state)
      const nextCombat =
        action.kind === 'attack'
          ? heroAttack(rng, combat, action.targetId)
          : heroSkill(rng, combat, state.character, action.skillId!, action.targetId)
      return { ...state, combat: nextCombat }
    }
    default:
      return state
  }
}

/** 던전 한 판을 끝까지 자동 진행한다. */
export function simulateRun(seed: number, classId: string): RunState {
  const rng = createRNG(seed)
  const cls = CLASS_BY_ID[classId]
  if (!cls) throw new Error(`없는 클래스: ${classId}`)

  const character = createCharacter(rng, {
    name: 'sim',
    classId,
    abilities: standardArrayFor(cls),
  })

  let state = startRun(seed, character)
  let guard = 0

  while (state.phase !== 'dead' && state.phase !== 'cleared') {
    if (guard++ > 5000) throw new Error('시뮬레이션이 끝나지 않음 — 무한 루프 의심')
    const next = stepRun(rng, state)
    if (next === state) break // 진행이 멈추면 중단
    state = next
  }

  return state
}

export interface ClassStats {
  classId: string
  runs: number
  cleared: number
  clearRate: number
  averageDepth: number
  depthHistogram: number[]
}

/** 클래스 하나를 N회 시뮬레이션한 통계 */
export function simulateClass(classId: string, runs: number): ClassStats {
  const depths: number[] = []
  let cleared = 0

  for (let seed = 0; seed < runs; seed++) {
    const result = simulateRun(seed, classId)
    if (result.phase === 'cleared') cleared++
    depths.push(result.floorIndex + 1)
  }

  const histogram = [1, 2, 3, 4, 5].map((d) => depths.filter((x) => x === d).length)

  return {
    classId,
    runs,
    cleared,
    clearRate: cleared / runs,
    averageDepth: depths.reduce((a, b) => a + b, 0) / depths.length,
    depthHistogram: histogram,
  }
}
