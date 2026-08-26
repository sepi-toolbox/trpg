/**
 * 능력 엔진 — 효과 훅(Effect DSL) 해석기 + 능력 발동 관리.
 *
 * 데이터에 적힌 { hook, params } 를 실제 게임 상태 변화로 옮긴다.
 *  - 자원형 훅(damage/heal/condition/…): 즉시 적용
 *  - 판정 수정형(boon/bane/autoSuccess): 다음 판정에 쓸 보정으로 반환
 *  - 전투 지시형(extraAttack/initiativeSwap/…): 게임 루프가 실행할 지시로 반환
 *  - manual: 텍스트 표시 후 수동 처리하도록 그대로 반환
 */
import type { RNG } from './rng'
import { roll } from './dice'
import type { RollModifiers } from './roll'
import type {
  Ability,
  ConditionId,
  Effect,
  GameData,
  RollSelector,
} from './types'
import type { Vitals } from './hazards'
import { fearAttack, healConditions, poisonExposure, sufferCondition } from './hazards'
import type { PoisonKind } from './hazards'

/* ─────────────────────────── 효과 적용 ─────────────────────────── */

/** 한 훅이 적용된 결과 로그 (UI 표시·테스트 검증용) */
export interface AppliedEffect {
  hook: string
  detail: string
  amount?: number
}

/** 게임 루프가 이어서 실행해야 하는 지시 */
export interface Directive {
  kind:
    | 'extraAttack'
    | 'extraParry'
    | 'extraDodge'
    | 'initiativeSwap'
    | 'knockback'
    | 'lifeDrain'
    | 'selfHit'
    | 'dropWeapon'
    | 'outOfAmmo'
    | 'fearAttackOnOthers' // 광역 공포 등 대상이 자신이 아닌 경우
    | 'light'
  params: Record<string, unknown>
}

export interface EffectApplication<T extends Vitals> {
  target: T
  /** 즉시 적용된 변화 로그 */
  applied: AppliedEffect[]
  /** 다음 판정에 걸 보정 (boon/bane 훅) */
  rollModifiers: RollModifiers & { autoSuccess?: boolean; selector?: RollSelector }
  /** 게임 루프 지시 */
  directives: Directive[]
  /** 수동 처리 필요 */
  manual: Effect[]
}

export interface ApplyOptions {
  /** 위력 (주문·사고표의 위력 비례 효과) */
  powerLevel?: number
  /** 대상의 최대치 (heal 클램프) */
  maxHp?: number
  maxWp?: number
  /** damage 훅에서 방어구 차감량 (기본 0 — 자신 대상 효과는 방어구 무시가 일반적) */
  armorRating?: number
  /** 공포 면역 (immuneFear 마커 보유) */
  immuneFear?: boolean
}

/**
 * 효과 목록을 대상에 적용한다.
 * fearAttack·poison 은 하위 모듈을 그대로 호출한다 (판정 포함).
 */
export function applyEffects<T extends Vitals>(
  rng: RNG,
  data: GameData,
  effects: Effect[],
  target: T,
  options: ApplyOptions = {},
): EffectApplication<T> {
  let out: T = target
  const applied: AppliedEffect[] = []
  const directives: Directive[] = []
  const manual: Effect[] = []
  const rollModifiers: EffectApplication<T>['rollModifiers'] = { boons: 0, banes: 0 }

  const dice = (e: Effect) => String(e.params?.['dice'] ?? '0')

  for (const effect of effects) {
    switch (effect.hook) {
      case 'damage': {
        const rolled = roll(rng, dice(effect)).total
        const ignoreArmor = effect.params?.['ignoreArmor'] === true
        const afterArmor = Math.max(0, rolled - (ignoreArmor ? 0 : (options.armorRating ?? 0)))
        const taken = Math.min(out.hp, afterArmor)
        out = { ...out, hp: out.hp - taken }
        applied.push({ hook: 'damage', detail: `${rolled} 피해 (적용 ${taken})`, amount: taken })
        break
      }
      case 'heal': {
        const rolled = roll(rng, dice(effect)).total
        const healed = options.maxHp !== undefined
          ? Math.min(options.maxHp - out.hp, rolled)
          : rolled
        out = { ...out, hp: out.hp + Math.max(0, healed) }
        applied.push({ hook: 'heal', detail: `HP ${Math.max(0, healed)} 회복`, amount: healed })
        break
      }
      case 'healWp': {
        const rolled = roll(rng, dice(effect)).total
        const healed = options.maxWp !== undefined
          ? Math.min(options.maxWp - out.wp, rolled)
          : rolled
        out = { ...out, wp: out.wp + Math.max(0, healed) }
        applied.push({ hook: 'healWp', detail: `WP ${Math.max(0, healed)} 회복`, amount: healed })
        break
      }
      case 'drainWp': {
        const rolled = Math.min(out.wp, roll(rng, dice(effect)).total)
        out = { ...out, wp: out.wp - rolled }
        applied.push({ hook: 'drainWp', detail: `WP ${rolled} 상실`, amount: rolled })
        break
      }
      case 'condition': {
        const which = effect.params?.['condition'] as ConditionId | 'choice'
        const conditionId = which === 'choice' ? pickCondition(out) : which
        const result = sufferCondition(rng, out, conditionId)
        out = result.vitals
        applied.push({
          hook: 'condition',
          detail: result.gained ? `상태이상: ${result.gained}` : '상태이상 오버플로',
        })
        break
      }
      case 'healCondition': {
        const count = effect.params?.['count']
        if (count === 'all') {
          const n = out.conditions.length
          out = healConditions(out, 'all')
          applied.push({ hook: 'healCondition', detail: `상태이상 전부 해소 (${n})`, amount: n })
        } else {
          const n = Math.min(Number(count) || 1, out.conditions.length)
          const toHeal = out.conditions.slice(0, n)
          out = healConditions(out, toHeal)
          applied.push({ hook: 'healCondition', detail: `상태이상 ${n}개 해소`, amount: n })
        }
        break
      }
      case 'fearAttack': {
        if (options.immuneFear) {
          applied.push({ hook: 'fearAttack', detail: '공포 면역 — 흔들리지 않는다' })
          break
        }
        const result = fearAttack(rng, data, out, {
          bane: effect.params?.['bane'] === true,
        })
        out = result.vitals
        applied.push({
          hook: 'fearAttack',
          detail: result.resisted ? '공포 저항 성공' : `공포: ${result.tableRow?.name}`,
        })
        if (result.tableRow) {
          manual.push(...result.tableRow.effects.filter((e) => e.hook === 'manual'))
        }
        if (effect.params?.['radius'] !== undefined) {
          directives.push({
            kind: 'fearAttackOnOthers',
            params: { radius: effect.params['radius'] },
          })
        }
        break
      }
      case 'poison': {
        const result = poisonExposure(
          rng,
          out,
          effect.params?.['kind'] as PoisonKind,
          Number(effect.params?.['potency']) || 10,
        )
        out = result.vitals
        applied.push({
          hook: 'poison',
          detail: `독(${effect.params?.['kind']}) — ${result.fullEffect ? '완전' : '제한'} 효과`,
        })
        break
      }
      case 'knockback': {
        const meters = roll(rng, dice(effect)).total
        if (effect.params?.['damagePerMeter'] === true) {
          const taken = Math.min(out.hp, meters)
          out = { ...out, hp: out.hp - taken }
          applied.push({ hook: 'knockback', detail: `${meters}m 밀려남 + ${taken} 피해`, amount: taken })
        } else {
          applied.push({ hook: 'knockback', detail: `${meters}m 밀려남`, amount: meters })
        }
        directives.push({
          kind: 'knockback',
          params: { meters, prone: effect.params?.['prone'] === true },
        })
        break
      }
      case 'prone': {
        directives.push({ kind: 'knockback', params: { meters: 0, prone: true } })
        applied.push({ hook: 'prone', detail: '넘어짐' })
        break
      }
      case 'boon':
      case 'bane': {
        const selector = effect.params?.['roll'] as RollSelector | undefined
        if (effect.hook === 'boon') rollModifiers.boons = (rollModifiers.boons ?? 0) + 1
        else rollModifiers.banes = (rollModifiers.banes ?? 0) + 1
        rollModifiers.selector = selector
        applied.push({ hook: effect.hook, detail: effect.hook === 'boon' ? '보온' : '베인' })
        break
      }
      case 'autoSuccess': {
        rollModifiers.autoSuccess = true
        applied.push({ hook: 'autoSuccess', detail: '자동 성공' })
        break
      }
      case 'extraAttack':
      case 'extraParry':
      case 'extraDodge':
      case 'initiativeSwap':
      case 'light': {
        directives.push({ kind: effect.hook, params: effect.params ?? {} })
        applied.push({ hook: effect.hook, detail: '전투 지시' })
        break
      }
      case 'extraDamageDie': {
        // 피해 굴림 컨텍스트 전용 — 여기서는 지시로만 전달
        directives.push({ kind: 'extraAttack', params: { extraDamageDice: dice(effect) } })
        applied.push({ hook: 'extraDamageDie', detail: `피해 주사위 +${dice(effect)}` })
        break
      }
      case 'maxHpBonus':
      case 'maxWpBonus':
      case 'movementBonus':
      case 'armorBonus': {
        // 상시 보정 — 파생치 계산(character.ts / combatant.ts)에서 반영. 여기서는 무시.
        break
      }
      // 패시브 마커 — 발동 시점에는 아무것도 하지 않는다 (판정 경로가 소유 여부를 검사)
      case 'immuneFear':
      case 'parryRangedWithMelee':
      case 'ignoreLongRangeBane':
      case 'throwAnyMelee':
      case 'reduceFallDamage':
      case 'autoActivity':
        break
      // 게임 루프가 소비하는 지시
      case 'lifeDrain':
      case 'selfHit':
      case 'dropWeapon':
      case 'outOfAmmo': {
        directives.push({ kind: effect.hook, params: effect.params ?? {} })
        break
      }
      case 'manual':
      default: {
        manual.push(effect)
        break
      }
    }
  }

  return { target: out, applied, rollModifiers, directives, manual }
}

/** choice 상태이상의 기본 선택: 아직 없는 것 중 첫 번째 */
function pickCondition(vitals: Vitals): ConditionId {
  const all: ConditionId[] = ['exhausted', 'sickly', 'dazed', 'angry', 'scared', 'disheartened']
  return all.find((c) => !vitals.conditions.includes(c)) ?? 'exhausted'
}

/* ─────────────────────────── 능력 발동 ─────────────────────────── */

export interface AbilityActor {
  wp: number
  /** 능력 id → 보유 수 */
  abilities: Record<string, number>
}

export type ActivationRejection =
  | 'not-owned'
  | 'not-enough-wp'
  | 'passive-ability' // 발동형이 아님 (상시/트리거 적용)
  | 'varies-needs-amount' // wpCost 'varies' 인데 지출량 미지정

export interface ActivationResult {
  ability: Ability
  wpSpent: number
  effects: Effect[]
}

/**
 * 능력 발동 검사 + WP 계산.
 * 효과 적용은 applyEffects 로, WP 차감은 호출부가 wpSpent 로.
 */
export function activateAbility(
  data: GameData,
  actor: AbilityActor,
  abilityId: string,
  options: { wpToSpend?: number } = {},
): ActivationResult | { rejected: ActivationRejection } {
  if (!actor.abilities[abilityId]) return { rejected: 'not-owned' }
  const ability = data.abilities.find((a) => a.id === abilityId)
  if (!ability) return { rejected: 'not-owned' }
  if (ability.activation === 'passive') return { rejected: 'passive-ability' }

  let wpSpent: number
  if (ability.wpCost === 'varies') {
    if (options.wpToSpend === undefined) return { rejected: 'varies-needs-amount' }
    wpSpent = options.wpToSpend
  } else {
    wpSpent = ability.wpCost
  }
  if (actor.wp < wpSpent) return { rejected: 'not-enough-wp' }

  return { ability, wpSpent, effects: ability.effects }
}

/* ─────────────────────────── 습득 요건 검사 ─────────────────────────── */

/** 와일드카드 스킬 그룹을 데이터에서 계산한다 */
export function resolveSkillWildcard(data: GameData, wildcard: string): string[] {
  switch (wildcard) {
    case 'anyWeapon':
      return data.skills.filter((s) => s.kind === 'weapon').map((s) => s.id)
    case 'anyMeleeWeapon': {
      const meleeSkills = new Set(
        data.weapons.filter((w) => w.category === 'melee').map((w) => w.skillId),
      )
      return [...meleeSkills]
    }
    case 'anyStrMeleeWeapon': {
      const meleeSkills = new Set(
        data.weapons.filter((w) => w.category === 'melee').map((w) => w.skillId),
      )
      return data.skills
        .filter((s) => meleeSkills.has(s.id) && s.attribute === 'str')
        .map((s) => s.id)
    }
    case 'anyMagic':
      return data.skills.filter((s) => s.kind === 'magic').map((s) => s.id)
    default:
      return [wildcard]
  }
}

/**
 * 영웅 능력 습득 요건 검사.
 * (시작 능력에는 요건이 적용되지 않는다 — 생성 파이프라인은 이 검사를 건너뜀)
 */
export function meetsRequirement(
  data: GameData,
  skillLevels: Record<string, number>,
  ability: Ability,
): boolean {
  if (!ability.requirement) return true
  const candidates = ability.requirement.skillIds.flatMap((id) => resolveSkillWildcard(data, id))
  return candidates.some((id) => (skillLevels[id] ?? 0) >= ability.requirement!.level)
}

export type LearnAbilityRejection = 'unknown' | 'already-owned' | 'requirement'

/** 새 영웅 능력 습득 (스킬 18 도달·모험 보상 시). stackable 은 중복 허용. */
export function learnAbility(
  data: GameData,
  actor: { skillLevels: Record<string, number>; abilities: Record<string, number> },
  abilityId: string,
): { abilities: Record<string, number> } | { rejected: LearnAbilityRejection } {
  const ability = data.abilities.find((a) => a.id === abilityId)
  if (!ability) return { rejected: 'unknown' }
  if (actor.abilities[abilityId] && !ability.stackable) return { rejected: 'already-owned' }
  if (!meetsRequirement(data, actor.skillLevels, ability)) return { rejected: 'requirement' }
  return {
    abilities: { ...actor.abilities, [abilityId]: (actor.abilities[abilityId] ?? 0) + 1 },
  }
}

/* ─────────────────────────── 트리거 조회 ─────────────────────────── */

/** 특정 트리거에 걸린 보유 능력들의 효과 목록 */
export function triggeredEffects(
  data: GameData,
  abilities: Record<string, number>,
  trigger: 'always' | 'stretchRest',
): Effect[] {
  const out: Effect[] = []
  for (const [id, count] of Object.entries(abilities)) {
    const ability = data.abilities.find((a) => a.id === id)
    if (!ability || ability.trigger !== trigger) continue
    for (let i = 0; i < count; i++) out.push(...ability.effects)
  }
  return out
}

/**
 * 스트레치 휴식 보정 추출 — hazards.stretchRest 의 bonus 형태로 변환.
 * (깊은 명상류: trigger='stretchRest' 능력의 heal/healWp/healCondition)
 */
export function stretchRestBonus(
  data: GameData,
  abilities: Record<string, number>,
  currentConditions: ConditionId[],
): { hpDice?: string; wpDice?: string; extraConditions?: ConditionId[] } {
  const effects = triggeredEffects(data, abilities, 'stretchRest')
  const bonus: { hpDice?: string; wpDice?: string; extraConditions?: ConditionId[] } = {}
  for (const e of effects) {
    if (e.hook === 'heal') bonus.hpDice = String(e.params?.['dice'])
    if (e.hook === 'healWp') bonus.wpDice = String(e.params?.['dice'])
    if (e.hook === 'healCondition') {
      const n = Number(e.params?.['count']) || 1
      bonus.extraConditions = currentConditions.slice(0, n)
    }
  }
  return bonus
}

/* ─────────────────────────── 사고표 위력 비례 적용 ─────────────────────────── */

/**
 * 마법 사고표의 위력 비례 행(extra.damagePerPowerLevel / wpDrainPerPowerLevel)을 적용한다.
 * 구조화 훅은 applyEffects 로 함께 처리.
 */
export function applyMishapRow<T extends Vitals>(
  rng: RNG,
  data: GameData,
  row: { effects: Effect[]; extra?: Record<string, unknown> },
  target: T,
  powerLevel: number,
): EffectApplication<T> {
  const result = applyEffects(rng, data, row.effects, target, {})
  let out = result.target

  const dmgDice = row.extra?.['damagePerPowerLevel'] as string | undefined
  if (dmgDice) {
    let total = 0
    for (let i = 0; i < powerLevel; i++) total += roll(rng, dmgDice).total
    const taken = Math.min(out.hp, total)
    out = { ...out, hp: out.hp - taken }
    result.applied.push({ hook: 'damage', detail: `위력 비례 피해 ${taken}`, amount: taken })
  }

  const wpDice = row.extra?.['wpDrainPerPowerLevel'] as string | undefined
  if (wpDice) {
    let total = 0
    for (let i = 0; i < powerLevel; i++) total += roll(rng, wpDice).total
    const lost = Math.min(out.wp, total)
    out = { ...out, wp: out.wp - lost }
    result.applied.push({ hook: 'drainWp', detail: `위력 비례 WP 상실 ${lost}`, amount: lost })
  }

  return { ...result, target: out }
}

/** 캐릭터가 특정 패시브 마커 훅을 보유했는가 (activity 등 파라미터 일치 검사 포함) */
export function hasAbilityHook(
  data: GameData,
  abilities: Record<string, number>,
  hook: string,
  params?: Record<string, unknown>,
): boolean {
  for (const id of Object.keys(abilities)) {
    const ability = data.abilities.find((a) => a.id === id)
    for (const e of ability?.effects ?? []) {
      if (e.hook !== hook) continue
      if (params && Object.entries(params).some(([k, v]) => e.params?.[k] !== v)) continue
      return true
    }
  }
  return false
}
