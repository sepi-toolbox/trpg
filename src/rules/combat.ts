import type { RNG } from './rng'
import { rollDie } from './rng'
import { addModifier, roll, rollCritical } from './dice'
import { abilityModifier, attacksPerTurn, check, proficiencyBonus } from './check'
import { attackBonusOf, defenseOf } from './character'
import type { Character, Combatant, RollMode } from './types'
import { MONSTER_BY_ID, SKILL_BY_ID, WEAPON_BY_ID } from '../data'

export type LogKind =
  | 'system'
  | 'hit'
  | 'miss'
  | 'crit'
  | 'heal'
  | 'buff'
  | 'down'
  | 'info'

export interface LogEntry {
  id: number
  round: number
  kind: LogKind
  text: string
}

export interface CombatState {
  round: number
  /** 선제 순서(전투원 id) */
  order: string[]
  turnIndex: number
  hero: Combatant
  foes: Combatant[]
  log: LogEntry[]
  status: 'ongoing' | 'victory' | 'defeat'
  /** 이번 전투에 남은 기술 사용 횟수 */
  skillUses: Record<string, number>
  /** 영웅의 한 턴 공격 횟수 (레벨에 따라 결정) */
  heroAttacks: number
  xpGained: number
  logSeq: number
}

export const HERO_ID = 'hero'

/** 버프까지 반영한 실제 방어도 */
export function effectiveDefense(c: Combatant): number {
  return c.defense + (c.buffTurns > 0 ? c.defenseBonus : 0)
}

function log(state: CombatState, kind: LogKind, text: string): CombatState {
  return {
    ...state,
    logSeq: state.logSeq + 1,
    log: [...state.log, { id: state.logSeq + 1, round: state.round, kind, text }],
  }
}

export interface EncounterSpec {
  monsterId: string
  count: number
}

/** 몬스터 정의 → 실제 전투원(생명력 주사위를 굴려 확정) */
export function spawnFoes(rng: RNG, specs: EncounterSpec[]): Combatant[] {
  const foes: Combatant[] = []
  for (const spec of specs) {
    const def = MONSTER_BY_ID[spec.monsterId]
    if (!def) throw new Error(`없는 몬스터: ${spec.monsterId}`)
    for (let i = 0; i < spec.count; i++) {
      const hp = Math.max(1, roll(rng, def.hp).total)
      foes.push({
        id: `${def.id}#${i + 1}`,
        name: spec.count > 1 ? `${def.name} ${i + 1}` : def.name,
        hp,
        maxHp: hp,
        defense: def.defense,
        defenseBonus: 0,
        buffTurns: 0,
        attackBonus: def.attackBonus,
        damage: def.damage,
        critRange: 20,
        initiative: 0,
        side: 'foe',
      })
    }
  }
  return foes
}

export function heroCombatant(character: Character): Combatant {
  const weapon = WEAPON_BY_ID[character.weaponId]
  if (!weapon) throw new Error(`없는 무기: ${character.weaponId}`)
  return {
    id: HERO_ID,
    name: character.name,
    hp: character.hp,
    maxHp: character.maxHp,
    defense: defenseOf(character),
    defenseBonus: 0,
    buffTurns: 0,
    attackBonus: attackBonusOf(character),
    // 무기 데미지 = 무기 주사위 + 무기 고유 보정 + 사용 능력치 보정
    damage: addModifier(weapon.damage, abilityModifier(character.abilities[weapon.ability])),
    critRange: weapon.critRange,
    initiative: 0,
    side: 'party',
  }
}

/** 전투 시작 — 선제 판정을 굴려 순서를 확정한다. */
export function startCombat(
  rng: RNG,
  character: Character,
  specs: EncounterSpec[],
): CombatState {
  const hero = heroCombatant(character)
  hero.initiative = rollDie(rng, 20) + abilityModifier(character.abilities.dex)

  const foes = spawnFoes(rng, specs)
  for (const foe of foes) {
    const def = MONSTER_BY_ID[foe.id.split('#')[0]!]!
    foe.initiative = rollDie(rng, 20) + def.initiativeBonus
  }

  const all = [hero, ...foes]
  // 동점이면 플레이어 우선 — 규칙을 명시적으로 고정해 둔다.
  all.sort((a, b) => b.initiative - a.initiative || (a.side === 'party' ? -1 : 1))

  let state: CombatState = {
    round: 1,
    order: all.map((c) => c.id),
    turnIndex: 0,
    hero,
    foes,
    log: [],
    status: 'ongoing',
    skillUses: { ...character.skillUses },
    heroAttacks: attacksPerTurn(character.level),
    xpGained: 0,
    logSeq: 0,
  }

  state = log(
    state,
    'system',
    `전투 시작! 선제 순서 ${all.map((c) => `${c.name}(${c.initiative})`).join(' → ')}`,
  )

  // 영웅보다 빠른 적이 있으면 먼저 행동한다.
  return runFoeTurns(rng, state)
}

export function livingFoes(state: CombatState): Combatant[] {
  return state.foes.filter((f) => f.hp > 0)
}

function checkEnd(state: CombatState): CombatState {
  if (state.hero.hp <= 0) {
    return log({ ...state, status: 'defeat' }, 'down', `${state.hero.name} 쓰러졌다…`)
  }
  if (livingFoes(state).length === 0) {
    const xp = state.foes.reduce((sum, f) => {
      const def = MONSTER_BY_ID[f.id.split('#')[0]!]
      return sum + (def?.xp ?? 0)
    }, 0)
    return log(
      { ...state, status: 'victory', xpGained: xp },
      'system',
      `승리! 경험치 ${xp} 획득.`,
    )
  }
  return state
}

function findCombatant(state: CombatState, id: string): Combatant | undefined {
  return id === HERO_ID ? state.hero : state.foes.find((f) => f.id === id)
}

function applyDamage(state: CombatState, targetId: string, damage: number): CombatState {
  if (targetId === HERO_ID) {
    return { ...state, hero: { ...state.hero, hp: Math.max(0, state.hero.hp - damage) } }
  }
  return {
    ...state,
    foes: state.foes.map((f) =>
      f.id === targetId ? { ...f, hp: Math.max(0, f.hp - damage) } : f,
    ),
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`
}

/** 명중 판정 → 데미지 적용. 크리티컬이면 데미지 주사위를 2배로 굴린다. */
function resolveAttack(
  rng: RNG,
  state: CombatState,
  args: {
    attackerName: string
    targetId: string
    damageNotation: string
    attackBonus: number
    critRange: number
    mode?: RollMode
    label?: string
  },
): { state: CombatState; hit: boolean; damage: number } {
  const target = findCombatant(state, args.targetId)
  if (!target || target.hp <= 0) return { state, hit: false, damage: 0 }

  const targetDefense = effectiveDefense(target)
  const result = check(rng, {
    dc: targetDefense,
    modifier: args.attackBonus,
    mode: args.mode,
  })

  const isCrit = result.natural >= args.critRange
  const label = args.label ? `[${args.label}] ` : ''

  if (!isCrit && !result.success) {
    const next = log(
      state,
      'miss',
      `${label}${args.attackerName} → ${target.name}: 명중 ${result.total}(d20 ${result.natural}${signed(args.attackBonus)}) vs 방어 ${targetDefense} — 빗나감`,
    )
    return { state: next, hit: false, damage: 0 }
  }

  const dmgRoll = isCrit
    ? rollCritical(rng, args.damageNotation)
    : roll(rng, args.damageNotation)
  const damage = Math.max(1, dmgRoll.total)
  const breakdown = `${dmgRoll.rolls.join('+')}${dmgRoll.modifier ? signed(dmgRoll.modifier) : ''}`

  let next = applyDamage(state, target.id, damage)
  next = log(
    next,
    isCrit ? 'crit' : 'hit',
    `${label}${args.attackerName} → ${target.name}: ${isCrit ? '크리티컬! ' : ''}명중 ${result.total}(d20 ${result.natural}) vs 방어 ${targetDefense} — ${damage} 피해 (${breakdown})`,
  )

  const after = findCombatant(next, target.id)!
  if (after.hp <= 0 && target.id !== HERO_ID) {
    next = log(next, 'down', `${target.name} 쓰러졌다.`)
  }

  return { state: next, hit: true, damage }
}

/** 라운드가 한 바퀴 돌 때 버프 지속시간을 깎는다. */
function tickBuffs(c: Combatant): Combatant {
  if (c.buffTurns <= 0) return c
  const buffTurns = c.buffTurns - 1
  return { ...c, buffTurns, defenseBonus: buffTurns === 0 ? 0 : c.defenseBonus }
}

function advanceTurn(state: CombatState): CombatState {
  let turnIndex = state.turnIndex + 1
  let round = state.round
  let hero = state.hero
  let foes = state.foes

  if (turnIndex >= state.order.length) {
    turnIndex = 0
    round += 1
    hero = tickBuffs(hero)
    foes = foes.map(tickBuffs)
  }
  return { ...state, turnIndex, round, hero, foes }
}

/** 영웅 행동 후 공통 처리: 종료 판정 → 턴 넘김 → 적 턴 진행 */
function afterHeroAction(rng: RNG, state: CombatState): CombatState {
  const ended = checkEnd(state)
  if (ended.status !== 'ongoing') return ended
  return runFoeTurns(rng, advanceTurn(ended))
}

/**
 * 영웅의 기본 공격.
 * 5레벨부터는 한 턴에 여러 번 때린다. 대상이 쓰러지면 남은 공격은 다음 적에게 넘어간다.
 */
export function heroAttack(rng: RNG, state: CombatState, targetId: string): CombatState {
  if (!isHeroTurn(state)) return state

  let next = state
  let current = targetId

  for (let i = 0; i < state.heroAttacks; i++) {
    const target = findCombatant(next, current)
    if (!target || target.hp <= 0) {
      const fallback = livingFoes(next)[0]
      if (!fallback) break
      current = fallback.id
    }

    next = resolveAttack(rng, next, {
      attackerName: next.hero.name,
      targetId: current,
      damageNotation: next.hero.damage,
      attackBonus: next.hero.attackBonus,
      critRange: next.hero.critRange,
      label: state.heroAttacks > 1 ? `${i + 1}타` : undefined,
    }).state

    if (livingFoes(next).length === 0) break
  }

  return afterHeroAction(rng, next)
}

/** 영웅의 기술 사용 */
export function heroSkill(
  rng: RNG,
  state: CombatState,
  character: Character,
  skillId: string,
  targetId: string,
): CombatState {
  if (!isHeroTurn(state)) return state

  const skill = SKILL_BY_ID[skillId]
  if (!skill) return log(state, 'info', `없는 기술: ${skillId}`)
  if ((state.skillUses[skillId] ?? 0) <= 0)
    return log(state, 'info', `${skill.name} — 남은 사용 횟수가 없습니다.`)

  let next: CombatState = {
    ...state,
    skillUses: { ...state.skillUses, [skillId]: state.skillUses[skillId]! - 1 },
  }

  const abilityMod = abilityModifier(character.abilities[skill.ability])
  const prof = character.proficiencies.includes(skill.ability)
    ? proficiencyBonus(character.level)
    : 0

  if (skill.kind === 'attack') {
    // 강타는 위력 대신 명중에 불리함을 진다 — 리스크/리턴 트레이드오프.
    next = resolveAttack(rng, next, {
      attackerName: next.hero.name,
      targetId,
      damageNotation: addModifier(skill.power, abilityMod),
      attackBonus: abilityMod + prof,
      critRange: skill.critRange ?? 20,
      mode: skill.mode ?? 'normal',
      label: skill.name,
    }).state
  } else if (skill.kind === 'heal') {
    const healed = Math.max(1, roll(rng, skill.power).total + abilityMod)
    const hp = Math.min(next.hero.maxHp, next.hero.hp + healed)
    const gained = hp - next.hero.hp
    next = { ...next, hero: { ...next.hero, hp } }
    next = log(
      next,
      'heal',
      `[${skill.name}] ${next.hero.name} 생명력 ${gained} 회복 (${hp}/${next.hero.maxHp})`,
    )
  } else {
    const turns = Math.max(1, Number(skill.power) || 2)
    const bonus = skill.defenseBonus ?? 2
    next = {
      ...next,
      hero: { ...next.hero, buffTurns: turns, defenseBonus: bonus },
    }
    next = log(
      next,
      'buff',
      `[${skill.name}] ${turns}라운드 동안 방어도 +${bonus} (현재 ${effectiveDefense(next.hero)})`,
    )
  }

  return afterHeroAction(rng, next)
}

/** 방어 태세 — 1라운드 방어도 +2, 소량 회복 */
export function heroDefend(rng: RNG, state: CombatState): CombatState {
  if (!isHeroTurn(state)) return state

  const recovered = Math.min(state.hero.maxHp - state.hero.hp, rollDie(rng, 4))
  let next: CombatState = {
    ...state,
    hero: {
      ...state.hero,
      defenseBonus: Math.max(state.hero.defenseBonus, 2),
      buffTurns: Math.max(state.hero.buffTurns, 2),
      hp: state.hero.hp + recovered,
    },
  }
  next = log(
    next,
    'buff',
    `${next.hero.name} 방어 태세 — 방어도 +2, 생명력 ${recovered} 회복`,
  )
  return afterHeroAction(rng, next)
}

/** 적 AI: 가장 생명력이 낮은 대상을 노린다(현재는 영웅 1인이라 단순). */
export function runFoeTurns(rng: RNG, state: CombatState): CombatState {
  let next = state
  let guard = 0

  while (next.status === 'ongoing' && next.order[next.turnIndex] !== HERO_ID) {
    if (guard++ > 500) break

    const actorId = next.order[next.turnIndex]!
    const actor = next.foes.find((f) => f.id === actorId)

    if (!actor || actor.hp <= 0) {
      next = advanceTurn(next)
      continue
    }

    next = resolveAttack(rng, next, {
      attackerName: actor.name,
      targetId: HERO_ID,
      damageNotation: actor.damage,
      attackBonus: actor.attackBonus,
      critRange: actor.critRange,
    }).state

    next = checkEnd(next)
    if (next.status !== 'ongoing') return next
    next = advanceTurn(next)
  }

  return next
}

/** 현재 영웅 차례인가 */
export function isHeroTurn(state: CombatState): boolean {
  return state.status === 'ongoing' && state.order[state.turnIndex] === HERO_ID
}
