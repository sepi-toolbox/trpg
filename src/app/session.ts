/**
 * 게임 세션 — 엔진 모듈들을 하나의 플레이 루프로 엮는다.
 *
 * 게임 구조 (초벌 시나리오, 콘텐츠는 임시):
 *   캐릭터 생성 → 목적지까지 60km 여정 (길 없는 지형)
 *   → 하루 = 이동 2시프트(강행군 시 3) + 저녁 활동 + 야간 수면
 *   → 이동 중 조우(약탈자·늪그림자) / 사고표
 *   → 도착하면 수호자(돌가죽 거한)와 결전 → 정산(성장 굴림)
 *
 * 모든 무작위는 세션 RNG 하나에서 나온다 — 같은 시드는 같은 모험.
 */
import type { RNG } from '../system/rng'
import { rollDie } from '../system/rng'
import type { GameData, ConditionId, DamageType, RollTableRow } from '../system/types'
import type { Character } from '../system/character'
import { maxHp, maxWp, resolveAdvancement, markAdvancement } from '../system/character'
import type { AdvancementRollResult } from '../system/character'
import type { Combatant } from '../system/combatant'
import { combatantFromCharacter, combatantFromNpc, weaponOf } from '../system/combatant'
import type { AttackRoll, CriticalChoice } from '../system/combat'
import {
  applyDamage,
  deathRoll,
  drawInitiative,
  rollAttack,
  rollDamage,
  tryDodge,
  tryParry,
  trySpecialTopple,
  checkParryDurability,
} from '../system/combat'
import type { MonsterAttack } from '../system/types'
import type { MonsterCombatant } from '../system/monster'
import {
  applyDamageToMonster,
  monsterDefense,
  reactToMonsterAttack,
  refreshMonsterRound,
  rollMonsterAttack,
  spawnMonster,
  toppleMonster,
} from '../system/monster'
import { applyEffects } from '../system/effects'
import type { Vitals, RestUsage } from '../system/hazards'
import {
  FRESH_REST_USAGE,
  stretchRest,
  shiftRest,
  sufferCondition,
  starvationDailyTick,
} from '../system/hazards'
import { stretchRestBonus } from '../system/effects'
import { pathfind, makeCamp, hunt, forcedMarch, KM_PER_SHIFT_FOOT } from '../system/journey'
import { castSpell, rollSpellDice, isHealingSpell, spellOf } from '../system/magic'
import { rollD20 } from '../system/roll'
import { gatherMods } from '../system/combat'

export const JOURNEY_TOTAL_KM = 60

/* ─────────────────────────── 로그 ─────────────────────────── */

export interface LogEntry {
  id: number
  kind: 'system' | 'good' | 'bad' | 'info' | 'combat' | 'crit'
  text: string
}

/* ─────────────────────────── 전투 세션 ─────────────────────────── */

export type EnemyUnit =
  | { kind: 'monster'; state: MonsterCombatant }
  | { kind: 'npc'; state: Combatant }

export interface TurnSlot {
  ownerId: string
  card: number
  done: boolean
}

/** UI가 응답해야 하는 대기 상태 */
export type PendingPrompt =
  | {
      kind: 'reaction' // 적 공격이 명중 — 회피/패리/그냥 맞기
      enemyId: string
      /** 몬스터 공격이면 그 공격, NPC면 AttackRoll */
      monsterAttack?: MonsterAttack
      npcAttack?: AttackRoll
      canDodge: boolean
      canParry: boolean
    }
  | {
      kind: 'critical' // PC 크리티컬 — 효과 선택
      attack: AttackRoll
      enemyId: string
      choices: CriticalChoice[]
    }

export interface CombatSession {
  round: number
  order: TurnSlot[]
  turnIndex: number
  pc: Combatant
  enemies: EnemyUnit[]
  prompt: PendingPrompt | null
  status: 'ongoing' | 'victory' | 'defeat'
  /** 능력 발동으로 다음 PC 공격에 걸리는 보온 */
  nextRollBoons: number
}

/* ─────────────────────────── 게임 상태 ─────────────────────────── */

export type Screen =
  | 'creation'
  | 'journey' //  이동 선택 화면
  | 'event' //    사고·조우 결과 표시
  | 'combat'
  | 'evening' //  저녁 활동 선택
  | 'debrief' //  정산 (성장 굴림)
  | 'dead'
  | 'cleared'

export interface GameState {
  seed: number
  character: Character
  screen: Screen
  day: number
  /** 오늘 이동한 시프트 수 */
  shiftsTraveledToday: number
  kmTraveled: number
  rations: number
  famished: boolean
  restUsage: RestUsage
  combat: CombatSession | null
  /** event 화면용 텍스트 */
  eventText: string
  eventTone: 'good' | 'bad' | 'info'
  log: LogEntry[]
  logSeq: number
  /** 정산 결과 */
  debrief: AdvancementRollResult[] | null
  bossDefeated: boolean
}

let _logSeq = 0
function log(state: GameState, kind: LogEntry['kind'], text: string): GameState {
  _logSeq = state.logSeq + 1
  return {
    ...state,
    logSeq: _logSeq,
    log: [...state.log, { id: _logSeq, kind, text }],
  }
}

/* ─────────────────────────── 캐릭터 ↔ Vitals 동기화 ─────────────────────────── */

function vitalsOf(character: Character): Vitals {
  return {
    hp: character.hp,
    wp: character.wp,
    conditions: character.conditions,
    attributes: character.attributes,
  }
}

function withVitals(character: Character, v: Vitals): Character {
  return { ...character, hp: v.hp, wp: v.wp, conditions: [...v.conditions] }
}

/** 용/마를 굴린 스킬에 성장 마크 (PC 판정 공통 처리) */
function trackMark(state: GameState, skillId: string | null, dragon: boolean, demon: boolean): GameState {
  if (!skillId || (!dragon && !demon)) return state
  return { ...state, character: markAdvancement(state.character, skillId) }
}

/* ─────────────────────────── 시작 ─────────────────────────── */

export function startGame(seed: number, character: Character): GameState {
  _logSeq = 0
  const base: GameState = {
    seed,
    character,
    screen: 'journey',
    day: 1,
    shiftsTraveledToday: 0,
    kmTraveled: 0,
    rations: countRations(character),
    famished: false,
    restUsage: { ...FRESH_REST_USAGE },
    combat: null,
    eventText: '',
    eventTone: 'info',
    log: [],
    logSeq: 0,
    debrief: null,
    bossDefeated: false,
  }
  return log(
    base,
    'system',
    `${character.name}, 옛 파수탑까지 ${JOURNEY_TOTAL_KM}km — 길 없는 황야를 건너야 한다.`,
  )
}

function countRations(character: Character): number {
  const entry = character.inventory.find((i) => i.itemId === 'field-ration')
  return entry?.qty ?? 0
}

/* ─────────────────────────── 여정: 이동 시프트 ─────────────────────────── */

export function travelShift(rng: RNG, data: GameData, state: GameState, forced = false): GameState {
  if (state.screen !== 'journey') return state
  let s = state

  // 이미 도착한 상태 → 결전
  if (s.kmTraveled >= JOURNEY_TOTAL_KM && !s.bossDefeated) {
    s = log(s, 'system', '무너진 문을 밀어젖힌다 — 수호자가 일어선다.')
    return beginCombat(rng, data, s, [{ npcOrMonster: 'monster', id: 'stonehide' }])
  }

  if (forced) {
    const out = forcedMarch(
      { skillLevels: s.character.skillLevels, conditions: s.character.conditions },
      s.shiftsTraveledToday,
    )
    if ('rejected' in out) {
      return log(s, 'bad', out.rejected === 'already-exhausted' ? '이미 탈진해 강행군할 수 없다.' : '오늘은 더 걸을 수 없다.')
    }
    s = { ...s, character: { ...s.character, conditions: out.conditions } }
    s = log(s, 'bad', '이를 악물고 강행군한다 — 탈진.')
  }

  // 길찾기
  const pf = pathfind(rng, data, {
    skillLevels: s.character.skillLevels,
    conditions: s.character.conditions,
  }, { hasMap: false })
  s = trackMark(s, 'bushcraft', pf.roll.dragon, pf.roll.demon)

  const km = Math.round(KM_PER_SHIFT_FOOT * pf.distanceFactor)
  s = {
    ...s,
    kmTraveled: Math.min(JOURNEY_TOTAL_KM, s.kmTraveled + km),
    shiftsTraveledToday: s.shiftsTraveledToday + 1,
  }

  if (pf.roll.dragon) {
    s = log(s, 'good', `지름길 발견! ${km}km 전진 (${s.kmTraveled}/${JOURNEY_TOTAL_KM}km)`)
  } else if (pf.mishap) {
    s = log(s, 'bad', `사고 — ${pf.mishap.name}: ${km}km 전진`)
    s = applyJourneyMishap(rng, s, pf.mishap)
    if (s.screen === 'dead') return s
  } else {
    s = log(s, 'info', `${km}km 전진 (${s.kmTraveled}/${JOURNEY_TOTAL_KM}km)`)
  }

  // 도착 → 문 앞에서 숨을 고를 수 있다
  if (s.kmTraveled >= JOURNEY_TOTAL_KM && !s.bossDefeated) {
    s = log(s, 'system', '옛 파수탑에 도착했다. 문 안쪽에서 낮게 우르릉거리는 소리가 들린다.')
    return { ...s, screen: 'evening' }
  }

  // 조우 판정 (D6 = 1: 약탈자)
  const encounterRoll = rollDie(rng, 6)
  if (encounterRoll === 1) {
    s = log(s, 'bad', '수풀 너머에서 약탈자가 튀어나온다!')
    return beginCombat(rng, data, s, [{ npcOrMonster: 'npc', id: 'raider' }])
  }

  // 하루 이동 한계 → 저녁
  if (s.shiftsTraveledToday >= 2 && !forced) {
    return { ...s, screen: 'evening' }
  }
  if (forced) return { ...s, screen: 'evening' }
  return s
}

function applyJourneyMishap(rng: RNG, state: GameState, row: RollTableRow): GameState {
  let s = state
  const dmgNotation = row.extra?.['damage'] as string | undefined
  if (dmgNotation) {
    // 간이 처리: 회피류 판정 대신 EVADE 판정 1회 (실패 시 피해)
    const evade = rollD20(rng, s.character.skillLevels['evade'] ?? 0)
    s = trackMark(s, 'evade', evade.dragon, evade.demon)
    if (!evade.success) {
      const dice = dmgNotation
      let dmg = 0
      const spec = dice.toUpperCase()
      dmg = spec === 'D6' ? rollDie(rng, 6) : spec === 'D10' ? rollDie(rng, 10) : rollDie(rng, 6)
      const boots = row.extra?.['bootsReduce'] as number | undefined
      if (boots) dmg = Math.max(0, dmg - boots) // 장화 보유 가정 안 함 — 초벌은 미적용이 기본이나 여기선 감산 없음
      const hp = Math.max(0, s.character.hp - dmg)
      s = { ...s, character: { ...s.character, hp } }
      s = log(s, 'bad', `${row.name} — ${dmg} 피해 (HP ${hp})`)
      if (hp === 0) {
        return { ...log(s, 'bad', '길 위에서 쓰러졌다…'), screen: 'dead' }
      }
    } else {
      s = log(s, 'good', `${row.name} — 아슬아슬하게 피했다.`)
    }
  }
  const cond = row.extra?.['conditionWithoutCloak'] as ConditionId | undefined
  if (cond) {
    const suffered = sufferCondition(rng, vitalsOf(s.character), cond)
    s = { ...s, character: withVitals(s.character, suffered.vitals) }
    if (suffered.gained) s = log(s, 'bad', `${row.name} — 상태이상`)
  }
  return s
}

/* ─────────────────────────── 저녁·야간 ─────────────────────────── */

export function eveningHunt(rng: RNG, data: GameData, state: GameState): GameState {
  if (state.screen !== 'evening') return state
  const weapon = state.character.weaponsAtHand
    .map((id) => weaponOf(data, id))
    .find((w) => w.category !== 'shield')
  const out = hunt(rng, data, {
    skillLevels: state.character.skillLevels,
    conditions: state.character.conditions,
  }, weapon ? { kind: 'weapon', weaponSkillId: weapon.skillId } : { kind: 'trap' })

  let s = trackMark(state, 'hunting-fishing', out.trackRoll.dragon, out.trackRoll.demon)
  if (out.rations > 0) {
    s = { ...s, rations: s.rations + out.rations }
    s = log(s, 'good', `사냥 성공 — ${out.animal?.name} (식량 +${out.rations}, 총 ${s.rations})`)
  } else if (out.attackedByPrey) {
    s = log(s, 'bad', `${out.animal?.name}이(가) 덤벼든다!`)
    return nightPhase(rng, data, beginCombat(rng, data, s, [{ npcOrMonster: 'npc', id: 'raider' }]), true)
    // 초벌: 멧돼지 전투는 약탈자 스탯으로 대체 (베스티어리 확충 시 교체)
  } else {
    s = log(s, 'info', '사냥은 빈손으로 끝났다.')
  }
  return nightPhase(rng, data, s)
}

export function eveningRest(rng: RNG, data: GameData, state: GameState): GameState {
  if (state.screen !== 'evening') return state
  const mHp = maxHp(data, state.character)
  const mWp = maxWp(data, state.character)
  const bonus = stretchRestBonus(data, state.character.abilities, state.character.conditions)
  const out = stretchRest(rng, vitalsOf(state.character), mHp, mWp, state.restUsage, {
    healCondition: state.character.conditions[0],
    bonus,
  })
  let s = state
  if (out.rejected) {
    s = log(s, 'info', '이번 시프트에는 이미 휴식했다.')
  } else {
    s = { ...s, character: withVitals(s.character, out.vitals), restUsage: out.usage }
    s = log(s, 'good', `휴식 — HP +${out.hpHealed}, WP +${out.wpHealed}${out.conditionsHealed.length ? ', 상태이상 회복' : ''}`)
  }
  return nightPhase(rng, data, s)
}

export function eveningSkip(rng: RNG, data: GameData, state: GameState): GameState {
  if (state.screen !== 'evening') return state
  return nightPhase(rng, data, state)
}

/** 야간: 식사 → 야영 판정 → 수면(시프트 휴식) → 다음 날 */
function nightPhase(rng: RNG, data: GameData, state: GameState, skipCamp = false): GameState {
  let s = state
  if (s.screen === 'dead' || s.screen === 'combat') return s

  // 식사
  if (s.rations > 0) {
    s = { ...s, rations: s.rations - 1, famished: false }
    s = log(s, 'info', `식사 (남은 식량 ${s.rations})`)
  } else {
    if (s.famished) {
      const c = starvationDailyTick(vitalsOf(s.character))
      s = { ...s, character: withVitals(s.character, c) }
      s = log(s, 'bad', `굶주림 — 1 피해 (HP ${c.hp})`)
      if (c.hp === 0) return { ...log(s, 'bad', '굶주림 끝에 쓰러졌다…'), screen: 'dead' }
    } else {
      s = { ...s, famished: true }
      s = log(s, 'bad', '식량이 없다 — 굶주리기 시작한다.')
    }
  }

  // 야영 + 수면
  const camp = skipCamp
    ? { success: false }
    : makeCamp(rng, data, {
        skillLevels: s.character.skillLevels,
        conditions: s.character.conditions,
      }, { hasSleepingFur: hasItem(s.character, 'sleeping-fur') })

  if (!skipCamp && 'roll' in camp) {
    s = trackMark(s, 'bushcraft', camp.roll.dragon, camp.roll.demon)
  }

  if (camp.success && !s.famished) {
    const out = shiftRest(vitalsOf(s.character), maxHp(data, s.character), maxWp(data, s.character))
    s = { ...s, character: withVitals(s.character, out.vitals), restUsage: out.usage }
    s = log(s, 'good', '깊이 잠들었다 — 완전 회복.')
  } else if (camp.success && s.famished) {
    s = log(s, 'info', '잠은 잤지만 굶주림에 회복하지 못했다.')
    s = { ...s, restUsage: { ...FRESH_REST_USAGE } }
  } else {
    s = log(s, 'bad', '편히 쉴 곳을 찾지 못했다 — 회복 없이 아침을 맞는다.')
    s = { ...s, restUsage: { ...FRESH_REST_USAGE } }
  }

  return {
    ...s,
    day: s.day + 1,
    shiftsTraveledToday: 0,
    screen: 'journey',
  }
}

function hasItem(character: Character, itemId: string): boolean {
  return character.inventory.some((i) => i.itemId === itemId && i.qty > 0)
}

/* ─────────────────────────── 전투: 시작·선제 ─────────────────────────── */

interface EnemySpec {
  npcOrMonster: 'npc' | 'monster'
  id: string
}

export function beginCombat(rng: RNG, data: GameData, state: GameState, specs: EnemySpec[]): GameState {
  const pc = combatantFromCharacter(data, state.character)
  const enemies: EnemyUnit[] = specs.map((spec, i) =>
    spec.npcOrMonster === 'monster'
      ? { kind: 'monster', state: spawnMonster(data, spec.id, `${spec.id}#${i}`) }
      : { kind: 'npc', state: combatantFromNpc(data, spec.id, `${spec.id}#${i}`) },
  )

  const session: CombatSession = {
    round: 0,
    order: [],
    turnIndex: 0,
    pc,
    enemies,
    prompt: null,
    status: 'ongoing',
    nextRollBoons: 0,
  }

  let s: GameState = { ...state, screen: 'combat', combat: session }
  s = startRound(rng, s)
  return advanceCombat(rng, data, s)
}

function startRound(rng: RNG, state: GameState): GameState {
  const c = state.combat!
  const requests = [
    { combatantId: 'pc', cards: 1 },
    ...c.enemies
      .filter((e) => !isDead(e))
      .map((e) => ({
        combatantId: unitId(e),
        cards: e.kind === 'monster' ? e.state.ferocity : 1,
      })),
  ]
  const assignments = drawInitiative(rng, requests)
  const order: TurnSlot[] = assignments
    .flatMap((a) => a.cards.map((card) => ({ ownerId: a.combatantId, card, done: false })))
    .sort((a, b) => a.card - b.card)

  const enemies = c.enemies.map((e) =>
    e.kind === 'monster' ? { ...e, state: refreshMonsterRound(e.state) } : { ...e, state: { ...e.state, acted: false } },
  )

  return {
    ...state,
    combat: {
      ...c,
      round: c.round + 1,
      order,
      turnIndex: 0,
      pc: { ...c.pc, acted: false },
      enemies,
    },
  }
}

function unitId(e: EnemyUnit): string {
  return e.state.id
}

function isDead(e: EnemyUnit): boolean {
  return e.kind === 'monster' ? e.state.dead : e.state.dead
}

function livingEnemies(c: CombatSession): EnemyUnit[] {
  return c.enemies.filter((e) => !isDead(e))
}

/* ─────────────────────────── 전투: 진행 ─────────────────────────── */

/**
 * 전투를 다음 "입력 필요 시점"까지 자동 진행한다.
 * PC 턴이거나 프롬프트가 뜨면 멈춘다.
 */
export function advanceCombat(rng: RNG, data: GameData, state: GameState): GameState {
  let s = state
  let guard = 0

  while (guard++ < 200) {
    const c = s.combat
    if (!c || c.status !== 'ongoing' || c.prompt) return s

    // 승패 판정
    if (livingEnemies(c).length === 0) return endCombat(rng, data, s, 'victory')
    if (c.pc.dead) return endCombat(rng, data, s, 'defeat')

    // 라운드 종료 → 새 라운드
    if (c.turnIndex >= c.order.length) {
      s = startRound(rng, s)
      continue
    }

    const slot = c.order[c.turnIndex]!
    if (slot.done) {
      s = { ...s, combat: { ...c, turnIndex: c.turnIndex + 1 } }
      continue
    }

    if (slot.ownerId === 'pc') {
      // PC가 쓰러져 있으면 죽음 판정 자동
      if (c.pc.hp === 0 && c.pc.deathRolls) {
        const out = deathRoll(rng, c.pc)
        s = log(
          s,
          out.died ? 'bad' : out.recovered ? 'good' : 'info',
          out.died
            ? '죽음 판정 — 숨이 끊어졌다.'
            : out.recovered
              ? `죽음 판정 3성공 — 의식을 되찾았다! (HP ${out.combatant.hp})`
              : `죽음 판정 ${out.roll.natural} (성공 ${out.combatant.deathRolls?.successes ?? 0} / 실패 ${out.combatant.deathRolls?.failures ?? 0})`,
        )
        s = { ...s, combat: { ...s.combat!, pc: out.combatant } }
        s = consumeSlot(s)
        continue
      }
      return s // 플레이어 입력 대기
    }

    // 적 턴
    const enemy = c.enemies.find((e) => unitId(e) === slot.ownerId)
    if (!enemy || isDead(enemy)) {
      s = consumeSlot(s)
      continue
    }
    s = enemyTurn(rng, data, s, enemy)
    if (s.combat?.prompt) return s
    s = consumeSlot(s)
  }
  return s
}

function consumeSlot(state: GameState): GameState {
  const c = state.combat!
  const order = c.order.map((slot, i) => (i === c.turnIndex ? { ...slot, done: true } : slot))
  return { ...state, combat: { ...c, order, turnIndex: c.turnIndex + 1 } }
}

/* ─────────────────────────── 전투: 적 턴 ─────────────────────────── */

function enemyTurn(rng: RNG, data: GameData, state: GameState, enemy: EnemyUnit): GameState {
  let s = state
  const c = s.combat!

  // PC가 쓰러져 있으면 적은 관망 (초벌 AI)
  if (c.pc.hp === 0) return s

  if (enemy.kind === 'monster') {
    const { monster, pick } = rollMonsterAttack(rng, data, enemy.state)
    s = updateEnemy(s, monster.id, { kind: 'monster', state: monster })
    s = log(s, 'combat', `${monster.name}의 ${pick.attack.name}!`)

    const canDodge = pick.attack.canDodge && !c.pc.acted
    const canParry = pick.attack.canParry && !c.pc.acted && c.pc.drawnWeaponIds.length > 0

    if (canDodge || canParry) {
      return {
        ...s,
        combat: {
          ...s.combat!,
          prompt: {
            kind: 'reaction',
            enemyId: monster.id,
            monsterAttack: pick.attack,
            canDodge,
            canParry,
          },
        },
      }
    }
    return applyMonsterAttackToPc(rng, data, s, pick.attack)
  }

  // NPC 적: 근접 공격
  const npc = enemy.state
  const weaponId = npc.drawnWeaponIds[0]
  if (!weaponId) return s
  const attack = rollAttack(rng, data, npc, weaponId, { id: 'pc', prone: c.pc.prone }, {
    kind: 'melee',
    damageType: weaponOf(data, weaponId).damageTypes[0] ?? null,
  })
  if ('rejected' in attack) return s

  if (!attack.result.success && !attack.critical) {
    return log(s, 'combat', `${npc.name}의 공격 — 빗나감 (${attack.result.natural})`)
  }
  s = log(s, attack.critical ? 'crit' : 'combat', `${npc.name}의 공격이 명중${attack.critical ? ' — 크리티컬!' : ''} (${attack.result.natural})`)

  const canReact = !c.pc.acted
  if (canReact) {
    return {
      ...s,
      combat: {
        ...s.combat!,
        prompt: {
          kind: 'reaction',
          enemyId: npc.id,
          npcAttack: attack,
          canDodge: true,
          canParry: c.pc.drawnWeaponIds.length > 0,
        },
      },
    }
  }
  return applyNpcAttackToPc(rng, data, s, attack)
}

function updateEnemy(state: GameState, id: string, unit: EnemyUnit): GameState {
  const c = state.combat!
  return {
    ...state,
    combat: { ...c, enemies: c.enemies.map((e) => (unitId(e) === id ? unit : e)) },
  }
}

/* ─────────────────────────── 전투: PC 리액션 ─────────────────────────── */

export function resolveReaction(
  rng: RNG,
  data: GameData,
  state: GameState,
  choice: 'dodge' | 'parry' | 'none',
): GameState {
  const c = state.combat
  if (!c?.prompt || c.prompt.kind !== 'reaction') return state
  const prompt = c.prompt
  let s: GameState = { ...state, combat: { ...c, prompt: null } }

  // 몬스터 공격
  if (prompt.monsterAttack) {
    if (choice !== 'none') {
      const out = reactToMonsterAttack(rng, data, c.pc, prompt.monsterAttack, choice, c.pc.drawnWeaponIds[0])
      if (!('rejected' in out)) {
        s = trackMark(s, choice === 'dodge' ? 'evade' : null, out.result.dragon, out.result.demon)
        s = { ...s, combat: { ...s.combat!, pc: { ...s.combat!.pc, acted: true } } }
        markPcSlotDone(s)
        if (out.avoided) {
          s = log(s, 'good', choice === 'dodge' ? '몸을 날려 피했다!' : '무기로 받아냈다!')
          s = consumePromptSlot(s, prompt.enemyId)
          return advanceCombat(rng, data, s)
        }
        s = log(s, 'bad', choice === 'dodge' ? '피하지 못했다.' : '막지 못했다.')
      }
    }
    s = applyMonsterAttackToPc(rng, data, s, prompt.monsterAttack)
    s = consumePromptSlot(s, prompt.enemyId)
    return advanceCombat(rng, data, s)
  }

  // NPC 공격
  const attack = prompt.npcAttack!
  if (choice === 'parry') {
    const weaponId = c.pc.drawnWeaponIds[0]!
    const out = tryParry(rng, data, c.pc, attack, weaponId)
    if (!('rejected' in out)) {
      s = { ...s, combat: { ...s.combat!, pc: { ...s.combat!.pc, acted: true } } }
      markPcSlotDone(s)
      if (out.parried) {
        s = log(s, out.result.dragon ? 'crit' : 'good', out.counterattack ? '패리 — 반격의 기회!' : '패리 성공!')
        // 내구도: 패리한 피해 굴림
        const enemy = findNpc(s, prompt.enemyId)
        if (enemy) {
          const dmg = rollDamage(rng, data, enemy, attack, null)
          const dura = checkParryDurability(data, s.combat!.pc, weaponId, dmg)
          if (dura.broken) {
            s = { ...s, combat: { ...s.combat!, pc: dura.defender } }
            s = log(s, 'bad', '무기가 충격을 버티지 못하고 부서졌다!')
          }
          if (out.counterattack) {
            const counter = rollDamage(rng, data, s.combat!.pc, {
              ...attack,
              attackerId: 'pc',
              weaponId,
              context: { kind: 'melee', damageType: weaponOf(data, weaponId).damageTypes[0] ?? null },
            }, null)
            s = damageNpc(s, data, prompt.enemyId, counter.total, counter.damageType, false)
            s = log(s, 'crit', `반격 — ${counter.total} 피해!`)
          }
        }
        s = consumePromptSlot(s, prompt.enemyId)
        return advanceCombat(rng, data, s)
      }
      s = log(s, 'bad', '패리 실패.')
    }
  } else if (choice === 'dodge') {
    const out = tryDodge(rng, data, c.pc, attack)
    if (!('rejected' in out)) {
      s = trackMark(s, 'evade', out.result.dragon, out.result.demon)
      s = { ...s, combat: { ...s.combat!, pc: { ...s.combat!.pc, acted: true } } }
      markPcSlotDone(s)
      if (out.dodged) {
        s = log(s, 'good', '몸을 날려 피했다!')
        s = consumePromptSlot(s, prompt.enemyId)
        return advanceCombat(rng, data, s)
      }
      s = log(s, 'bad', '피하지 못했다.')
    }
  }

  s = applyNpcAttackToPc(rng, data, s, attack)
  s = consumePromptSlot(s, prompt.enemyId)
  return advanceCombat(rng, data, s)
}

/** PC 리액션으로 카드가 뒤집힘 — order 에서 PC 슬롯 done 처리 */
function markPcSlotDone(state: GameState): void {
  const c = state.combat!
  const idx = c.order.findIndex((slot) => slot.ownerId === 'pc' && !slot.done)
  if (idx >= 0) c.order = c.order.map((slot, i) => (i === idx ? { ...slot, done: true } : slot))
}

function consumePromptSlot(state: GameState, _enemyId: string): GameState {
  // 적 턴은 enemyTurn 종료 후 advanceCombat 루프의 consumeSlot 이 처리하지만,
  // 프롬프트 경유 시 여기서 소비한다.
  return consumeSlot(state)
}

function findNpc(state: GameState, id: string): Combatant | null {
  const e = state.combat!.enemies.find((x) => unitId(x) === id)
  return e && e.kind === 'npc' ? e.state : null
}

/* ─────────────────────────── 전투: 피해 적용 ─────────────────────────── */

function applyMonsterAttackToPc(rng: RNG, data: GameData, state: GameState, attack: MonsterAttack): GameState {
  let s = state
  const c = s.combat!
  const pcArmor = armorRatingOfPc(data, c.pc)

  const result = applyEffects(rng, data, attack.effects, vitalsOf(s.character), {
    armorRating: pcArmor,
    maxHp: maxHp(data, s.character),
    maxWp: maxWp(data, s.character),
  })

  // Vitals → character + combat pc 동기화
  s = { ...s, character: withVitals(s.character, result.target) }
  let pc = { ...c.pc, hp: result.target.hp, conditions: [...result.target.conditions] }

  for (const a of result.applied) {
    if (a.hook === 'damage' || a.hook === 'knockback') s = log(s, 'bad', a.detail)
    else if (a.hook === 'fearAttack') s = log(s, a.detail.includes('저항') ? 'good' : 'bad', a.detail)
    else s = log(s, 'info', a.detail)
  }
  for (const d of result.directives) {
    if (d.kind === 'knockback' && d.params['prone']) pc = { ...pc, prone: true }
  }
  for (const m of result.manual) {
    void m
    s = log(s, 'info', `(수동 효과) ${attack.description}`)
  }

  // 0 HP 처리
  if (pc.hp === 0 && !pc.deathRolls && !pc.dead) {
    const overkill = 0 // applyEffects 는 초과 피해를 추적하지 않음 — 즉사는 미적용 (해석 기록)
    void overkill
    pc = { ...pc, prone: true, deathRolls: { successes: 0, failures: 0 } }
    s = log(s, 'bad', '쓰러졌다! 죽음의 문턱에서 버텨야 한다.')
  }

  return { ...s, combat: { ...s.combat!, pc } }
}

function armorRatingOfPc(data: GameData, pc: Combatant): number {
  let total = 0
  for (const id of [pc.armorId, pc.helmetId]) {
    if (!id) continue
    total += data.armor.find((a) => a.id === id)?.rating ?? 0
  }
  return total
}

function applyNpcAttackToPc(rng: RNG, data: GameData, state: GameState, attack: AttackRoll): GameState {
  let s = state
  const c = s.combat!
  const npc = findNpc(s, attack.attackerId)
  if (!npc) return s

  const dmg = rollDamage(rng, data, npc, attack, attack.critical ? 'doubleDice' : null)
  const applied = applyDamage(data, c.pc, dmg, { melee: true })
  s = log(s, 'bad', `${dmg.total} 피해 (방어구 ${applied.absorbed} 흡수 → HP ${applied.defender.hp})`)
  if (applied.droppedToZero) s = log(s, 'bad', '쓰러졌다! 죽음의 문턱에서 버텨야 한다.')
  if (applied.instantDeath) s = log(s, 'bad', '치명상 — 즉사.')

  s = {
    ...s,
    character: { ...s.character, hp: applied.defender.hp },
    combat: { ...c, pc: applied.defender },
  }
  return s
}

/* ─────────────────────────── 전투: PC 행동 ─────────────────────────── */

export function pcAttack(
  rng: RNG,
  data: GameData,
  state: GameState,
  weaponId: string,
  targetId: string,
  damageType: DamageType | null,
): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  const enemy = c.enemies.find((e) => unitId(e) === targetId)
  if (!enemy || isDead(enemy)) return state

  const targetProne = enemy.kind === 'monster' ? enemy.state.prone : enemy.state.prone
  const attack = rollAttack(rng, data, c.pc, weaponId, { id: targetId, prone: targetProne }, {
    kind: 'melee',
    damageType,
    extra: { boons: c.nextRollBoons },
  })
  let s: GameState = { ...state, combat: { ...c, nextRollBoons: 0 } }
  if ('rejected' in attack) return log(s, 'info', `공격 불가: ${attack.rejected}`)

  const weapon = weaponOf(data, weaponId)
  s = trackMark(s, weapon.skillId, attack.result.dragon, attack.result.demon)

  if (attack.result.demon) {
    s = log(s, 'bad', `대실패!${attack.mishap ? ` ${attack.mishap.name} — ${attack.mishap.description}` : ''}`)
    if (attack.mishap?.name === '무기 손상') {
      s = { ...s, combat: { ...s.combat!, pc: { ...s.combat!.pc, damagedWeaponIds: [...s.combat!.pc.damagedWeaponIds, weaponId] } } }
    }
    return finishPcAction(rng, data, s)
  }
  if (!attack.result.success) {
    s = log(s, 'combat', `공격 빗나감 (${attack.result.natural})`)
    return finishPcAction(rng, data, s)
  }

  if (attack.critical) {
    // 크리티컬 선택 프롬프트
    const choices: CriticalChoice[] = ['doubleDice', 'extraAttack']
    if (damageType === 'piercing' && data.config.damageTypes) choices.push('ignoreArmor')
    return {
      ...log(s, 'crit', `크리티컬! (${attack.result.natural})`),
      combat: { ...s.combat!, prompt: { kind: 'critical', attack, enemyId: targetId, choices } },
    }
  }

  s = log(s, 'combat', `명중 (${attack.result.natural})`)
  s = dealPcDamage(rng, data, s, attack, targetId, null)
  return finishPcAction(rng, data, s)
}

export function resolveCritical(
  rng: RNG,
  data: GameData,
  state: GameState,
  choice: CriticalChoice,
): GameState {
  const c = state.combat
  if (!c?.prompt || c.prompt.kind !== 'critical') return state
  const { attack, enemyId } = c.prompt
  let s: GameState = { ...state, combat: { ...c, prompt: null } }

  s = dealPcDamage(rng, data, s, attack, enemyId, choice === 'extraAttack' ? null : choice)
  if (choice === 'extraAttack') {
    s = log(s, 'good', '크리티컬 — 여세를 몰아 한 번 더 공격할 수 있다!')
    // 추가 공격은 같은 턴에 무료 — 턴을 소비하지 않고 대기
    return s
  }
  return finishPcAction(rng, data, s)
}

function dealPcDamage(
  rng: RNG,
  data: GameData,
  state: GameState,
  attack: AttackRoll,
  targetId: string,
  critical: CriticalChoice | null,
): GameState {
  let s = state
  const c = s.combat!
  const enemy = c.enemies.find((e) => unitId(e) === targetId)
  if (!enemy) return s

  // 몬스터의 회피/패리 (AI: 체력이 절반 이하로 몰렸을 때만 행동을 소모해 회피)
  if (enemy.kind === 'monster' && enemy.state.actionsLeft > 0 && enemy.state.hp <= enemy.state.maxHp / 2) {
    const def = monsterDefense(rng, data, enemy.state, attack, 'dodge')
    if (!('rejected' in def)) {
      s = updateEnemy(s, targetId, { kind: 'monster', state: def.monster })
      if (def.avoided) {
        return log(s, 'combat', `${enemy.state.name}이(가) 몸을 틀어 피했다.`)
      }
    }
  }
  // NPC의 패리 (AI: 체력이 절반 이하일 때만 턴을 소모해 패리)
  if (enemy.kind === 'npc' && !enemy.state.acted && enemy.state.drawnWeaponIds.length > 0 && enemy.state.hp <= enemy.state.maxHp / 2) {
    const parry = tryParry(rng, data, enemy.state, attack, enemy.state.drawnWeaponIds[0]!)
    if (!('rejected' in parry)) {
      s = updateEnemy(s, targetId, { kind: 'npc', state: { ...enemy.state, acted: true } })
      if (parry.parried) {
        return log(s, 'combat', `${enemy.state.name}이(가) 받아넘겼다.`)
      }
    }
  }

  const dmg = rollDamage(rng, data, c.pc, attack, critical)
  return damageEnemyUnit(s, data, targetId, dmg.total, dmg.damageType, dmg.ignoreArmor)
}

function damageEnemyUnit(
  state: GameState,
  data: GameData,
  targetId: string,
  total: number,
  damageType: DamageType | null,
  ignoreArmor: boolean,
): GameState {
  const enemy = state.combat!.enemies.find((e) => unitId(e) === targetId)
  if (!enemy) return state

  if (enemy.kind === 'monster') {
    const out = applyDamageToMonster(data, enemy.state, { total, damageType, ignoreArmor })
    let s = updateEnemy(state, targetId, { kind: 'monster', state: out.monster })
    if (out.immune) return log(s, 'info', `${enemy.state.name}에게는 통하지 않는다! (면역)`)
    s = log(
      s,
      'combat',
      `${enemy.state.name}에게 ${out.taken} 피해${out.resisted ? ' (저항 — 절반)' : ''}${out.absorbed ? ` (방어 ${out.absorbed} 흡수)` : ''}`,
    )
    if (out.monster.dead) s = log(s, 'good', `${enemy.state.name}을(를) 쓰러뜨렸다!`)
    return s
  }
  return damageNpc(state, data, targetId, total, damageType, ignoreArmor)
}

function damageNpc(
  state: GameState,
  data: GameData,
  targetId: string,
  total: number,
  damageType: DamageType | null,
  ignoreArmor: boolean,
): GameState {
  const enemy = state.combat!.enemies.find((e) => unitId(e) === targetId)
  if (!enemy || enemy.kind !== 'npc') return state
  const applied = applyDamage(data, enemy.state, {
    total,
    weaponDice: [],
    bonusDice: [],
    ignoreArmor,
    damageType,
    breakdown: String(total),
  }, { melee: true })
  let s = updateEnemy(state, targetId, { kind: 'npc', state: applied.defender })
  s = log(s, 'combat', `${enemy.state.name}에게 ${applied.taken} 피해${applied.absorbed ? ` (방어 ${applied.absorbed} 흡수)` : ''}`)
  if (applied.defender.dead) s = log(s, 'good', `${enemy.state.name}을(를) 쓰러뜨렸다!`)
  return s
}

/** 넘어뜨리기 특수 공격 */
export function pcTopple(rng: RNG, data: GameData, state: GameState, weaponId: string, targetId: string): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  const enemy = c.enemies.find((e) => unitId(e) === targetId)
  if (!enemy || isDead(enemy)) return state

  let s = state
  if (enemy.kind === 'monster') {
    const out = toppleMonster(rng, data, c.pc, weaponId, enemy.state)
    s = updateEnemy(s, targetId, { kind: 'monster', state: out.monster })
    s = log(s, out.success ? 'good' : 'combat', out.success ? `${enemy.state.name}을(를) 넘어뜨렸다!` : '넘어뜨리지 못했다.')
  } else {
    const out = trySpecialTopple(rng, data, c.pc, weaponId, enemy.state)
    s = updateEnemy(s, targetId, { kind: 'npc', state: out.defender })
    s = log(s, out.success ? 'good' : 'combat', out.success ? `${enemy.state.name}을(를) 넘어뜨렸다!` : '넘어뜨리지 못했다.')
  }
  return finishPcAction(rng, data, s)
}

/** 주문 시전 (전투) */
export function pcCastSpell(
  rng: RNG,
  data: GameData,
  state: GameState,
  spellId: string,
  powerLevel: number,
  targetId: string | 'self',
): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state

  const spell = spellOf(data, spellId)
  const caster = {
    wp: state.character.wp,
    conditions: state.character.conditions,
    skillLevels: state.character.skillLevels,
    knownSpellIds: state.character.knownSpellIds,
    preparedSpellIds: state.character.preparedSpellIds,
    armorIds: [state.character.armorId, state.character.helmetId].filter(Boolean) as string[],
    atHandIds: c.pc.weaponsAtHand,
  }

  const out = castSpell(rng, data, caster, { spellId, powerLevel, available: { word: true, gesture: true, focus: true, ingredient: true } })
  let s = state
  if ('rejected' in out) return log(s, 'info', `시전 불가: ${out.rejected}`)

  // WP 소모
  s = { ...s, character: { ...s.character, wp: s.character.wp - out.wpSpent } }
  const magicSkill = spell.school === 'general' ? Object.keys(s.character.skillLevels).find((id) => data.skills.some((k) => k.id === id && k.kind === 'magic')) : spell.school
  if (out.roll) s = trackMark(s, magicSkill ?? null, out.roll.dragon, out.roll.demon)

  if (!out.success) {
    s = log(s, 'bad', `${spell.name} 시전 실패 (WP -${out.wpSpent})`)
    if (out.mishap) s = log(s, 'bad', `마법 사고 — ${out.mishap.name}: ${out.mishap.description}`)
    return finishPcAction(rng, data, s)
  }

  s = log(s, out.dragon ? 'crit' : 'good', `${spell.name} 시전 성공${out.dragon ? ' — 용!' : ''} (WP -${out.wpSpent})`)

  if (isHealingSpell(spell)) {
    const heal = rollSpellDice(rng, spell, powerLevel, 'heal')
    if (heal) {
      const amount = out.dragon ? heal.total * 2 : heal.total
      const hp = Math.min(maxHp(data, s.character), s.character.hp + amount)
      s = { ...s, character: { ...s.character, hp }, combat: { ...s.combat!, pc: { ...s.combat!.pc, hp } } }
      s = log(s, 'good', `HP ${amount} 회복 (${hp})`)
    }
  } else if (targetId !== 'self') {
    const dmg = rollSpellDice(rng, spell, powerLevel, 'damage')
    if (dmg) {
      const total = out.dragon ? dmg.total * 2 : dmg.total
      s = damageEnemyUnit(s, data, targetId, total, null, dmg.ignoreArmor)
    }
  }
  return finishPcAction(rng, data, s)
}

/** 능력 발동 (보온 부여형) */
export function pcActivateAbility(rng: RNG, data: GameData, state: GameState, abilityId: string): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  const ability = data.abilities.find((a) => a.id === abilityId)
  if (!ability || !state.character.abilities[abilityId]) return state
  const cost = ability.wpCost === 'varies' ? 1 : ability.wpCost
  if (state.character.wp < cost) return log(state, 'info', 'WP가 부족하다.')

  let s: GameState = { ...state, character: { ...state.character, wp: state.character.wp - cost } }
  const result = applyEffects(rng, data, ability.effects, vitalsOf(s.character), {
    maxHp: maxHp(data, s.character),
    maxWp: maxWp(data, s.character),
  })
  s = { ...s, character: withVitals(s.character, result.target) }
  s = {
    ...s,
    combat: {
      ...s.combat!,
      pc: { ...s.combat!.pc, conditions: [...result.target.conditions], hp: result.target.hp },
      nextRollBoons: s.combat!.nextRollBoons + (result.rollModifiers.boons ?? 0),
    },
  }
  s = log(s, 'good', `${ability.name} 발동 (WP -${cost})`)
  return s // 자유 발동 — 턴 소모 없음 (activation free 기준)
}

/** 자기 소생 시도 (0 HP, WIL 베인) */
export function pcSelfRally(rng: RNG, data: GameData, state: GameState): GameState {
  const c = state.combat
  if (!c || c.pc.hp !== 0 || !c.pc.deathRolls) return state
  const result = rollD20(rng, state.character.attributes.wil, gatherMods(data, c.pc, '', { banes: 1 }))
  let s = state
  if (result.success) {
    s = log(s, 'good', '이를 악물고 정신을 붙든다 — 쓰러진 채 행동할 수 있다.')
    // 간이 처리: 랠리 성공 시 이번 턴 행동 가능 상태로만 표시
  } else {
    s = log(s, 'bad', '의식이 흐려진다…')
  }
  return finishPcAction(rng, data, s)
}

/** 도주 — 회피 판정. 성공하면 전투에서 이탈한다 (원문: EVADE 로 전투 이탈). */
export function pcFlee(rng: RNG, data: GameData, state: GameState): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  const mods = gatherMods(data, c.pc, 'evade')
  const result = rollD20(rng, c.pc.skills['evade'] ?? 0, mods)
  let s = trackMark(state, 'evade', result.dragon, result.demon)
  if (result.success) {
    s = log(s, 'good', '몸을 빼 어둠 속으로 달아났다!')
    s = {
      ...s,
      character: { ...s.character, hp: c.pc.hp, conditions: [...c.pc.conditions] },
      combat: null,
      screen: s.shiftsTraveledToday >= 2 ? 'evening' : 'journey',
    }
    return s
  }
  s = log(s, 'bad', '도주 실패 — 퇴로가 막혔다.')
  return finishPcAction(rng, data, s)
}

/** 턴 넘기기 */
export function pcPass(rng: RNG, data: GameData, state: GameState): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  return finishPcAction(rng, data, log(state, 'info', '경계하며 자세를 잡는다.'))
}

function finishPcAction(rng: RNG, data: GameData, state: GameState): GameState {
  let s: GameState = {
    ...state,
    combat: { ...state.combat!, pc: { ...state.combat!.pc, acted: true } },
  }
  s = consumeSlot(s)
  return advanceCombat(rng, data, s)
}

/* ─────────────────────────── 전투 종료 ─────────────────────────── */

function endCombat(rng: RNG, data: GameData, state: GameState, result: 'victory' | 'defeat'): GameState {
  void rng
  void data
  const c = state.combat!
  let s: GameState = {
    ...state,
    character: {
      ...state.character,
      hp: c.pc.hp,
      conditions: [...c.pc.conditions],
    },
    combat: { ...c, status: result },
  }

  if (result === 'defeat') {
    return { ...log(s, 'bad', '패배 — 어둠이 내려앉는다.'), screen: 'dead' }
  }

  s = log(s, 'good', '전투 승리!')
  const wasBoss = c.enemies.some((e) => e.kind === 'monster' && e.state.monsterId === 'stonehide')
  if (wasBoss) {
    s = { ...s, bossDefeated: true }
    return { ...log(s, 'system', '파수탑의 수호자가 쓰러졌다. 임무 완수!'), screen: 'cleared', combat: null }
  }
  return { ...s, screen: state.shiftsTraveledToday >= 2 ? 'evening' : 'journey', combat: null }
}

/* ─────────────────────────── 정산 ─────────────────────────── */

/** 모험 종료(클리어/사망) 후: 세션 질문 답 수만큼 자유 마크 + 성장 굴림 */
export function runDebrief(rng: RNG, state: GameState, extraMarkSkillIds: string[]): GameState {
  let character = state.character
  for (const id of extraMarkSkillIds) character = markAdvancement(character, id)
  const { character: after, results } = resolveAdvancement(rng, character)
  let s: GameState = { ...state, character: after, debrief: results, screen: 'debrief' }
  for (const r of results) {
    s = log(s, r.improved ? 'good' : 'info', `${r.skillId}: D20=${r.roll} → ${r.improved ? `레벨 ${r.after}` : '변화 없음'}`)
  }
  return s
}
