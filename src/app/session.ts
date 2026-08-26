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
import { baseChance, encumbrance, maxHp, maxWp, movementOf, resolveAdvancement, markAdvancement } from '../system/character'
import type { AdvancementRollResult } from '../system/character'
import type { Combatant } from '../system/combatant'
import { combatantFromAnimal, combatantFromCharacter, combatantFromNpc, weaponOf } from '../system/combatant'
import type { AttackRoll, CriticalChoice } from '../system/combat'
import {
  applyDamage,
  canSwapInitiative,
  deathRoll,
  drawInitiative,
  effectiveRange,
  rangedDistanceState,
  rollAttack,
  rollDamage,
  tryBreakFree,
  tryDodge,
  tryParry,
  trySpecialDisarm,
  trySpecialGrapple,
  trySpecialTopple,
  checkParryDurability,
  findWeakSpotContext,
  weaponReach,
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
import { applyEffects, hasAbilityHook } from '../system/effects'
import type { Vitals, RestUsage } from '../system/hazards'
import {
  FRESH_REST_USAGE,
  coldExposureFailure,
  rollSevereInjury,
  stretchRest,
  shiftRest,
  sufferCondition,
  starvationDailyTick,
} from '../system/hazards'
import { stretchRestBonus } from '../system/effects'
import { pathfind, makeCamp, hunt, fish, forcedMarch, KM_PER_SHIFT_FOOT } from '../system/journey'
import { castSpell, prepareSpells, rollSpellDice, isHealingSpell, spellOf } from '../system/magic'
import { conditionBanes, rollD20 } from '../system/roll'
import { gatherMods } from '../system/combat'
import { roll as rollDice, rollWithExtraDice } from '../system/dice'

export const JOURNEY_TOTAL_KM = 60

/* ─────────────────────────── 로그 ─────────────────────────── */

export interface LogEntry {
  id: number
  kind: 'system' | 'good' | 'bad' | 'info' | 'combat' | 'crit'
  text: string
}

/* ─────────────────────────── 전투 세션 ─────────────────────────── */

export type EnemyUnit =
  | { kind: 'monster'; state: MonsterCombatant; distance: number }
  | { kind: 'npc'; state: Combatant; distance: number }

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
  | {
      kind: 'ambush' // 전투 개시 전 — 몰래 접근할 것인가
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
  /** 무장 해제로 땅에 떨어진 무기 (unitId → weaponId[]). 줍기는 액션 */
  droppedWeapons: Record<string, string[]>
  /** PC가 붙잡고 있는 적 (붙잡기 특수 공격) */
  grappledEnemyId: string | null
  /** 이번 라운드에 이미 대기(카드 교환)했는가 */
  pcWaited: boolean
  /** 잠입 성공 — 다음 PC 공격이 암습(보온, 리액션 불가, subtle +1주사위) */
  sneakPending: boolean
  /** 이번 라운드에 무기 바꿔 들기(자유 행동)를 썼는가 */
  drewWeaponThisRound: boolean
  /** 사냥감 전투 — 승리 시 얻는 식량 주사위 */
  preyRations: string | null
  /** 사고로 떨어뜨린 PC 무기 (줍기는 액션) */
  pcDroppedWeaponIds: string[]
  /** 화살이 떨어진 무기 (이번 전투 동안 사용 불가) */
  outOfAmmoWeaponIds: string[]
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
  /** 기념품 효과 사용 여부 (모험당 1회 — 잠정 해석) */
  mementoUsed: boolean
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
    mementoUsed: false,
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

  // 이미 도착한 상태 → 결전 (PC 주도 개전 — 잠입 여부를 물을 수 있다)
  if (s.kmTraveled >= JOURNEY_TOTAL_KM && !s.bossDefeated) {
    s = log(s, 'system', '무너진 문 틈으로 홀 안이 보인다 — 수호자는 아직 이쪽을 모른다.')
    return beginCombat(rng, data, s, [{ npcOrMonster: 'monster', id: 'stonehide', distance: 10 }], { ambushOption: true })
  }

  // 과적: 시프트 도보 이동마다 근력 판정 — 실패하면 이번 시프트는 제자리
  {
    const enc = encumbrance(data, s.character)
    if (enc.overEncumbered) {
      const banes = conditionBanes(new Set(s.character.conditions), 'str')
      const strRoll = rollD20(rng, s.character.attributes.str, { banes })
      if (!strRoll.success) {
        s = log(s, 'bad', `과적 (${enc.carried}/${enc.limit}) — 짐에 눌려 나아가지 못했다. 짐을 줄이거나 버텨야 한다.`)
        s = { ...s, shiftsTraveledToday: s.shiftsTraveledToday + 1 }
        if (s.shiftsTraveledToday >= 2 || forced) return { ...s, screen: 'evening' }
        return s
      }
      s = log(s, 'info', `과적 (${enc.carried}/${enc.limit}) — 근력으로 버티며 나아간다.`)
    }
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
  }, { hasMap: hasItem(s.character, 'map') })
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
    s = applyJourneyMishap(rng, data, s, pf.mishap)
    if (s.screen === 'dead' || s.screen === 'combat') return s
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
    // 매복 — 정황 판정(주의력)에 실패하면 적이 1라운드 카드를 고른다 (기습)
    const aware = rollD20(rng, s.character.skillLevels['awareness'] ?? 0, {
      banes: conditionBanes(new Set(s.character.conditions), 'int'),
    })
    s = trackMark(s, 'awareness', aware.dragon, aware.demon)
    if (aware.success) {
      s = log(s, 'bad', '수풀의 기척을 먼저 알아챘다 — 약탈자다!')
      return beginCombat(rng, data, s, [{ npcOrMonster: 'npc', id: 'raider', distance: 6 }])
    }
    s = log(s, 'bad', '수풀 너머에서 약탈자가 튀어나온다 — 허를 찔렸다!')
    return beginCombat(rng, data, s, [{ npcOrMonster: 'npc', id: 'raider', distance: 4 }], { surprise: 'enemies' })
  }

  // 하루 이동 한계 → 저녁
  if (s.shiftsTraveledToday >= 2 && !forced) {
    return { ...s, screen: 'evening' }
  }
  if (forced) return { ...s, screen: 'evening' }
  return s
}

function applyJourneyMishap(rng: RNG, data: GameData, state: GameState, row: RollTableRow): GameState {
  let s = state
  const dmgNotation = row.extra?.['damage'] as string | undefined
  if (dmgNotation) {
    // 간이 처리: 회피류 판정 대신 EVADE 판정 1회 (실패 시 피해)
    const evade = rollD20(rng, s.character.skillLevels['evade'] ?? 0)
    s = trackMark(s, 'evade', evade.dragon, evade.demon)
    if (!evade.success) {
      let dmg = rollDice(rng, dmgNotation).total
      const boots = row.extra?.['bootsReduce'] as number | undefined
      if (boots && hasItem(s.character, 'boots')) {
        dmg = Math.max(0, dmg - boots)
        s = log(s, 'info', `장화가 충격을 ${boots} 줄였다.`)
      }
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
  // 망토가 있으면 무효인 상태이상 (벌레 떼 등)
  const cond = row.extra?.['conditionWithoutCloak'] as ConditionId | undefined
  if (cond) {
    if (hasItem(s.character, 'cloak')) {
      s = log(s, 'info', `${row.name} — 망토 덕에 견뎠다.`)
    } else {
      const suffered = sufferCondition(rng, vitalsOf(s.character), cond)
      s = { ...s, character: withVitals(s.character, suffered.vitals) }
      if (suffered.gained) s = log(s, 'bad', `${row.name} — 상태이상`)
    }
  }
  // 폭우 등 — 망토 없으면 추위 판정 (모피 외투 보온)
  if (row.extra?.['coldWithoutCloak'] === true && !hasItem(s.character, 'cloak')) {
    const boons = hasItem(s.character, 'fur-coat') ? 1 : 0
    const cold = rollD20(rng, s.character.attributes.con, { boons })
    if (!cold.success) {
      const out = coldExposureFailure(rng, vitalsOf(s.character))
      s = { ...s, character: withVitals(s.character, out.vitals) }
      s = log(s, 'bad', `추위가 뼛속까지 스민다 — HP -${out.hpLost}, WP -${out.wpLost}`)
      if (s.character.hp === 0) {
        return { ...log(s, 'bad', '차가운 비 속에 쓰러졌다…'), screen: 'dead' }
      }
    } else {
      s = log(s, 'info', '비바람을 버텨냈다.')
    }
  }
  // 사나운 짐승 — 동물 표에서 스폰
  const beasts = row.extra?.['animalEncounter'] as string[] | undefined
  if (beasts && beasts.length > 0) {
    const pick = beasts[Math.floor(rng.next() * beasts.length)]!
    s = log(s, 'bad', '수풀이 갈라진다 — 들짐승이다!')
    return beginCombat(rng, data, s, [{ npcOrMonster: 'animal', id: pick, distance: 6 }])
  }
  return s
}

/* ─────────────────────────── 저녁·야간 ─────────────────────────── */

export function eveningHunt(rng: RNG, data: GameData, state: GameState): GameState {
  if (state.screen !== 'evening') return state
  const weapon = state.character.weaponsAtHand
    .map((id) => weaponOf(data, id))
    .find((w) => w.category !== 'shield')
  const hasTrap = hasItem(state.character, 'snare') || hasItem(state.character, 'bear-trap')
  if (!weapon && !hasTrap) {
    return log(state, 'info', '사냥 도구가 없다 — 무기나 덫(올가미·곰덫)이 필요하다.')
  }
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
    // 멧돼지 — 동물 스탯으로 전투. 이기면 고기(사냥감표 수확)를 얻는다.
    const rationDice = String(out.animal?.extra?.['rations'] ?? '2D6')
    return beginCombat(rng, data, s, [{ npcOrMonster: 'animal', id: 'boar', distance: 4 }], { preyRations: rationDice })
  } else {
    s = log(s, 'info', '사냥은 빈손으로 끝났다.')
  }
  return nightPhase(rng, data, s)
}

/** 낚시 (저녁 시프트) — 낚싯대 D4 / 그물 D6 식량. 도구가 있어야 한다. */
export function eveningFish(rng: RNG, data: GameData, state: GameState): GameState {
  if (state.screen !== 'evening') return state
  const hasNet = hasItem(state.character, 'fishing-net')
  const hasRod = hasItem(state.character, 'fishing-rod')
  if (!hasNet && !hasRod) return log(state, 'info', '낚시 도구가 없다 — 낚싯대나 그물이 필요하다.')
  const out = fish(rng, data, {
    skillLevels: state.character.skillLevels,
    conditions: state.character.conditions,
  }, hasNet ? 'net' : 'rod')
  let s = trackMark(state, 'hunting-fishing', out.roll.dragon, out.roll.demon)
  if (out.rations > 0) {
    s = { ...s, rations: s.rations + out.rations }
    s = log(s, 'good', `낚시 성공 — 식량 +${out.rations} (총 ${s.rations})`)
  } else {
    s = log(s, 'info', '입질이 없었다.')
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
    // 기념품: 스트레치 휴식 시 상태이상 1개 추가 회복 (세션당 1회 — 모험당 1회로 잠정 처리)
    if (
      data.config.mementos &&
      s.character.mementoId !== null &&
      !s.mementoUsed &&
      s.character.conditions.length > 0
    ) {
      s = {
        ...s,
        character: { ...s.character, conditions: s.character.conditions.slice(1) },
        mementoUsed: true,
      }
      s = log(s, 'good', '기념품을 매만지며 마음을 다잡는다 — 상태이상 1개 추가 회복 (모험당 1회)')
    }
  }
  return nightPhase(rng, data, s)
}

export function eveningSkip(rng: RNG, data: GameData, state: GameState): GameState {
  if (state.screen !== 'evening') return state
  return nightPhase(rng, data, state)
}

/** 준비 주문 한도 = INT 기본치 */
export function preparedSpellLimit(data: GameData, character: Character): number {
  return baseChance(data, character.attributes.int)
}

/**
 * 저녁: 준비 주문 교체 — 그리무아를 펴고 한 시프트를 쓴다 (저녁 활동 소모).
 * 한도 = INT 기본치. 그리무아가 있어야 한다.
 */
export function eveningPrepareSpells(rng: RNG, data: GameData, state: GameState, spellIds: string[]): GameState {
  if (state.screen !== 'evening') return state
  if (!hasItem(state.character, 'grimoire')) {
    return log(state, 'info', '그리무아가 없다 — 준비 주문을 바꿀 수 없다.')
  }
  const limit = preparedSpellLimit(data, state.character)
  const caster = casterViewOf(state)
  const out = prepareSpells(data, caster, spellIds, limit)
  if ('rejected' in out) {
    return log(state, 'info',
      out.rejected === 'over-limit' ? `준비 한도 초과 — 최대 ${limit}개.`
      : out.rejected === 'trick' ? '트릭은 준비할 필요가 없다.'
      : `모르는 주문: ${out.offending}`)
  }
  let s: GameState = { ...state, character: { ...state.character, preparedSpellIds: out.preparedSpellIds } }
  s = log(s, 'good', `그리무아를 펴고 주문을 준비했다. (${out.preparedSpellIds.length}/${limit})`)
  return nightPhase(rng, data, s)
}

/**
 * 저녁: 비전투 시전 — 준비된 주문은 그대로, 미준비 주문은 그리무아에서 (시간 ×2).
 * 치유 주문은 실제로 회복하고, 그 외에는 효과 요약만 기록한다 (수동 적용).
 * 저녁 활동을 소모한다.
 */
export function eveningCastSpell(
  rng: RNG,
  data: GameData,
  state: GameState,
  spellId: string,
  powerLevel: number,
): GameState {
  if (state.screen !== 'evening') return state
  const spell = spellOf(data, spellId)
  const prepared = spell.kind === 'trick' || state.character.preparedSpellIds.includes(spellId)
  if (!prepared && !hasItem(state.character, 'grimoire')) {
    return log(state, 'info', '미준비 주문은 그리무아가 있어야 시전할 수 있다.')
  }

  const caster = casterViewOf(state)
  const out = castSpell(rng, data, caster, {
    spellId,
    powerLevel,
    fromGrimoire: !prepared,
    available: { word: true, gesture: true, focus: true, ingredient: true },
  })
  if ('rejected' in out) return log(state, 'info', `시전 불가: ${out.rejected}`)

  let s: GameState = { ...state, character: { ...state.character, wp: state.character.wp - out.wpSpent } }
  const magicSkill = spell.school === 'general'
    ? Object.keys(s.character.skillLevels).find((id) => data.skills.some((k) => k.id === id && k.kind === 'magic'))
    : spell.school
  if (out.roll) s = trackMark(s, magicSkill ?? null, out.roll.dragon, out.roll.demon)

  if (!out.success) {
    s = log(s, 'bad', `${spell.name} 시전 실패 (WP -${out.wpSpent})`)
    if (out.mishap) s = log(s, 'bad', `마법 사고 — ${out.mishap.name}: ${out.mishap.description}`)
    return nightPhase(rng, data, s)
  }

  s = log(s, out.dragon ? 'crit' : 'good',
    `${spell.name} 시전 성공${!prepared ? ' (그리무아 — 시간 ×2)' : ''}${out.dragon ? ' — 용!' : ''} (WP -${out.wpSpent})`)

  if (isHealingSpell(spell)) {
    const heal = rollSpellDice(rng, spell, powerLevel, 'heal')
    if (heal) {
      const amount = out.dragon ? heal.total * 2 : heal.total
      const hp = Math.min(maxHp(data, s.character), s.character.hp + amount)
      s = { ...s, character: { ...s.character, hp } }
      s = log(s, 'good', `HP ${amount} 회복 (${hp})`)
    }
  } else {
    s = log(s, 'info', `(비전투 시전) ${spell.description || '효과는 수동 적용.'}`)
  }
  return nightPhase(rng, data, s)
}

/** Character → CasterState 뷰 (비전투: 손에 든 것 전부) */
function casterViewOf(state: GameState) {
  return {
    wp: state.character.wp,
    conditions: state.character.conditions,
    skillLevels: state.character.skillLevels,
    knownSpellIds: state.character.knownSpellIds,
    preparedSpellIds: state.character.preparedSpellIds,
    armorIds: [state.character.armorId, state.character.helmetId].filter(Boolean) as string[],
    atHandIds: [...state.character.weaponsAtHand],
  }
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

  // 야영 + 수면 (병참 장교·외로운 늑대: 야영 자동 성공)
  const autoCamp = !skipCamp && pcHasHook(data, s, 'autoActivity', { activity: 'camp' })
  const camp = skipCamp
    ? { success: false }
    : autoCamp
      ? { success: true }
      : makeCamp(rng, data, {
          skillLevels: s.character.skillLevels,
          conditions: s.character.conditions,
        }, {
          hasSleepingFur: hasItem(s.character, 'sleeping-fur'),
          usingTent: hasItem(s.character, 'tent-small') || hasItem(s.character, 'tent-large'),
        })
  if (autoCamp) s = log(s, 'info', '손에 익은 솜씨로 자리를 편다 — 야영 자동 성공.')

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
  npcOrMonster: 'npc' | 'monster' | 'animal'
  id: string
  /** 개전 시 거리(m). 기본 2 (이미 교전 거리) */
  distance?: number
}

interface BeginCombatOptions {
  /** PC가 상황을 주도하는 개전 — 잠입(암습) 선택 프롬프트를 띄운다 */
  ambushOption?: boolean
  /** 1라운드 기습: 어느 쪽이 카드를 고르는가 */
  surprise?: 'pc' | 'enemies' | null
  /** 사냥감 전투 — 승리 시 식량 주사위 */
  preyRations?: string
}

export function beginCombat(
  rng: RNG,
  data: GameData,
  state: GameState,
  specs: EnemySpec[],
  options: BeginCombatOptions = {},
): GameState {
  const pc = combatantFromCharacter(data, state.character)
  const enemies: EnemyUnit[] = specs.map((spec, i) =>
    spec.npcOrMonster === 'monster'
      ? { kind: 'monster', state: spawnMonster(data, spec.id, `${spec.id}#${i}`), distance: spec.distance ?? 2 }
      : spec.npcOrMonster === 'animal'
        ? { kind: 'npc', state: combatantFromAnimal(data, spec.id, `${spec.id}#${i}`), distance: spec.distance ?? 2 }
        : { kind: 'npc', state: combatantFromNpc(data, spec.id, `${spec.id}#${i}`), distance: spec.distance ?? 2 },
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
    droppedWeapons: {},
    grappledEnemyId: null,
    pcWaited: false,
    sneakPending: false,
    drewWeaponThisRound: false,
    preyRations: options.preyRations ?? null,
    pcDroppedWeaponIds: [],
    outOfAmmoWeaponIds: [],
  }

  let s: GameState = { ...state, screen: 'combat', combat: session }

  // PC 주도 개전 — 잠입 여부를 먼저 묻는다 (라운드는 아직 시작 전)
  if (options.ambushOption) {
    return { ...s, combat: { ...session, prompt: { kind: 'ambush' } } }
  }

  s = startRound(rng, s, options.surprise ?? null)
  return advanceCombat(rng, data, s)
}

/**
 * 잠입 선택 응답.
 *  - open: 정면 돌파 — 통상 선제
 *  - sneak: 은신 판정 (근접 무기뿐이면 접근 베인). 성공 → 기습(최저 카드) + 첫 공격 암습.
 *    실패 → 들킴, 통상 선제.
 */
export function resolveAmbush(rng: RNG, data: GameData, state: GameState, choice: 'sneak' | 'open'): GameState {
  const c = state.combat
  if (!c?.prompt || c.prompt.kind !== 'ambush') return state
  let s: GameState = { ...state, combat: { ...c, prompt: null } }

  if (choice === 'open') {
    s = startRound(rng, s, null)
    return advanceCombat(rng, data, s)
  }

  // 근접 공격 거리(2m)까지 접근해야 하면 베인 — 원거리 수단이 손에 없을 때
  const hasRangedMeans = c.pc.weaponsAtHand.some((id) => {
    const w = weaponOf(data, id)
    return effectiveRange(w, c.pc.attributes?.str ?? null) !== null
  })
  const mods = gatherMods(data, c.pc, 'sneaking', { banes: hasRangedMeans ? 0 : 1 })
  const result = rollD20(rng, c.pc.skills['sneaking'] ?? 0, mods)
  s = trackMark(s, 'sneaking', result.dragon, result.demon)

  if (result.success) {
    s = log(s, 'good', '그림자에 붙어 접근한다 — 적은 아직 모른다. (기습: 첫 공격 암습)')
    s = { ...s, combat: { ...s.combat!, sneakPending: true } }
    s = startRound(rng, s, 'pc')
  } else {
    s = log(s, 'bad', '발밑에서 돌이 굴렀다 — 들켰다!')
    s = startRound(rng, s, null)
  }
  return advanceCombat(rng, data, s)
}

function startRound(rng: RNG, state: GameState, surprise: 'pc' | 'enemies' | null = null): GameState {
  const c = state.combat!
  const requests = [
    { combatantId: 'pc', cards: 1, choosesCard: surprise === 'pc' },
    ...c.enemies
      .filter((e) => !isDead(e))
      .map((e) => ({
        combatantId: unitId(e),
        cards: e.kind === 'monster' ? e.state.ferocity : 1,
        choosesCard: surprise === 'enemies',
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
      pcWaited: false,
      drewWeaponThisRound: false,
    },
  }
}

/** PC(캐릭터)가 패시브 마커 훅을 보유했는가 */
function pcHasHook(data: GameData, state: GameState, hook: string, params?: Record<string, unknown>): boolean {
  return hasAbilityHook(data, state.character.abilities, hook, params)
}

/* ─────────────────────────── 거리 헬퍼 ─────────────────────────── */

/** 적의 라운드당 이동력 — 몬스터는 데이터, NPC는 기본 10 */
function enemyMovement(data: GameData, e: EnemyUnit): number {
  if (e.kind === 'monster') {
    return data.monsters.find((m) => m.id === e.state.monsterId)?.movement.land ?? 10
  }
  return e.state.movement ?? 10
}

function pcMovement(data: GameData, state: GameState): number {
  return movementOf(data, state.character)
}

function setDistance(state: GameState, id: string, distance: number): GameState {
  const c = state.combat!
  return {
    ...state,
    combat: {
      ...c,
      enemies: c.enemies.map((e) => (unitId(e) === id ? { ...e, distance: Math.max(0, distance) } : e)),
    },
  }
}

/**
 * 과적 상태에서의 이동 판정 (STR). 과적이 아니면 항상 통과.
 * 실패하면 이번 이동은 무산 — 짐을 버리는 선택은 UI 밖(수동)이다.
 */
function encumberedMoveCheck(rng: RNG, data: GameData, state: GameState): { ok: boolean; state: GameState } {
  const enc = encumbrance(data, state.character)
  if (!enc.overEncumbered) return { ok: true, state }
  const banes = conditionBanes(new Set(state.character.conditions), 'str')
  const result = rollD20(rng, state.character.attributes.str, { banes })
  if (result.success) return { ok: true, state }
  return { ok: false, state: log(state, 'bad', '과적 — 짐에 눌려 움직이지 못한다! (근력 판정 실패)') }
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
        // 회복 시 캐릭터 HP 도 함께 동기화 (죽음 판정 회복 → character 반영)
        s = {
          ...s,
          character: { ...s.character, hp: out.combatant.hp },
          combat: { ...s.combat!, pc: out.combatant },
        }
        // 중상표 (옵션 룰): 사경을 헤매다 살아나면 체력 판정 — 실패 시 중상
        if (out.recovered && data.config.severeInjuries) {
          s = applySevereInjuryRoll(rng, data, s)
        }
        s = consumeSlot(s)
        continue
      }
      // 넘어져 있으면 일어난다 (자유 행동) — 붙잡는 중에는 일어날 수 없다
      if (c.pc.prone && c.pc.hp > 0 && !c.grappledEnemyId) {
        s = { ...s, combat: { ...c, pc: { ...c.pc, prone: false } } }
        s = log(s, 'info', '몸을 일으킨다.')
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
  const id = unitId(enemy)

  // PC가 쓰러져 있으면 적은 관망 (초벌 AI)
  if (c.pc.hp === 0) return s

  // 붙잡힌 적: 벗어나기(격투 대결)만 가능 — 벗어나기 자체는 자유 행동이지만 달리 할 것이 없다
  if (c.grappledEnemyId === id && enemy.kind === 'npc') {
    const out = tryBreakFree(rng, data, enemy.state, c.pc)
    if (out.freed) {
      s = { ...s, combat: { ...s.combat!, grappledEnemyId: null } }
      return log(s, 'combat', `${enemy.state.name}이(가) 몸부림쳐 붙잡기에서 벗어났다!`)
    }
    return log(s, 'combat', `${enemy.state.name}이(가) 벗어나려 하지만 꽉 붙잡혀 있다.`)
  }

  // 넘어져 있으면 일어난다 (자유 행동 — 이동·행동은 그대로 진행)
  if (enemy.kind === 'npc' && enemy.state.prone) {
    s = updateEnemy(s, id, { ...enemy, state: { ...enemy.state, prone: false } })
    enemy = s.combat!.enemies.find((e) => unitId(e) === id)!
  } else if (enemy.kind === 'monster' && enemy.state.prone) {
    s = updateEnemy(s, id, { ...enemy, state: { ...enemy.state, prone: false } })
    enemy = s.combat!.enemies.find((e) => unitId(e) === id)!
  }

  const movement = enemyMovement(data, enemy)

  if (enemy.kind === 'monster') {
    // 몬스터 공격 간격 2m — 자유 이동으로 닿으면 공격, 아니면 돌진(이동 ×2)
    if (enemy.distance > 2) {
      if (enemy.distance - movement <= 2) {
        s = setDistance(s, id, 2)
      } else {
        s = setDistance(s, id, Math.max(2, enemy.distance - movement * 2))
        return log(s, 'combat', `${enemy.state.name}이(가) 돌진해 온다! (${s.combat!.enemies.find((e) => unitId(e) === id)!.distance}m)`)
      }
    }
    const { monster, pick } = rollMonsterAttack(rng, data, enemy.state)
    s = updateEnemy(s, monster.id, { kind: 'monster', state: monster, distance: 2 })
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
    return applyMonsterAttackToPc(rng, data, s, pick.attack, monster.id)
  }

  // NPC 적
  const npc = enemy.state

  // 동물 — 자연 무기 공격 (일반 스킬 판정, 회피·패리 가능)
  if (npc.naturalAttack) {
    const na = npc.naturalAttack
    if (enemy.distance > 2) {
      if (enemy.distance - movement <= 2) {
        s = setDistance(s, id, 2)
      } else {
        s = setDistance(s, id, Math.max(2, enemy.distance - movement * 2))
        return log(s, 'combat', `${npc.name}이(가) 달려든다. (${s.combat!.enemies.find((e) => unitId(e) === id)!.distance}m)`)
      }
    }
    const result = rollD20(rng, na.skillLevel)
    if (!result.success) {
      return log(s, 'combat', `${npc.name}의 공격 — 빗나감 (${result.natural})`)
    }
    s = log(s, 'combat', `${npc.name}이(가) 물어뜯으려 든다! (${result.natural})`)
    const pseudoAttack: MonsterAttack = {
      roll: 1, name: na.name, description: '',
      canParry: true, canDodge: true,
      effects: [{ hook: 'damage', params: { dice: na.damage } }],
    }
    if (!c.pc.acted) {
      return {
        ...s,
        combat: {
          ...s.combat!,
          prompt: {
            kind: 'reaction',
            enemyId: id,
            monsterAttack: pseudoAttack,
            canDodge: true,
            canParry: c.pc.drawnWeaponIds.length > 0,
          },
        },
      }
    }
    return applyMonsterAttackToPc(rng, data, s, pseudoAttack, id)
  }

  let weaponId = npc.drawnWeaponIds[0]

  // 무장 해제당한 무기 줍기 (액션)
  if (!weaponId) {
    const dropped = c.droppedWeapons[id] ?? []
    if (dropped.length > 0) {
      const picked = dropped[0]!
      s = updateEnemy(s, id, {
        ...enemy,
        state: { ...npc, drawnWeaponIds: [picked], weaponsAtHand: [...npc.weaponsAtHand, picked] },
      })
      s = {
        ...s,
        combat: { ...s.combat!, droppedWeapons: { ...s.combat!.droppedWeapons, [id]: dropped.slice(1) } },
      }
      return log(s, 'combat', `${npc.name}이(가) 떨어진 무기를 주워 든다.`)
    }
    // 맨손: 접근 후 격투 (간이 — 성공 시 D6)
    if (enemy.distance > 2) {
      s = setDistance(s, id, Math.max(2, enemy.distance - movement * 2))
      return log(s, 'combat', `${npc.name}이(가) 달려든다. (${s.combat!.enemies.find((e) => unitId(e) === id)!.distance}m)`)
    }
    const brawl = rollD20(rng, npc.skills['brawling'] ?? 5)
    if (!brawl.success) return log(s, 'combat', `${npc.name}의 주먹이 허공을 가른다.`)
    const dmg = rollDie(rng, 6)
    const applied = applyDamage(data, c.pc, {
      total: dmg, weaponDice: [dmg], bonusDice: [], ignoreArmor: false, damageType: 'bludgeoning', breakdown: `D6=${dmg}`,
    }, { melee: true })
    s = log(s, 'bad', `${npc.name}의 주먹 — ${applied.taken} 피해 (HP ${applied.defender.hp})`)
    return { ...s, character: { ...s.character, hp: applied.defender.hp }, combat: { ...s.combat!, pc: applied.defender } }
  }

  let weapon = weaponOf(data, weaponId)
  const isRangedUse = effectiveRange(weapon, null) !== null

  // 원거리 무기 소지 + 거리 밖: 사거리 안이면 사격, 아니면 접근
  let attackKind: 'melee' | 'ranged' = 'melee'
  let situational = 0
  if (enemy.distance > weaponReach(weapon)) {
    const rState = isRangedUse ? rangedDistanceState(weapon, null, enemy.distance) : 'out-of-range'
    if (rState === 'normal' || rState === 'long') {
      attackKind = 'ranged'
      if (rState === 'long') situational += 1
    } else {
      // 접근: 자유 이동으로 닿으면 공격, 아니면 돌진
      if (enemy.distance - movement <= weaponReach(weapon)) {
        s = setDistance(s, id, weaponReach(weapon))
      } else {
        s = setDistance(s, id, Math.max(2, enemy.distance - movement * 2))
        return log(s, 'combat', `${npc.name}이(가) 거리를 좁힌다. (${s.combat!.enemies.find((e) => unitId(e) === id)!.distance}m)`)
      }
    }
  } else if (isRangedUse && weapon.category === 'ranged' && enemy.distance <= 2) {
    // 2m 이내 사격은 베인 — NPC는 그냥 근접 무기가 없으니 감수한다
    attackKind = 'ranged'
    situational += 1
  }

  const attack = rollAttack(rng, data, npc, weaponId, { id: 'pc', prone: c.pc.prone }, {
    kind: attackKind,
    damageType: weapon.damageTypes[0] ?? null,
    extra: { banes: situational },
  })
  if ('rejected' in attack) return s

  if (!attack.result.success && !attack.critical) {
    // 대실패 — 사고표의 무기 낙하는 NPC 에게도 적용
    if (attack.result.demon && attack.mishap?.effects.some((e) => e.hook === 'dropWeapon')) {
      s = updateEnemyState(s, id, {
        ...npc,
        drawnWeaponIds: npc.drawnWeaponIds.filter((w) => w !== weaponId),
        weaponsAtHand: npc.weaponsAtHand.filter((w) => w !== weaponId),
      })
      s = {
        ...s,
        combat: {
          ...s.combat!,
          droppedWeapons: {
            ...s.combat!.droppedWeapons,
            [id]: [...(s.combat!.droppedWeapons[id] ?? []), weaponId!],
          },
        },
      }
      return log(s, 'combat', `${npc.name}이(가) 대실패로 무기를 떨어뜨렸다!`)
    }
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
          // 원거리 패리는 방패 필요 — 방패는 초벌에서 뽑아 들 수 없으므로 근접만
          canParry: attackKind === 'melee' && c.pc.drawnWeaponIds.length > 0,
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

/** 상태만 갈아끼우기 — kind·distance 는 유지 */
function updateEnemyState(state: GameState, id: string, newState: MonsterCombatant | Combatant): GameState {
  const c = state.combat!
  return {
    ...state,
    combat: {
      ...c,
      enemies: c.enemies.map((e) =>
        unitId(e) === id ? ({ ...e, state: newState } as EnemyUnit) : e,
      ),
    },
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
    s = applyMonsterAttackToPc(rng, data, s, prompt.monsterAttack, prompt.enemyId)
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

function applyMonsterAttackToPc(
  rng: RNG,
  data: GameData,
  state: GameState,
  attack: MonsterAttack,
  enemyId?: string,
): GameState {
  let s = state
  const c = s.combat!
  const pcArmor = armorRatingOfPc(data, c.pc)
  const prevHp = c.pc.hp

  // 죽음 판정 회복 등으로 combat.pc 가 최신일 수 있다 — pc 기준 Vitals 로 적용
  const vitals: Vitals = { ...vitalsOf(s.character), hp: c.pc.hp, conditions: c.pc.conditions }
  const result = applyEffects(rng, data, attack.effects, vitals, {
    armorRating: pcArmor,
    maxHp: maxHp(data, s.character),
    maxWp: maxWp(data, s.character),
    immuneFear: pcHasHook(data, s, 'immuneFear'),
  })

  // Vitals → character + combat pc 동기화
  s = { ...s, character: withVitals(s.character, result.target) }
  let pc = { ...c.pc, hp: result.target.hp, conditions: [...result.target.conditions] }

  for (const a of result.applied) {
    if (a.hook === 'damage' || a.hook === 'knockback') s = log(s, 'bad', `${a.detail} (HP ${result.target.hp})`)
    else if (a.hook === 'fearAttack') s = log(s, a.detail.includes('저항') ? 'good' : 'bad', a.detail)
    else s = log(s, 'info', a.detail)
  }
  for (const d of result.directives) {
    if (d.kind === 'knockback') {
      if (d.params['prone']) pc = { ...pc, prone: true }
      // 밀려난 만큼 그 몬스터와의 거리가 벌어진다
      const meters = Number(d.params['meters']) || 0
      if (meters > 0 && enemyId) {
        const enemy = s.combat!.enemies.find((e) => unitId(e) === enemyId)
        if (enemy) s = setDistance(s, enemyId, enemy.distance + meters)
      }
    }
  }
  for (const m of result.manual) {
    void m
    s = log(s, 'info', `(수동 효과) ${attack.description}`)
  }

  // 흡혈 — 준 피해만큼 그 몬스터가 회복
  if (enemyId && result.directives.some((d) => d.kind === 'lifeDrain')) {
    const drained = result.applied
      .filter((a) => a.hook === 'damage' || (a.hook === 'knockback' && a.detail.includes('피해')))
      .reduce((sum, a) => sum + (a.amount ?? 0), 0)
    if (drained > 0) {
      const enemy = s.combat!.enemies.find((e) => unitId(e) === enemyId)
      if (enemy && !isDead(enemy)) {
        const healed = Math.min(enemy.state.maxHp, enemy.state.hp + drained)
        const amount = healed - enemy.state.hp
        s = updateEnemyState(s, enemyId, { ...enemy.state, hp: healed } as typeof enemy.state)
        if (amount > 0) s = log(s, 'bad', `${enemy.state.name}이(가) 피를 마시고 ${amount} 회복했다. (HP ${healed})`)
      }
    }
  }

  // 0 HP 처리 — 이번 공격으로 실제로 쓰러졌을 때만
  if (prevHp > 0 && pc.hp === 0 && !pc.deathRolls && !pc.dead) {
    pc = { ...pc, prone: true, deathRolls: { successes: 0, failures: 0 } }
    s = log(s, 'bad', '쓰러졌다! 죽음의 문턱에서 버텨야 한다.')
  }
  // 이미 0 HP 인 상태에서 피해를 또 받으면 죽음 판정 실패 1회 (원문)
  if (prevHp === 0 && pc.deathRolls) {
    // knockback 의 amount 는 피해 동반(damagePerMeter)일 때만 피해량이다
    const damageTaken = result.applied
      .filter((a) => a.hook === 'damage' || (a.hook === 'knockback' && a.detail.includes('피해')))
      .reduce((sum, a) => sum + (a.amount ?? 0), 0)
    if (damageTaken > 0) {
      const failures = pc.deathRolls.failures + 1
      if (failures >= 3) {
        pc = { ...pc, deathRolls: null, dead: true }
        s = log(s, 'bad', '쓰러진 몸에 또 한 번 — 숨이 끊어졌다.')
      } else {
        pc = { ...pc, deathRolls: { ...pc.deathRolls, failures } }
        s = log(s, 'bad', `쓰러진 몸에 추가 피해 — 죽음 판정 실패 +1 (실패 ${failures})`)
      }
    }
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
  const applied = applyDamage(data, c.pc, dmg, { melee: attack.context.kind === 'melee' })
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
  special: 'weakSpot' | null = null,
): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  const enemy = c.enemies.find((e) => unitId(e) === targetId)
  if (!enemy || isDead(enemy)) return state
  if (c.grappledEnemyId) return log(state, 'info', '붙잡은 상대를 놓기 전에는 다른 행동을 할 수 없다.')

  const weapon = weaponOf(data, weaponId)
  const reach = weaponReach(weapon)
  const str = c.pc.attributes?.str ?? null

  // 화살통: requiresQuiver 무기는 화살통이 있어야 쏠 수 있다. 목제 화살통뿐이면 상대 방어구 ×2.
  let armorMultiplier = 1
  if (weapon.features.includes('requiresQuiver')) {
    const iron = hasItem(state.character, 'quiver-iron')
    const wooden = hasItem(state.character, 'quiver-wooden')
    if (!iron && !wooden) return log(state, 'info', '화살통이 없다 — 사격할 수 없다.')
    if (!iron && wooden) armorMultiplier = 2
  }

  let s: GameState = { ...state, combat: { ...c, nextRollBoons: 0 } }

  // 화살 소진 (사고표) — 이번 전투 동안 사용 불가
  if (c.outOfAmmoWeaponIds.includes(weaponId)) {
    return log(s, 'info', '화살이 다 떨어졌다 — 이 무기는 보충 전까지 못 쓴다.')
  }

  // ── 거리 해결 ──
  let attackKind: 'melee' | 'ranged' = 'melee'
  let situational = 0
  let distance = enemy.distance

  if (distance > reach) {
    // 던지기 팔 능력: 한손 근접 무기도 STR 사거리로 투척 가능
    const canImproviseThrow =
      weapon.category === 'melee' && weapon.grip === '1H' &&
      !weapon.features.includes('thrown') && str !== null &&
      pcHasHook(data, state, 'throwAnyMelee')
    const rState = canImproviseThrow
      ? (distance <= (str ?? 10) ? 'normal' : distance <= (str ?? 10) * 2 ? 'long' : 'out-of-range')
      : rangedDistanceState(weapon, str, distance)
    if (rState === 'normal' || rState === 'long') {
      // 원거리/투척 사격
      attackKind = 'ranged'
      if (rState === 'long' && !pcHasHook(data, state, 'ignoreLongRangeBane')) situational += 1
    } else {
      // 자유 이동으로 접근 (과적이면 근력 판정)
      const move = encumberedMoveCheck(rng, data, s)
      s = move.state
      if (!move.ok) return finishPcAction(rng, data, s)
      const movement = pcMovement(data, s)
      if (distance - movement <= reach) {
        s = setDistance(s, targetId, reach)
        distance = reach
      } else {
        // 닿지 않는다 — 액션을 돌진(이동 ×2)으로 전환
        s = setDistance(s, targetId, Math.max(reach, distance - movement * 2))
        s = log(s, 'info', `너무 멀다 — 달려붙는다. (${s.combat!.enemies.find((e) => unitId(e) === targetId)!.distance}m)`)
        return finishPcAction(rng, data, s)
      }
    }
  } else if (weapon.category === 'ranged') {
    // 2m 이내 사격 — 베인
    attackKind = 'ranged'
    situational += 1
  }

  // ── 암습 (잠입 성공 직후 첫 공격) ──
  const sneak = s.combat!.sneakPending
  if (sneak) s = { ...s, combat: { ...s.combat!, sneakPending: false } }

  const context = {
    kind: attackKind,
    damageType,
    sneak,
    extra: { boons: c.nextRollBoons, banes: situational },
  } as const
  const targetProne = enemy.kind === 'monster' ? enemy.state.prone : enemy.state.prone
  const attack = rollAttack(
    rng, data, s.combat!.pc, weaponId, { id: targetId, prone: targetProne },
    special === 'weakSpot' ? findWeakSpotContext(context) : context,
  )
  if ('rejected' in attack) return log(s, 'info', `공격 불가: ${attack.rejected}`)

  s = trackMark(s, weapon.skillId, attack.result.dragon, attack.result.demon)

  if (attack.result.demon) {
    s = log(s, 'bad', `대실패!${attack.mishap ? ` ${attack.mishap.name} — ${attack.mishap.description}` : ''}`)
    if (attack.mishap?.name === '무기 손상') {
      s = { ...s, combat: { ...s.combat!, pc: { ...s.combat!.pc, damagedWeaponIds: [...s.combat!.pc.damagedWeaponIds, weaponId] } } }
    }
    // 구조화된 사고 효과 (dropWeapon / selfHit / outOfAmmo)
    for (const eff of attack.mishap?.effects ?? []) {
      if (eff.hook === 'dropWeapon') {
        const cc = s.combat!
        s = {
          ...s,
          combat: {
            ...cc,
            pc: { ...cc.pc, drawnWeaponIds: cc.pc.drawnWeaponIds.filter((w) => w !== weaponId) },
            pcDroppedWeaponIds: [...cc.pcDroppedWeaponIds, weaponId],
          },
        }
        s = log(s, 'bad', '무기가 손에서 떨어졌다! (줍기는 액션)')
      } else if (eff.hook === 'outOfAmmo') {
        s = { ...s, combat: { ...s.combat!, outOfAmmoWeaponIds: [...s.combat!.outOfAmmoWeaponIds, weaponId] } }
        s = log(s, 'bad', '화살이 다 떨어졌다!')
      } else if (eff.hook === 'selfHit') {
        const wdmg = rollDice(rng, weapon.damage).total
        const applied = applyDamage(data, s.combat!.pc, {
          total: wdmg, weaponDice: [wdmg], bonusDice: [], ignoreArmor: false,
          damageType: weapon.damageTypes[0] ?? null, breakdown: String(wdmg),
        }, { melee: attackKind === 'melee' })
        s = {
          ...s,
          character: { ...s.character, hp: applied.defender.hp },
          combat: { ...s.combat!, pc: applied.defender },
        }
        s = log(s, 'bad', `자신을 맞혔다 — ${applied.taken} 피해 (HP ${applied.defender.hp})`)
        if (applied.droppedToZero) s = log(s, 'bad', '쓰러졌다! 죽음의 문턱에서 버텨야 한다.')
      }
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

  s = log(s, 'combat', `${sneak ? '암습 ' : ''}${special === 'weakSpot' ? '약점 ' : ''}명중 (${attack.result.natural})`)
  s = dealPcDamage(rng, data, s, attack, targetId, null, { forceIgnoreArmor: special === 'weakSpot', armorMultiplier })
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
  options: { forceIgnoreArmor?: boolean; armorMultiplier?: number } = {},
): GameState {
  let s = state
  const c = s.combat!
  const enemy = c.enemies.find((e) => unitId(e) === targetId)
  if (!enemy) return s

  // 암습은 리액션 불가 (원문: 회피·패리 모두 불가)
  const canReact = !attack.context.sneak

  // 몬스터의 회피/패리 (AI: 체력이 절반 이하로 몰렸을 때만 행동을 소모해 회피)
  if (canReact && enemy.kind === 'monster' && enemy.state.actionsLeft > 0 && enemy.state.hp <= enemy.state.maxHp / 2) {
    const def = monsterDefense(rng, data, enemy.state, attack, 'dodge')
    if (!('rejected' in def)) {
      s = updateEnemy(s, targetId, { ...enemy, state: def.monster })
      if (def.avoided) {
        return log(s, 'combat', `${enemy.state.name}이(가) 몸을 틀어 피했다.`)
      }
    }
  }
  // NPC의 패리 (AI: 체력이 절반 이하일 때만 턴을 소모해 패리)
  if (canReact && enemy.kind === 'npc' && !enemy.state.acted && enemy.state.drawnWeaponIds.length > 0 && enemy.state.hp <= enemy.state.maxHp / 2) {
    const parry = tryParry(rng, data, enemy.state, attack, enemy.state.drawnWeaponIds[0]!)
    if (!('rejected' in parry)) {
      s = updateEnemy(s, targetId, { ...enemy, state: { ...enemy.state, acted: true } })
      if (parry.parried) {
        return log(s, 'combat', `${enemy.state.name}이(가) 받아넘겼다.`)
      }
    }
  }

  const dmg = rollDamage(rng, data, c.pc, attack, critical)
  return damageEnemyUnit(s, data, targetId, dmg.total, dmg.damageType, dmg.ignoreArmor || !!options.forceIgnoreArmor, options.armorMultiplier ?? 1)
}

function damageEnemyUnit(
  state: GameState,
  data: GameData,
  targetId: string,
  total: number,
  damageType: DamageType | null,
  ignoreArmor: boolean,
  armorMultiplier = 1,
): GameState {
  const enemy = state.combat!.enemies.find((e) => unitId(e) === targetId)
  if (!enemy) return state

  if (enemy.kind === 'monster') {
    const out = applyDamageToMonster(data, enemy.state, { total, damageType, ignoreArmor, armorMultiplier })
    let s = updateEnemyState(state, targetId, out.monster)
    if (out.immune) return log(s, 'info', `${enemy.state.name}에게는 통하지 않는다! (면역)`)
    s = log(
      s,
      'combat',
      `${enemy.state.name}에게 ${out.taken} 피해${out.resisted ? ' (저항 — 절반)' : ''}${out.absorbed ? ` (방어 ${out.absorbed} 흡수)` : ''}`,
    )
    if (out.monster.dead) s = log(s, 'good', `${enemy.state.name}을(를) 쓰러뜨렸다!`)
    return s
  }
  return damageNpc(state, data, targetId, total, damageType, ignoreArmor, armorMultiplier)
}

function damageNpc(
  state: GameState,
  data: GameData,
  targetId: string,
  total: number,
  damageType: DamageType | null,
  ignoreArmor: boolean,
  armorMultiplier = 1,
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
  }, { melee: true, armorMultiplier })
  let s = updateEnemyState(state, targetId, applied.defender)
  s = log(s, 'combat', `${enemy.state.name}에게 ${applied.taken} 피해${applied.absorbed ? ` (방어 ${applied.absorbed} 흡수)` : ''}`)
  if (applied.defender.dead) s = log(s, 'good', `${enemy.state.name}을(를) 쓰러뜨렸다!`)
  return s
}

/** 넘어뜨리기 특수 공격 */
export function pcTopple(rng: RNG, data: GameData, state: GameState, weaponId: string, targetId: string): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  if (c.grappledEnemyId) return log(state, 'info', '붙잡은 상대를 놓기 전에는 다른 행동을 할 수 없다.')
  const enemy = c.enemies.find((e) => unitId(e) === targetId)
  if (!enemy || isDead(enemy)) return state
  if (enemy.distance > weaponReach(weaponOf(data, weaponId))) return log(state, 'info', '너무 멀다 — 먼저 접근해야 한다.')

  let s = state
  if (enemy.kind === 'monster') {
    const out = toppleMonster(rng, data, c.pc, weaponId, enemy.state)
    s = updateEnemyState(s, targetId, out.monster)
    s = log(s, out.success ? 'good' : 'combat', out.success ? `${enemy.state.name}을(를) 넘어뜨렸다!` : '넘어뜨리지 못했다.')
  } else {
    const out = trySpecialTopple(rng, data, c.pc, weaponId, enemy.state)
    s = updateEnemyState(s, targetId, out.defender)
    s = log(s, out.success ? 'good' : 'combat', out.success ? `${enemy.state.name}을(를) 넘어뜨렸다!` : '넘어뜨리지 못했다.')
  }
  return finishPcAction(rng, data, s)
}

/** 무장 해제 특수 공격 — 대상의 뽑아 든 무기를 대결로 떨어뜨린다. 몬스터 불가 (원문). */
export function pcDisarm(rng: RNG, data: GameData, state: GameState, weaponId: string, targetId: string): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  if (c.grappledEnemyId) return log(state, 'info', '붙잡은 상대를 놓기 전에는 다른 행동을 할 수 없다.')
  const enemy = c.enemies.find((e) => unitId(e) === targetId)
  if (!enemy || isDead(enemy)) return state
  if (enemy.kind === 'monster') return log(state, 'info', '몬스터는 무장 해제할 수 없다.')
  if (enemy.distance > weaponReach(weaponOf(data, weaponId))) return log(state, 'info', '너무 멀다 — 먼저 접근해야 한다.')
  const targetWeaponId = enemy.state.drawnWeaponIds[0]
  if (!targetWeaponId) return log(state, 'info', '상대는 무기를 들고 있지 않다.')

  const out = trySpecialDisarm(rng, data, c.pc, weaponId, enemy.state, targetWeaponId)
  let s = state
  if (out.rejected) return log(s, 'info', out.rejected)
  if (out.success) {
    s = updateEnemyState(s, targetId, out.defender)
    s = {
      ...s,
      combat: {
        ...s.combat!,
        droppedWeapons: {
          ...s.combat!.droppedWeapons,
          [targetId]: [...(s.combat!.droppedWeapons[targetId] ?? []), targetWeaponId],
        },
      },
    }
    s = log(s, 'good', `무장 해제! ${enemy.state.name}의 무기가 ${out.distance}m 밖으로 날아갔다.`)
  } else {
    s = log(s, 'combat', '무장 해제 실패 — 상대가 무기를 지켜냈다.')
  }
  return finishPcAction(rng, data, s)
}

/** 붙잡기 특수 공격 — 격투 대결. 성공 시 둘 다 넘어지고 상대는 붙잡힌다. 몬스터 불가 (원문). */
export function pcGrapple(rng: RNG, data: GameData, state: GameState, targetId: string): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  if (c.grappledEnemyId) return log(state, 'info', '이미 붙잡고 있다.')
  const enemy = c.enemies.find((e) => unitId(e) === targetId)
  if (!enemy || isDead(enemy)) return state
  if (enemy.kind === 'monster') return log(state, 'info', '몬스터는 붙잡을 수 없다.')
  if (enemy.distance > 2) return log(state, 'info', '너무 멀다 — 먼저 접근해야 한다.')

  const out = trySpecialGrapple(rng, data, c.pc, enemy.state)
  let s: GameState = { ...state, combat: { ...c, pc: out.attacker } }
  if (out.success) {
    s = updateEnemyState(s, targetId, out.defender)
    s = { ...s, combat: { ...s.combat!, grappledEnemyId: targetId } }
    s = log(s, 'good', `${enemy.state.name}을(를) 바닥에 깔아 붙잡았다! 상대는 벗어나기만 할 수 있다.`)
  } else {
    s = log(s, 'bad', '붙잡기 실패 — 뒤엉키다 바닥에 넘어졌다.')
  }
  return finishPcAction(rng, data, s)
}

/** 조르기 — 붙잡은 상대에게 맨손 공격 (보온, 회피·패리 불가) */
export function pcGrappleCrush(rng: RNG, data: GameData, state: GameState): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt || !c.grappledEnemyId) return state
  const enemy = c.enemies.find((e) => unitId(e) === c.grappledEnemyId)
  if (!enemy || isDead(enemy)) return state

  const mods = gatherMods(data, c.pc, 'brawling', { boons: 1 })
  const result = rollD20(rng, c.pc.skills['brawling'] ?? 0, mods)
  let s = trackMark(state, 'brawling', result.dragon, result.demon)
  if (!result.success) {
    s = log(s, 'combat', '상대가 몸을 비틀어 조르기를 버텼다.')
    return finishPcAction(rng, data, s)
  }
  // 맨손 피해 D6 + STR 피해 보너스, 크리티컬이면 2배
  const base = result.dragon ? rollDie(rng, 6) + rollDie(rng, 6) : rollDie(rng, 6)
  const bonus = c.pc.damageBonusStr ? rollDice(rng, c.pc.damageBonusStr).total : 0
  s = log(s, result.dragon ? 'crit' : 'combat', `조르기${result.dragon ? ' — 크리티컬!' : ''}`)
  s = damageEnemyUnit(s, data, c.grappledEnemyId, base + bonus, 'bludgeoning', false)
  // 상대가 쓰러졌으면 붙잡기도 풀린다
  const after = s.combat!.enemies.find((e) => unitId(e) === c.grappledEnemyId)
  if (after && isDead(after)) s = { ...s, combat: { ...s.combat!, grappledEnemyId: null } }
  return finishPcAction(rng, data, s)
}

/** 놓아주기 (자유 행동) — 붙잡기를 풀고 일어설 수 있게 된다 */
export function pcReleaseGrapple(rng: RNG, data: GameData, state: GameState): GameState {
  void rng
  void data
  const c = state.combat
  if (!c || !c.grappledEnemyId) return state
  return log({ ...state, combat: { ...c, grappledEnemyId: null } }, 'info', '붙잡기를 풀었다.')
}

/** 돌진/거리 벌리기 — 액션으로 이동 ×2 */
export function pcDash(
  rng: RNG,
  data: GameData,
  state: GameState,
  direction: 'close' | 'away',
  targetId?: string,
): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  if (c.grappledEnemyId) return log(state, 'info', '붙잡은 상대를 놓기 전에는 이동할 수 없다.')

  const move = encumberedMoveCheck(rng, data, state)
  let s = move.state
  if (!move.ok) return finishPcAction(rng, data, s)

  const dist = pcMovement(data, s) * 2
  if (direction === 'close' && targetId) {
    const enemy = c.enemies.find((e) => unitId(e) === targetId)
    if (!enemy) return state
    s = setDistance(s, targetId, Math.max(2, enemy.distance - dist))
    s = log(s, 'info', `달려 거리를 좁혔다. (${s.combat!.enemies.find((e) => unitId(e) === targetId)!.distance}m)`)
  } else {
    for (const e of c.enemies) {
      if (!isDead(e)) s = setDistance(s, unitId(e), e.distance + dist)
    }
    s = log(s, 'info', `물러나 거리를 벌렸다. (+${dist}m)`)
  }
  return finishPcAction(rng, data, s)
}

/**
 * 대기 — 내 선제 카드를 뒤 순번의 다른 참가자와 교환한다 (상대는 거부할 수 없다).
 * 이미 행동한 상대·이미 대기한 라운드에는 불가. 라운드당 1회.
 */
export function pcWait(rng: RNG, data: GameData, state: GameState, targetSlotIndex: number): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt || c.pcWaited) return state
  const mySlotIndex = c.order.findIndex((slot, i) => slot.ownerId === 'pc' && !slot.done && i >= c.turnIndex)
  const mySlot = c.order[mySlotIndex]
  const theirSlot = c.order[targetSlotIndex]
  if (!mySlot || !theirSlot || theirSlot.done || theirSlot.ownerId === 'pc') return state

  const them = c.enemies.find((e) => unitId(e) === theirSlot.ownerId)
  const theyActed = them ? (them.kind === 'npc' ? them.state.acted : false) : true
  if (!canSwapInitiative(mySlot.card, theirSlot.card, theyActed)) {
    return log(state, 'info', '그 상대와는 카드를 바꿀 수 없다.')
  }

  const order = c.order.map((slot, i) => {
    if (i === mySlotIndex) return { ...slot, ownerId: theirSlot.ownerId }
    if (i === targetSlotIndex) return { ...slot, ownerId: 'pc' }
    return slot
  })
  let s: GameState = { ...state, combat: { ...c, order, pcWaited: true } }
  s = log(s, 'info', `대기 — 선제 카드를 교환했다. (${mySlot.card} ↔ ${theirSlot.card})`)
  return advanceCombat(rng, data, s)
}

/** 무기 바꿔 들기 (자유 행동, 라운드 1회) — 손에 지닌 무기를 뽑아 든다 */
export function pcDrawWeapon(rng: RNG, data: GameData, state: GameState, weaponId: string): GameState {
  void rng
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt) return state
  if (c.drewWeaponThisRound) return log(state, 'info', '이번 라운드에는 이미 무기를 바꿔 들었다.')
  if (!c.pc.weaponsAtHand.includes(weaponId)) return state
  const weapon = weaponOf(data, weaponId)
  let s: GameState = {
    ...state,
    combat: {
      ...c,
      pc: { ...c.pc, drawnWeaponIds: [weaponId] },
      drewWeaponThisRound: true,
    },
  }
  s = log(s, 'info', `${weapon.name}을(를) 뽑아 들었다. (자유 행동)`)
  return s
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
  if (c.grappledEnemyId) return log(state, 'info', '붙잡은 상대를 놓기 전에는 다른 행동을 할 수 없다.')

  const spell = spellOf(data, spellId)

  // 사거리 검사 — meters 는 명시 거리, touch 는 2m, personal 은 자기 자신만
  if (targetId !== 'self') {
    const enemy = c.enemies.find((e) => unitId(e) === targetId)
    if (enemy) {
      const maxRange =
        spell.range.kind === 'meters' ? (spell.range.meters ?? 10)
        : spell.range.kind === 'touch' ? 2
        : 0
      if (spell.range.kind === 'personal') return log(state, 'info', '자기 자신에게만 걸 수 있는 주문이다.')
      if (enemy.distance > maxRange) {
        return log(state, 'info', `사거리 밖이다. (${enemy.distance}m > ${maxRange}m)`)
      }
    }
  }

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
    // 밀쳐냄 주문 (돌풍·해일·회오리·정신 타격) — 위력당 주사위 +1
    const kb = spell.effects.find((e) => e.hook === 'knockback')
    if (kb) {
      const extraDice = spell.usesPowerLevel ? Math.max(0, powerLevel - 1) : 0
      const r = rollWithExtraDice(rng, String(kb.params?.['dice'] ?? 'D6'), extraDice)
      const meters = out.dragon ? r.total * 2 : r.total
      if (kb.params?.['damagePerMeter'] === true) {
        s = damageEnemyUnit(s, data, targetId, meters, 'bludgeoning', false)
      }
      const pushed = s.combat!.enemies.find((e) => unitId(e) === targetId)
      if (pushed && !isDead(pushed)) {
        s = setDistance(s, targetId, pushed.distance + meters)
        if (kb.params?.['prone'] === true) {
          s = updateEnemyState(s, targetId, { ...pushed.state, prone: true })
        }
        s = log(s, 'combat', `${pushed.state.name}이(가) ${meters}m 날아갔다!`)
      }
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
  if (ability.activation === 'action') return finishPcAction(rng, data, s)
  return s // 자유 발동 — 턴 소모 없음
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

/** 떨어뜨린 무기 줍기 (액션) */
export function pcPickUpWeapon(rng: RNG, data: GameData, state: GameState): GameState {
  const c = state.combat
  if (!c || c.status !== 'ongoing' || c.prompt || c.pcDroppedWeaponIds.length === 0) return state
  const weaponId = c.pcDroppedWeaponIds[0]!
  let s: GameState = {
    ...state,
    combat: {
      ...c,
      pc: { ...c.pc, drawnWeaponIds: [weaponId] },
      pcDroppedWeaponIds: c.pcDroppedWeaponIds.slice(1),
    },
  }
  s = log(s, 'info', `${weaponOf(data, weaponId).name}을(를) 주워 들었다.`)
  return finishPcAction(rng, data, s)
}

/**
 * 중상 굴림 + 구조화된 항목 자동 적용.
 * 영구 스킬 페널티(extra.skillPenalty)·새 약점(성격 변화)은 즉시 반영,
 * 치유 기간이 있는 항목은 규칙 요약을 로그로 남긴다 (수동).
 */
function applySevereInjuryRoll(rng: RNG, data: GameData, state: GameState): GameState {
  const out = rollSevereInjury(rng, data, vitalsOf(state.character))
  if (!out.injured || !out.row) {
    return log(state, 'good', '중상 판정 (체력) — 몸이 버텨냈다.')
  }
  const row = out.row
  let s = log(state, 'bad', `중상! ${row.name || `#${row.min}`} — ${row.description}`)
  if (out.healingDays) s = log(s, 'info', `치유 기간: ${out.healingDays}일`)

  const pen = row.extra?.['skillPenalty'] as
    | { skills?: string[]; kind?: string; amount: number; min: number }
    | undefined
  if (row.extra?.['permanent'] === true && pen) {
    const targets = pen.skills ?? data.skills.filter((k) => k.kind === pen.kind).map((k) => k.id)
    const skillLevels = { ...s.character.skillLevels }
    for (const id of targets) {
      if (skillLevels[id] !== undefined) skillLevels[id] = Math.max(pen.min, skillLevels[id]! - pen.amount)
    }
    s = { ...s, character: { ...s.character, skillLevels } }
    s = log(s, 'bad', `스킬 레벨 영구 −${pen.amount} (${targets.length}종, 최소 ${pen.min})`)
  }
  // 성격 변화 — 새 약점을 무작위로
  if (row.min === 19 && data.config.weaknesses) {
    const newWeakness = 1 + Math.floor(rng.next() * 20)
    s = { ...s, character: { ...s.character, weaknessId: newWeakness } }
    s = log(s, 'bad', `새 약점을 얻었다 (#${newWeakness})`)
  }
  return s
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
  // 사냥감 전투였다면 고기를 얻는다
  if (c.preyRations) {
    const meat = rollDice(rng, c.preyRations).total
    s = { ...s, rations: s.rations + meat }
    s = log(s, 'good', `사냥감을 해체했다 — 식량 +${meat} (총 ${s.rations})`)
  }
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
