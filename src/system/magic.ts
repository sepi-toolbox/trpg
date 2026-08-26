/**
 * 마법 — 시전 파이프라인, 위력, 요구 조건, 금속 제한, 준비 주문, 습득.
 *
 * 원문 핵심:
 *  - 시전 = WP 소모 + 유파 스킬 판정. 실패해도 WP 는 소모
 *  - 위력 1~3, WP 비용 = 2×위력. 위력 없는 주문은 항상 2 WP. 트릭 = 자동 성공, 1 WP
 *  - 요구 조건: 주문(말) / 동작 / 매개체 / 재료(소모) — 전부 충족해야 시전 가능
 *  - 금속 제한: 금속 갑옷 착용 또는 금속 무기를 손에 지니면 시전 불가 (소지품은 무관)
 *  - 준비 주문만 정상 시전. 미준비 주문은 그리무아에서 2배 시간 (리액션 주문 불가)
 *  - 몸에서 힘 끌어내기: WP 1 이하일 때, 주사위를 골라 굴려 그만큼 WP 획득+피해.
 *    치유 주문에는 사용 불가
 *  - 용: 대상이 용을 굴려야 저항/회피/패리 + 3택1 (피해·사거리 2배 / WP 무료 / 연속 시전(베인))
 *  - 마: 마법 사고표 (토글)
 */
import type { RNG } from './rng'
import { rollDie } from './rng'
import { roll } from './dice'
import type { SkillRollResult } from './roll'
import { rollD20 } from './roll'
import type { RollModifiers } from './roll'
import { conditionBanes } from './roll'
import type { ConditionId, GameData, RollTableRow, Spell } from './types'

/* ─────────────────────────── 시전자 뷰 ─────────────────────────── */

/** 시전에 필요한 최소 상태 (Character / Combatant 어느 쪽에서든 구성 가능) */
export interface CasterState {
  wp: number
  conditions: ConditionId[]
  /** 유파 스킬 id → 레벨 */
  skillLevels: Record<string, number>
  knownSpellIds: string[]
  preparedSpellIds: string[]
  /** 착용 중인 갑옷·투구 id */
  armorIds: string[]
  /** 손에 지닌 (at hand) 무기·물건 id — 뽑았는지 여부와 무관 */
  atHandIds: string[]
}

export function spellOf(data: GameData, spellId: string): Spell {
  const s = data.spells.find((x) => x.id === spellId)
  if (!s) throw new Error(`없는 주문: ${spellId}`)
  return s
}

/* ─────────────────────────── 시전 가능 검사 ─────────────────────────── */

export interface CastAttempt {
  spellId: string
  /** 1~3. usesPowerLevel=false 주문·트릭이면 무시 */
  powerLevel?: number
  /** 그리무아에서 직접 시전 (시간 2배) */
  fromGrimoire?: boolean
  /** 요구 조건 충족 상황 — 말을 할 수 있는가, 손이 자유로운가, 매개체·재료 보유 */
  available: {
    word?: boolean
    gesture?: boolean
    focus?: boolean
    ingredient?: boolean
  }
  /** 상황 보정 (연속 시전 베인 등) */
  extra?: RollModifiers
}

export type CastRejection =
  | 'unknown-spell' //     모르는 주문
  | 'no-school-skill' //   유파 스킬이 없음
  | 'not-prepared' //      미준비 (그리무아 시전도 아님)
  | 'grimoire-reaction' // 리액션 주문은 그리무아 시전 불가
  | 'requirement' //       요구 조건 미충족
  | 'metal' //             금속 제한
  | 'not-enough-wp' //     WP 부족 (몸에서 끌어내기 검토)
  | 'bad-power-level'

/** 금속 제한: 금속 갑옷 착용 또는 금속 물건을 손에 지님 */
export function metalRestriction(data: GameData, caster: CasterState): boolean {
  for (const id of caster.armorIds) {
    if (data.armor.find((a) => a.id === id)?.metal) return true
  }
  for (const id of caster.atHandIds) {
    const weapon = data.weapons.find((w) => w.id === id)
    if (weapon?.metal) return true
    const item = data.items.find((i) => i.id === id)
    if (item?.metal) return true
  }
  return false
}

/** WP 비용 계산 */
export function wpCost(spell: Spell, powerLevel: number): number {
  if (spell.kind === 'trick') return 1
  if (!spell.usesPowerLevel) return 2
  return 2 * powerLevel
}

export function checkCast(
  data: GameData,
  caster: CasterState,
  attempt: CastAttempt,
): { spell: Spell; schoolSkillId: string; cost: number } | { rejected: CastRejection } {
  const spell = data.spells.find((s) => s.id === attempt.spellId)
  if (!spell || !caster.knownSpellIds.includes(spell.id)) return { rejected: 'unknown-spell' }

  // 유파: general 은 아는 유파 아무거나. 아니면 해당 유파 스킬 필요
  const schoolSkillId =
    spell.school === 'general'
      ? Object.keys(caster.skillLevels).find((id) =>
          data.skills.some((s) => s.id === id && s.kind === 'magic'),
        )
      : caster.skillLevels[spell.school] !== undefined
        ? spell.school
        : undefined
  if (!schoolSkillId) return { rejected: 'no-school-skill' }

  // 준비 (트릭은 항상 준비 상태)
  if (spell.kind === 'spell' && !caster.preparedSpellIds.includes(spell.id)) {
    if (!attempt.fromGrimoire) return { rejected: 'not-prepared' }
    if (spell.castingTime === 'reaction') return { rejected: 'grimoire-reaction' }
  }

  // 요구 조건
  for (const req of spell.requirements) {
    if (!attempt.available[req]) return { rejected: 'requirement' }
  }

  if (metalRestriction(data, caster)) return { rejected: 'metal' }

  const powerLevel = attempt.powerLevel ?? 1
  if (spell.usesPowerLevel && (powerLevel < 1 || powerLevel > 3)) {
    return { rejected: 'bad-power-level' }
  }

  const cost = wpCost(spell, powerLevel)
  if (caster.wp < cost) return { rejected: 'not-enough-wp' }

  return { spell, schoolSkillId, cost }
}

/* ─────────────────────────── 시전 ─────────────────────────── */

export type DragonCastChoice = 'doubleEffect' | 'freeCast' | 'chainCast'

export interface CastResult {
  spell: Spell
  powerLevel: number
  /** 트릭은 판정 없음 (null) */
  roll: SkillRollResult | null
  success: boolean
  wpSpent: number
  /** 용 — 3택1 효과는 게임 루프가 선택. freeCast 선택 시 WP 환급도 루프에서 */
  dragon: boolean
  /** 마 — 사고표 행 (토글 켜졌을 때) */
  mishap: RollTableRow | null
  /** 실제 시전 시간 (그리무아면 한 단계 더) */
  castingTimeSpent: string
}

/**
 * 시전 실행. checkCast 를 통과한 뒤 호출한다.
 * WP 는 성공/실패와 무관하게 소모된다. caster 상태 갱신은 호출부가
 * wpSpent 를 반영한다 (freeCast 선택 시 환급).
 */
export function castSpell(
  rng: RNG,
  data: GameData,
  caster: CasterState,
  attempt: CastAttempt,
): CastResult | { rejected: CastRejection } {
  const check = checkCast(data, caster, attempt)
  if ('rejected' in check) return check
  const { spell, schoolSkillId, cost } = check
  const powerLevel = spell.usesPowerLevel ? (attempt.powerLevel ?? 1) : 1

  const castingTimeSpent = attempt.fromGrimoire
    ? `${spell.castingTime} ×2`
    : spell.castingTime

  // 트릭: 자동 성공
  if (spell.kind === 'trick') {
    return {
      spell,
      powerLevel: 1,
      roll: null,
      success: true,
      wpSpent: cost,
      dragon: false,
      mishap: null,
      castingTimeSpent,
    }
  }

  const banes =
    (attempt.extra?.banes ?? 0) +
    conditionBanes(new Set(caster.conditions), spellSkillAttribute(data, schoolSkillId))
  const boons = attempt.extra?.boons ?? 0

  const result = rollD20(rng, caster.skillLevels[schoolSkillId] ?? 0, { boons, banes })

  let mishap: RollTableRow | null = null
  if (result.demon && data.config.magicalMishaps) {
    const table = data.tables.find((t) => t.id === 'magical-mishap')
    if (table) {
      const eye = rollDie(rng, table.die)
      mishap = table.rows.find((r) => eye >= r.min && eye <= r.max) ?? null
    }
  }

  return {
    spell,
    powerLevel,
    roll: result,
    success: result.success,
    wpSpent: cost,
    dragon: result.dragon,
    mishap,
    castingTimeSpent,
  }
}

function spellSkillAttribute(data: GameData, skillId: string) {
  return data.skills.find((s) => s.id === skillId)?.attribute ?? 'int'
}

/* ─────────────────────────── 몸에서 힘 끌어내기 ─────────────────────────── */

export type PowerFromBodyRejection = 'wp-too-high' | 'healing-spell' | 'bad-die'

const BODY_DICE = [4, 6, 8, 10, 12, 20]

/**
 * WP 1 이하일 때, 선택한 주사위를 굴려 그만큼 WP 획득(즉시 사용) + 같은 양의 피해.
 * 치유 주문에는 사용 불가. 쓰지 않은 WP 는 사라진다 (관리는 호출부).
 */
export function powerFromBody(
  rng: RNG,
  caster: { wp: number },
  dieSides: number,
  isHealingSpell: boolean,
): { wpGained: number; damage: number } | { rejected: PowerFromBodyRejection } {
  if (caster.wp > 1) return { rejected: 'wp-too-high' }
  if (isHealingSpell) return { rejected: 'healing-spell' }
  if (!BODY_DICE.includes(dieSides)) return { rejected: 'bad-die' }
  const rolled = rollDie(rng, dieSides)
  return { wpGained: rolled, damage: rolled }
}

/** 주문이 치유 계열인가 (몸에서 끌어내기 금지 판정용) */
export function isHealingSpell(spell: Spell): boolean {
  return spell.effects.some((e) => e.hook === 'heal')
}

/* ─────────────────────────── 준비 주문 관리 ─────────────────────────── */

export type PrepareRejection = 'over-limit' | 'unknown-spell' | 'trick'

/**
 * 주문 준비 (그리무아 학습 1시프트 — 시간 소모는 호출부).
 * 한도 = INT 기본치. 트릭은 준비 개념 없음.
 */
export function prepareSpells(
  data: GameData,
  caster: CasterState,
  spellIds: string[],
  limit: number,
): { preparedSpellIds: string[] } | { rejected: PrepareRejection; offending?: string } {
  if (spellIds.length > limit) return { rejected: 'over-limit' }
  for (const id of spellIds) {
    if (!caster.knownSpellIds.includes(id)) return { rejected: 'unknown-spell', offending: id }
    if (spellOf(data, id).kind === 'trick') return { rejected: 'trick', offending: id }
  }
  return { preparedSpellIds: [...spellIds] }
}

/* ─────────────────────────── 습득 ─────────────────────────── */

export type LearnRejection =
  | 'already-known'
  | 'no-school-skill'
  | 'prerequisite'
  | 'no-advancement-mark'

export interface LearnContext {
  /** 유파 스킬 보유 여부 검사용 */
  caster: CasterState
  /** INT (스승 학습 판정용) */
  int: number
  /** 언어 스킬 레벨 (그리무아 학습 판정용) */
  languagesLevel: number
}

function checkLearn(
  data: GameData,
  ctx: LearnContext,
  spell: Spell,
): LearnRejection | null {
  if (ctx.caster.knownSpellIds.includes(spell.id)) return 'already-known'

  const hasSchool = (school: string) =>
    school === 'any'
      ? Object.keys(ctx.caster.skillLevels).some((id) =>
          data.skills.some((s) => s.id === id && s.kind === 'magic'),
        )
      : ctx.caster.skillLevels[school] !== undefined

  const requiredSchool = spell.school === 'general' ? 'any' : spell.school
  if (!hasSchool(requiredSchool)) return 'no-school-skill'

  if (spell.prerequisite) {
    if (spell.prerequisite.spellId && !ctx.caster.knownSpellIds.includes(spell.prerequisite.spellId)) {
      return 'prerequisite'
    }
    if (spell.prerequisite.school && !hasSchool(spell.prerequisite.school)) {
      return 'prerequisite'
    }
  }
  return null
}

/**
 * 스승에게 주문 배우기: 1시프트 + 유파 성장 마크 1개 소모(호출부) + INT 판정(보온).
 * 세션 종료 시점에 활성화되는 시간 규칙은 게임 루프 책임.
 */
export function learnSpellFromTeacher(
  rng: RNG,
  data: GameData,
  ctx: LearnContext,
  spellId: string,
): { roll: SkillRollResult; learned: boolean } | { rejected: LearnRejection } {
  const spell = spellOf(data, spellId)
  const rejection = checkLearn(data, ctx, spell)
  if (rejection) return { rejected: rejection }
  if (spell.kind === 'trick') {
    // 트릭은 판정 없이 습득 (1스트레치)
    return { roll: rollD20(rng, 20), learned: true }
  }
  const result = rollD20(rng, ctx.int, { boons: 1 })
  return { roll: result, learned: result.success }
}

/** 그리무아에서 독학: 언어 스킬 판정 (보온 없음) */
export function learnSpellFromGrimoire(
  rng: RNG,
  data: GameData,
  ctx: LearnContext,
  spellId: string,
): { roll: SkillRollResult; learned: boolean } | { rejected: LearnRejection } {
  const spell = spellOf(data, spellId)
  const rejection = checkLearn(data, ctx, spell)
  if (rejection) return { rejected: rejection }
  if (spell.kind === 'trick') {
    return { roll: rollD20(rng, 20), learned: true }
  }
  const result = rollD20(rng, ctx.languagesLevel)
  return { roll: result, learned: result.success }
}

/**
 * 새 유파 배우기: 마법 재능 능력 + 스승 밑에서 1주 수학 후 INT 판정.
 * 성공 시 유파 스킬 = INT 기본치. 실패 시 1주 더 공부하고 재시도(호출부).
 */
export function learnSchool(
  rng: RNG,
  data: GameData,
  ctx: { int: number; hasMagicTalent: boolean; currentSkillLevels: Record<string, number> },
  schoolSkillId: string,
  intBaseChance: number,
): { roll: SkillRollResult; learned: boolean; newLevel: number | null } | { rejected: string } {
  if (!ctx.hasMagicTalent) return { rejected: '마법 재능 능력이 필요합니다' }
  if (ctx.currentSkillLevels[schoolSkillId] !== undefined) {
    return { rejected: '이미 아는 유파입니다' }
  }
  if (!data.skills.some((s) => s.id === schoolSkillId && s.kind === 'magic')) {
    return { rejected: `유파가 아닙니다: ${schoolSkillId}` }
  }
  const result = rollD20(rng, ctx.int)
  return { roll: result, learned: result.success, newLevel: result.success ? intBaseChance : null }
}

/* ─────────────────────────── 위력 반영 효과 계산 ─────────────────────────── */

/**
 * 주문 효과의 피해/회복 주사위를 위력에 맞게 굴린다.
 * effects 의 damage/heal + perPowerLevel 의 extraDamageDie/heal 을 합산.
 * (명중·저항·적용은 게임 루프/전투 모듈이 담당)
 */
export function rollSpellDice(
  rng: RNG,
  spell: Spell,
  powerLevel: number,
  kind: 'damage' | 'heal',
): { total: number; rolls: number[]; ignoreArmor: boolean } | null {
  const base = spell.effects.find((e) => e.hook === kind)
  if (!base) return null

  const rolls: number[] = []
  let total = 0
  const baseRoll = roll(rng, String(base.params?.['dice']))
  rolls.push(...baseRoll.rolls)
  total += baseRoll.total

  const extraLevels = spell.usesPowerLevel ? powerLevel - 1 : 0
  for (let i = 0; i < extraLevels; i++) {
    for (const extra of spell.perPowerLevel ?? []) {
      if (extra.hook === 'extraDamageDie' && kind === 'damage') {
        const r = roll(rng, String(extra.params?.['dice']))
        rolls.push(...r.rolls)
        total += r.total
      }
      if (extra.hook === 'heal' && kind === 'heal') {
        const r = roll(rng, String(extra.params?.['dice']))
        rolls.push(...r.rolls)
        total += r.total
      }
    }
  }

  return { total, rolls, ignoreArmor: base.params?.['ignoreArmor'] === true }
}
