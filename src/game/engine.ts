import type { RNG } from '../rules/rng'
import { pickWeighted } from '../rules/rng'
import { roll } from '../rules/dice'
import { abilityCheck } from '../rules/check'
import { gainXp, longRest } from '../rules/character'
import type { Character } from '../rules/types'
import type { CombatState, EncounterSpec, LogEntry as CombatLogEntry } from '../rules/combat'
import { startCombat } from '../rules/combat'
import { DUNGEON, SKILL_BY_ID } from '../data'
import type { FloorDef, RoomKind } from '../data'

/** 전투 승리 후 자동 회복량 (최대 생명력 대비 비율) */
export const SHORT_REST_RATIO = 0.3

export type RunPhase =
  | 'exploring' // 다음 방으로 갈 수 있는 상태
  | 'combat'
  | 'event' // 방 이벤트 결과를 보여주는 중
  | 'dead'
  | 'cleared'

export interface RunLogEntry {
  id: number
  text: string
  kind: 'system' | 'good' | 'bad' | 'info'
}

export interface RunState {
  seed: number
  character: Character
  floorIndex: number
  roomIndex: number
  gold: number
  phase: RunPhase
  combat: CombatState | null
  /** 마지막 방 결과 텍스트 */
  lastEvent: string
  /** 직전 전투의 기록 — 전투가 끝나도 무엇에 당했는지 볼 수 있게 남긴다 */
  lastCombatLog: CombatLogEntry[]
  roomKind: RoomKind | null
  log: RunLogEntry[]
  logSeq: number
}

export function currentFloor(state: RunState): FloorDef {
  return DUNGEON.floors[Math.min(state.floorIndex, DUNGEON.floors.length - 1)]!
}

export function isBossFloor(state: RunState): boolean {
  return state.floorIndex === DUNGEON.floors.length - 1
}

/** 보스 층은 방 하나짜리 — 옥좌의 방만 존재한다. */
export function roomsOnFloor(state: RunState): number {
  return isBossFloor(state) ? 1 : DUNGEON.roomsPerFloor
}

function addLog(
  state: RunState,
  kind: RunLogEntry['kind'],
  text: string,
): RunState {
  return {
    ...state,
    logSeq: state.logSeq + 1,
    log: [...state.log, { id: state.logSeq + 1, kind, text }],
  }
}

export function startRun(seed: number, character: Character): RunState {
  const base: RunState = {
    seed,
    character,
    floorIndex: 0,
    roomIndex: 0,
    gold: 0,
    phase: 'exploring',
    combat: null,
    lastEvent: '',
    lastCombatLog: [],
    roomKind: null,
    log: [],
    logSeq: 0,
  }
  return addLog(
    base,
    'system',
    `${character.name}이(가) 던전에 발을 들였다. — ${DUNGEON.floors[0]!.name}`,
  )
}

/** 다음 방에 진입. 방 종류를 가중치 테이블에서 뽑고 즉시 해결한다. */
export function enterRoom(rng: RNG, state: RunState): RunState {
  if (state.phase !== 'exploring') return state

  const floor = currentFloor(state)
  const isLastRoom = state.roomIndex + 1 >= roomsOnFloor(state)

  // 각 층의 마지막 방과 보스 층은 반드시 전투
  const kind: RoomKind =
    isLastRoom || isBossFloor(state) ? 'combat' : pickWeighted(rng, DUNGEON.roomTable).kind

  const next: RunState = { ...state, roomIndex: state.roomIndex + 1, roomKind: kind }

  switch (kind) {
    case 'combat':
      return beginCombat(rng, next, floor)
    case 'treasure':
      return resolveTreasure(rng, next, floor)
    case 'trap':
      return resolveTrap(rng, next, floor)
    case 'rest':
      return resolveRest(next)
    case 'shrine':
      return resolveShrine(rng, next)
  }
}

function beginCombat(rng: RNG, state: RunState, floor: FloorDef): RunState {
  const entry = pickWeighted(rng, floor.encounters)
  const spec: EncounterSpec[] = [{ monsterId: entry.monsterId, count: entry.count }]
  const combat = startCombat(rng, state.character, spec)
  return {
    ...addLog(state, 'info', `${floor.name} ${state.roomIndex}번째 방 — 적과 마주쳤다!`),
    phase: 'combat',
    combat,
  }
}

function resolveTreasure(rng: RNG, state: RunState, floor: FloorDef): RunState {
  const gold = roll(rng, floor.treasure).total
  const next = { ...state, gold: state.gold + gold, phase: 'event' as RunPhase }
  return addLog(
    { ...next, lastEvent: `보물 상자를 발견했다. 금화 ${gold}닢 획득!` },
    'good',
    `보물 — 금화 +${gold} (총 ${next.gold})`,
  )
}

function resolveTrap(rng: RNG, state: RunState, floor: FloorDef): RunState {
  const result = abilityCheck(rng, {
    abilities: state.character.abilities,
    ability: 'dex',
    dc: floor.trapDc,
    level: state.character.level,
    proficient: state.character.proficiencies.includes('dex'),
  })

  if (result.success) {
    return addLog(
      {
        ...state,
        phase: 'event',
        lastEvent: `함정! 민첩 판정 ${result.total} vs 난이도 ${floor.trapDc} — 아슬아슬하게 피했다.`,
      },
      'good',
      `함정 회피 (민첩 ${result.total} vs DC ${floor.trapDc})`,
    )
  }

  const damage = roll(rng, floor.trapDamage).total
  const hp = Math.max(0, state.character.hp - damage)
  const next: RunState = {
    ...state,
    character: { ...state.character, hp },
    phase: hp <= 0 ? 'dead' : 'event',
    lastEvent: `함정! 민첩 판정 ${result.total} vs 난이도 ${floor.trapDc} — 실패, ${damage} 피해를 입었다.`,
  }
  return addLog(next, 'bad', `함정 피격 — ${damage} 피해 (${hp}/${state.character.maxHp})`)
}

function resolveRest(state: RunState): RunState {
  const character = longRest(state.character)
  return addLog(
    {
      ...state,
      character,
      phase: 'event',
      lastEvent: '안전한 야영지를 찾았다. 생명력과 기술 사용 횟수를 모두 회복했다.',
    },
    'good',
    `휴식 — 완전 회복 (${character.hp}/${character.maxHp})`,
  )
}

function resolveShrine(rng: RNG, state: RunState): RunState {
  const result = abilityCheck(rng, {
    abilities: state.character.abilities,
    ability: 'wis',
    dc: 12,
    level: state.character.level,
    proficient: state.character.proficiencies.includes('wis'),
  })

  if (!result.success) {
    return addLog(
      {
        ...state,
        phase: 'event',
        lastEvent: `낡은 제단. 의지 판정 ${result.total} vs 난이도 12 — 아무 일도 일어나지 않았다.`,
      },
      'info',
      `제단 — 반응 없음 (의지 ${result.total})`,
    )
  }

  const bonusXp = 40 * state.character.level
  const { character, leveledTo } = gainXp(rng, state.character, bonusXp)
  let next: RunState = {
    ...state,
    character,
    phase: 'event',
    lastEvent: `낡은 제단이 빛난다. 의지 판정 ${result.total} 성공 — 경험치 ${bonusXp} 획득!`,
  }
  next = addLog(next, 'good', `제단 축복 — 경험치 +${bonusXp}`)
  if (leveledTo) next = addLog(next, 'good', `레벨 업! Lv.${leveledTo}`)
  return next
}

/** 전투가 끝난 뒤 결과를 런 상태에 반영 */
export function settleCombat(rng: RNG, state: RunState): RunState {
  const combat = state.combat
  if (!combat || combat.status === 'ongoing') return state

  if (combat.status === 'defeat') {
    return addLog(
      {
        ...state,
        character: { ...state.character, hp: 0 },
        phase: 'dead',
        combat: null,
        lastCombatLog: combat.log,
        lastEvent: '쓰러졌다. 던전은 조용해졌다.',
      },
      'bad',
      '패배 — 탐험 종료',
    )
  }

  // 짧은 휴식: 전투 후 최대 생명력의 25%를 회복한다.
  // 이게 없으면 1층에서 누적 피해만으로 전멸한다(밸런스 테스트로 확인).
  const shortRest = Math.ceil(state.character.maxHp * SHORT_REST_RATIO)
  const survivedHp = Math.min(state.character.maxHp, combat.hero.hp + shortRest)
  const recovered = survivedHp - combat.hero.hp

  // 짧은 휴식에는 기술도 1회씩 회복된다.
  // 기술이 곧 화력인 마법사/성직자가 자원 고갈로 무력해지는 걸 막는 장치.
  const skillUses: Record<string, number> = {}
  for (const id of state.character.skills) {
    const max = SKILL_BY_ID[id]?.uses ?? 0
    skillUses[id] = Math.min(max, (combat.skillUses[id] ?? 0) + 1)
  }

  const withHp: Character = {
    ...state.character,
    hp: survivedHp,
    skillUses,
  }
  const { character, leveledTo } = gainXp(rng, withHp, combat.xpGained)

  let next: RunState = {
    ...state,
    character,
    combat: null,
    lastCombatLog: combat.log,
    phase: 'event',
    lastEvent: `전투 승리! 경험치 ${combat.xpGained} 획득. 숨을 고르며 생명력 ${recovered} 회복.`,
  }
  next = addLog(
    next,
    'good',
    `승리 — 경험치 +${combat.xpGained}, 짧은 휴식으로 생명력 +${recovered}`,
  )
  if (leveledTo) next = addLog(next, 'good', `레벨 업! Lv.${leveledTo}`)
  return next
}

/** 방 결과 확인 후 계속 진행. 층을 다 돌면 다음 층으로 내려간다. */
export function continueRun(state: RunState): RunState {
  if (state.phase !== 'event') return state

  if (state.roomIndex >= roomsOnFloor(state)) {
    const nextFloorIndex = state.floorIndex + 1
    if (nextFloorIndex >= DUNGEON.floors.length) {
      return addLog(
        { ...state, phase: 'cleared', lastEvent: '던전의 주인을 쓰러뜨렸다. 클리어!' },
        'system',
        `던전 클리어! 최종 Lv.${state.character.level} / 금화 ${state.gold}`,
      )
    }
    const floor = DUNGEON.floors[nextFloorIndex]!
    return addLog(
      {
        ...state,
        floorIndex: nextFloorIndex,
        roomIndex: 0,
        phase: 'exploring',
        roomKind: null,
        lastEvent: '',
      },
      'system',
      `${floor.name}(지하 ${floor.depth}층)으로 내려간다.`,
    )
  }

  return { ...state, phase: 'exploring', roomKind: null, lastEvent: '' }
}
