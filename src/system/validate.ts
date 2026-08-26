/**
 * 데이터 테이블 무결성 검증.
 *
 * 성권이 JSON을 편집하다 생기는 실수(참조 깨짐, 잘못된 주사위 표기,
 * 구간표 구멍, 몬스터 공격표 눈 누락)를 테스트 시점에 잡는다.
 * 여기서 잡히면 게임에서 터지지 않는다.
 */
import type {
  Ability,
  AttributeId,
  EffectHook,
  GameData,
} from './types'
import { ATTRIBUTES } from './types'

const DICE_PATTERN = /^\s*(\d*)\s*[dD]\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$|^\s*\d+\s*$/

export function isValidDice(notation: string): boolean {
  return DICE_PATTERN.test(notation)
}

/** 구현된(또는 예약된) 효과 훅 목록 — types.ts 의 EffectHook 과 일치해야 한다 */
const KNOWN_HOOKS: EffectHook[] = [
  'boon', 'bane', 'autoSuccess',
  'damage', 'heal', 'healWp', 'drainWp', 'extraDamageDie',
  'condition', 'healCondition', 'fearAttack', 'knockback', 'prone', 'poison',
  'extraAttack', 'extraParry', 'extraDodge', 'initiativeSwap',
  'maxHpBonus', 'maxWpBonus', 'movementBonus', 'armorBonus', 'light',
  'immuneFear', 'parryRangedWithMelee', 'ignoreLongRangeBane', 'throwAnyMelee',
  'reduceFallDamage', 'autoActivity', 'lifeDrain', 'selfHit', 'dropWeapon', 'outOfAmmo',
  'manual',
]

const CONDITION_IDS = ['exhausted', 'sickly', 'dazed', 'angry', 'scared', 'disheartened']

const REQUIREMENT_WILDCARDS = ['anyWeapon', 'anyMeleeWeapon', 'anyStrMeleeWeapon', 'anyMagic']

export function validateGameData(data: GameData): string[] {
  const errors: string[] = []
  const err = (msg: string) => errors.push(msg)

  const skillIds = new Set(data.skills.map((s) => s.id))
  const abilityIds = new Set(data.abilities.map((a) => a.id))
  const weaponIds = new Set(data.weapons.map((w) => w.id))
  const armorIds = new Set(data.armor.map((a) => a.id))
  const itemIds = new Set(data.items.map((i) => i.id))
  const spellIds = new Set(data.spells.map((s) => s.id))
  const gearIds = new Set([...weaponIds, ...armorIds, ...itemIds])
  const magicSchoolIds = new Set(data.skills.filter((s) => s.kind === 'magic').map((s) => s.id))

  const checkUnique = (name: string, rows: { id: string }[]) => {
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.id)) err(`${name}: 중복 id "${row.id}"`)
      seen.add(row.id)
    }
  }

  const checkAttr = (where: string, attr: string) => {
    if (!ATTRIBUTES.includes(attr as AttributeId)) err(`${where}: 없는 능력치 "${attr}"`)
  }

  const checkEffects = (where: string, effects: { hook: string; params?: Record<string, unknown> }[]) => {
    for (const e of effects) {
      if (!KNOWN_HOOKS.includes(e.hook as EffectHook)) {
        err(`${where}: 알 수 없는 효과 훅 "${e.hook}"`)
        continue
      }
      const p = e.params ?? {}
      const needDice = ['damage', 'heal', 'healWp', 'drainWp', 'extraDamageDie', 'knockback']
      if (needDice.includes(e.hook)) {
        if (typeof p['dice'] !== 'string' || !isValidDice(p['dice'] as string)) {
          err(`${where}: 훅 "${e.hook}" 의 dice 가 잘못됨 (${JSON.stringify(p['dice'])})`)
        }
      }
      if (e.hook === 'condition') {
        const c = p['condition']
        if (c !== 'choice' && !CONDITION_IDS.includes(c as string)) {
          err(`${where}: 없는 상태이상 "${c}"`)
        }
      }
      if (e.hook === 'boon' || e.hook === 'bane' || e.hook === 'autoSuccess') {
        const roll = p['roll'] as { skills?: string[]; attribute?: string; all?: boolean } | undefined
        if (!roll) {
          err(`${where}: 훅 "${e.hook}" 에 roll 파라미터 없음`)
        } else {
          for (const s of roll.skills ?? []) {
            if (!skillIds.has(s)) err(`${where}: 훅 "${e.hook}" → 없는 스킬 "${s}"`)
          }
          if (roll.attribute) checkAttr(`${where} (roll.attribute)`, roll.attribute)
        }
      }
    }
  }

  /* ── 구간표: 구멍·겹침 검사 ── */
  const checkRanges = (name: string, rows: { min: number; max: number }[], lo: number, hi: number) => {
    const sorted = [...rows].sort((a, b) => a.min - b.min)
    let expect = lo
    for (const r of sorted) {
      if (r.min > r.max) err(`${name}: 구간 역전 (${r.min}~${r.max})`)
      if (r.min !== expect) err(`${name}: ${expect} 에서 구간이 끊김 (다음 구간 ${r.min})`)
      expect = r.max + 1
    }
    if (expect !== hi + 1) err(`${name}: 상한 ${hi} 까지 채워지지 않음 (마지막 ${expect - 1})`)
  }

  checkRanges('baseChanceTable', data.baseChanceTable, 1, 18)
  checkRanges('damageBonusTable', data.damageBonusTable, 1, 18)
  checkRanges('movementModTable', data.movementModTable, 1, 18)
  checkRanges('ageTable(D6)', data.ageTable.map((a) => a.roll), 1, 6)
  checkRanges('kin(D12)', data.kin.map((k) => k.roll), 1, 12)

  for (const row of data.damageBonusTable) {
    if (row.bonus !== null && !isValidDice(row.bonus)) {
      err(`damageBonusTable: 잘못된 주사위 "${row.bonus}"`)
    }
  }

  /* ── 상태이상: 6종, 능력치 1:1 ── */
  if (data.conditions.length !== 6) err(`conditions: 6종이어야 함 (현재 ${data.conditions.length})`)
  const condAttrs = new Set(data.conditions.map((c) => c.attribute))
  if (condAttrs.size !== 6) err('conditions: 능력치와 1:1 대응이 깨짐')

  /* ── 종족 ── */
  checkUnique('kin', data.kin)
  for (const k of data.kin) {
    for (const a of k.abilityIds) {
      if (!abilityIds.has(a)) err(`kin:${k.id} → 없는 능력 "${a}"`)
    }
    if (k.movement < 1) err(`kin:${k.id} 이동력이 1 미만`)
  }

  /* ── 스킬 ── */
  checkUnique('skills', data.skills)
  for (const s of data.skills) checkAttr(`skill:${s.id}`, s.attribute)
  const coreCount = data.skills.filter((s) => s.kind !== 'magic').length
  if (coreCount !== 30) err(`핵심 스킬은 30종이어야 함 (현재 ${coreCount})`)

  /* ── 능력 ── */
  checkUnique('abilities', data.abilities)
  for (const a of data.abilities as Ability[]) {
    if (a.requirement) {
      for (const s of a.requirement.skillIds) {
        if (!skillIds.has(s) && !REQUIREMENT_WILDCARDS.includes(s)) {
          err(`ability:${a.id} → 없는 요건 스킬 "${s}"`)
        }
      }
    }
    checkEffects(`ability:${a.id}`, a.effects)
  }

  /* ── 직업 ── */
  checkUnique('professions', data.professions)
  for (const p of data.professions) {
    checkAttr(`profession:${p.id}`, p.keyAttribute)
    const variants = p.variants ?? (p.skillIds ? [{ id: 'default', name: '', skillIds: p.skillIds }] : [])
    if (variants.length === 0) err(`profession:${p.id} 에 skillIds 도 variants 도 없음`)
    for (const v of variants) {
      if (v.skillIds.length !== 8) {
        err(`profession:${p.id}/${v.id}: 직업 스킬은 8종이어야 함 (현재 ${v.skillIds.length})`)
      }
      for (const s of v.skillIds) {
        if (!skillIds.has(s)) err(`profession:${p.id}/${v.id} → 없는 스킬 "${s}"`)
      }
    }
    for (const h of p.heroicAbilityIds) {
      if (!abilityIds.has(h)) err(`profession:${p.id} → 없는 영웅 능력 "${h}"`)
    }
    checkRanges(`profession:${p.id} gearSets(D6)`, p.gearSets.map((g) => g.roll), 1, 6)
    for (const set of p.gearSets) {
      if (!isValidDice(set.silver)) err(`profession:${p.id}: 잘못된 은화 주사위 "${set.silver}"`)
      for (const gi of set.items) {
        if (!gearIds.has(gi.itemId)) err(`profession:${p.id} 장비 세트 → 없는 아이템 "${gi.itemId}"`)
        if (typeof gi.qty === 'string' && !isValidDice(gi.qty)) {
          err(`profession:${p.id} → 잘못된 수량 주사위 "${gi.qty}"`)
        }
      }
    }
    if (p.nicknames.length !== 6) err(`profession:${p.id}: 별명은 6개여야 함`)
  }

  /* ── 무기 ── */
  checkUnique('weapons', data.weapons)
  for (const w of data.weapons) {
    if (!skillIds.has(w.skillId)) err(`weapon:${w.id} → 없는 스킬 "${w.skillId}"`)
    if (!isValidDice(w.damage)) err(`weapon:${w.id}: 잘못된 피해 주사위 "${w.damage}"`)
    if (typeof w.range === 'number' && w.range < 1) err(`weapon:${w.id}: 사거리가 1 미만`)
    if (w.durability !== null && w.durability < 1) err(`weapon:${w.id}: 내구도가 1 미만`)
    if (w.features.includes('noParry') && w.durability !== null) {
      err(`weapon:${w.id}: 패리 불가 무기는 durability 를 null 로`)
    }
  }

  /* ── 방어구 ── */
  checkUnique('armor', data.armor)
  for (const a of data.armor) {
    for (const s of a.baneSkillIds) {
      if (!skillIds.has(s)) err(`armor:${a.id} → 없는 스킬 "${s}"`)
    }
    if (a.rating < 1) err(`armor:${a.id}: 방어 등급이 1 미만`)
  }

  /* ── 아이템 ── */
  checkUnique('items', data.items)
  for (const i of data.items) {
    checkEffects(`item:${i.id}`, i.effects)
    if (i.weight < 0) err(`item:${i.id}: 무게가 음수`)
  }

  /* ── 주문 ── */
  checkUnique('spells', data.spells)
  for (const s of data.spells) {
    if (s.school !== 'general' && !magicSchoolIds.has(s.school)) {
      err(`spell:${s.id} → 없는 유파 "${s.school}"`)
    }
    if (s.kind === 'trick' && s.usesPowerLevel) {
      err(`spell:${s.id}: 트릭은 위력을 쓰지 않음`)
    }
    if (s.prerequisite?.spellId && !spellIds.has(s.prerequisite.spellId)) {
      err(`spell:${s.id} → 없는 전제 주문 "${s.prerequisite.spellId}"`)
    }
    if (
      s.prerequisite?.school &&
      s.prerequisite.school !== 'any' &&
      !magicSchoolIds.has(s.prerequisite.school)
    ) {
      err(`spell:${s.id} → 없는 전제 유파 "${s.prerequisite.school}"`)
    }
    if (s.range.kind === 'meters' && (s.range.meters ?? 0) < 1) {
      err(`spell:${s.id}: meters 사거리에 값이 없음`)
    }
    checkEffects(`spell:${s.id}`, s.effects)
    if (s.perPowerLevel) checkEffects(`spell:${s.id} (perPowerLevel)`, s.perPowerLevel)
  }

  /* ── 몬스터 ── */
  checkUnique('monsters', data.monsters)
  for (const m of data.monsters) {
    if (m.ferocity < 1) err(`monster:${m.id}: 흉포도가 1 미만`)
    if (m.hp < 1) err(`monster:${m.id}: HP가 1 미만`)
    if (m.attacks.length !== 6) {
      err(`monster:${m.id}: 공격표는 D6 — 6개여야 함 (현재 ${m.attacks.length})`)
    }
    const rolls = new Set(m.attacks.map((a) => a.roll))
    for (let n = 1; n <= 6; n++) {
      if (!rolls.has(n)) err(`monster:${m.id}: 공격표에 눈 ${n} 이 없음`)
    }
    for (const s of Object.keys(m.skills)) {
      if (!skillIds.has(s)) err(`monster:${m.id} → 없는 스킬 "${s}"`)
    }
    for (const atk of m.attacks) checkEffects(`monster:${m.id} 공격 ${atk.roll}`, atk.effects)
  }

  /* ── NPC ── */
  checkUnique('npcs', data.npcs)
  for (const n of data.npcs) {
    for (const s of Object.keys(n.skills)) {
      if (!skillIds.has(s)) err(`npc:${n.id} → 없는 스킬 "${s}"`)
    }
    for (const h of n.heroicAbilities) {
      if (!abilityIds.has(h.abilityId)) err(`npc:${n.id} → 없는 능력 "${h.abilityId}"`)
      if (h.count < 1) err(`npc:${n.id}: 능력 count 가 1 미만`)
    }
    for (const g of n.gearIds) {
      if (!gearIds.has(g)) err(`npc:${n.id} → 없는 장비 "${g}"`)
    }
    // 미니언은 WP 를 추적하지 않는다 — 단, 주문을 쓰는 미니언은 시전 자원으로 WP 가 필요하다.
    if (n.kind === 'minion' && n.wp !== null && !(n.spellIds && n.spellIds.length > 0)) {
      err(`npc:${n.id}: 미니언은 wp 를 null 로 (주문 보유 시 예외)`)
    }
    for (const sp of n.spellIds ?? []) {
      if (!spellIds.has(sp)) err(`npc:${n.id} → 없는 주문 "${sp}"`)
    }
    for (const [attr, die] of Object.entries(n.damageBonus)) {
      if (!['str', 'agl'].includes(attr)) err(`npc:${n.id}: 피해 보너스 능력치는 str/agl 만`)
      if (die && !isValidDice(die)) err(`npc:${n.id}: 잘못된 피해 보너스 "${die}"`)
    }
  }

  /* ── 동물 ── */
  checkUnique('animals', data.animals)
  for (const a of data.animals) {
    if (!isValidDice(a.attack.damage)) err(`animal:${a.id}: 잘못된 피해 표기 "${a.attack.damage}"`)
    if (a.attack.skillLevel < 1) err(`animal:${a.id}: 공격 스킬이 1 미만`)
    if (a.hp < 1) err(`animal:${a.id}: HP가 1 미만`)
    for (const s of Object.keys(a.skills)) {
      if (!skillIds.has(s)) err(`animal:${a.id} → 없는 스킬 "${s}"`)
    }
  }

  /* ── 굴림표 ── */
  checkUnique('tables', data.tables)
  for (const t of data.tables) {
    checkRanges(`table:${t.id}(D${t.die})`, t.rows, 1, t.die)
    for (const r of t.rows) checkEffects(`table:${t.id} ${r.min}~${r.max}`, r.effects)
  }

  return errors
}
