import { describe, expect, it } from 'vitest'
import { createRNG } from './rng'
import { loadGameData } from './load'
import {
  applyDamage,
  canSwapInitiative,
  checkAttackerWeaponDurability,
  checkParryDurability,
  deathRoll,
  drawInitiative,
  findWeakSpotContext,
  gatherMods,
  rollAttack,
  rollDamage,
  trySaveLife,
  trySpecialDisarm,
  trySpecialTopple,
  tryDodge,
  tryParry,
} from './combat'
import type { AttackRoll } from './combat'
import { combatantFromCharacter, combatantFromNpc, strRequirementState, armorRating } from './combatant'
import type { Combatant } from './combatant'
import { createCharacter } from './character'
import type { RNG } from './rng'

const data = loadGameData()

function pc(seed = 1): Combatant {
  const c = createCharacter(createRNG(seed), data, {
    name: '전투자',
    kinId: 'human',
    professionId: 'fighter',
    ageId: 'adult',
    attributes: { str: 15, con: 14, agl: 13, int: 12, wil: 10, cha: 8 },
    trainedSkillIds: [
      'swords', 'axes', 'evade', 'brawling', 'spears', 'bows',
      'awareness', 'acrobatics', 'bushcraft', 'healing',
    ],
    heroicAbilityId: 'veteran',
    gearRoll: 1, // 브로드소드 + 소형 방패 + 사슬 갑옷
  })
  return combatantFromCharacter(data, c)
}

function guard(uid = 'g1'): Combatant {
  return combatantFromNpc(data, 'guard', uid)
}

/** 명중할 때까지 굴려 AttackRoll 을 얻는다 */
function hitAttack(rng: RNG, attacker: Combatant, defender: Combatant, overrides = {}): AttackRoll {
  for (let i = 0; i < 500; i++) {
    const atk = rollAttack(rng, data, attacker, attacker.drawnWeaponIds[0]!, defender, {
      kind: 'melee',
      damageType: 'slashing',
      ...overrides,
    })
    if ('rejected' in atk) throw new Error(atk.rejected)
    if (atk.result.success) return atk
  }
  throw new Error('명중을 얻지 못함')
}

describe('선제 카드', () => {
  it('참가자 전원이 서로 다른 카드를 받는다', () => {
    const rng = createRNG(10)
    const out = drawInitiative(rng, [
      { combatantId: 'a', cards: 1 },
      { combatantId: 'b', cards: 1 },
      { combatantId: 'c', cards: 3 }, // 흉포도 3
    ])
    const all = out.flatMap((o) => o.cards)
    expect(all).toHaveLength(5)
    expect(new Set(all).size).toBe(5)
    for (const card of all) expect(card).toBeGreaterThanOrEqual(1)
  })

  it('총 카드가 10을 넘으면 덱이 확장된다', () => {
    const rng = createRNG(11)
    const out = drawInitiative(rng, [
      { combatantId: 'a', cards: 6 },
      { combatantId: 'b', cards: 6 },
    ])
    const all = out.flatMap((o) => o.cards)
    expect(all).toHaveLength(12)
    expect(new Set(all).size).toBe(12)
  })

  it('기습 성공자는 가장 낮은 카드를 가져간다', () => {
    const rng = createRNG(12)
    const out = drawInitiative(rng, [
      { combatantId: 'sneak', cards: 1, choosesCard: true },
      { combatantId: 'x', cards: 1 },
      { combatantId: 'y', cards: 1 },
    ])
    const sneak = out.find((o) => o.combatantId === 'sneak')!
    expect(sneak.cards[0]).toBe(1)
  })

  it('대기 교환은 뒤 순번 + 미행동 상대만', () => {
    expect(canSwapInitiative(3, 7, false)).toBe(true)
    expect(canSwapInitiative(3, 2, false)).toBe(false)
    expect(canSwapInitiative(3, 7, true)).toBe(false)
  })
})

describe('판정 보정 집계', () => {
  it('상태이상과 장비 페널티가 베인으로 합산된다', () => {
    const c = pc()
    // 사슬 갑옷: evade·sneaking 베인
    expect(gatherMods(data, c, 'evade').banes).toBe(1)
    // 겁먹음(WIL) 은 evade(AGL)와 무관
    const scared = { ...c, conditions: ['scared' as const] }
    expect(gatherMods(data, scared, 'evade').banes).toBe(1)
    // 휘청임(AGL)은 evade 에 베인 추가
    const dazed = { ...c, conditions: ['dazed' as const] }
    expect(gatherMods(data, dazed, 'evade').banes).toBe(2)
  })
})

describe('STR 요구', () => {
  it('미달 베인, 절반 미만 사용 불가, 양손 그립 -3', () => {
    const c = pc()
    const weak = { ...c, attributes: { ...c.attributes!, str: 8 } }
    // 브로드소드 STR 10: 8이면 베인
    expect(strRequirementState(data, weak, 'broadsword')).toBe('bane')
    // 양손 그립이면 요구 7 → ok
    expect(strRequirementState(data, weak, 'broadsword', true)).toBe('ok')
    const feeble = { ...c, attributes: { ...c.attributes!, str: 4 } }
    expect(strRequirementState(data, feeble, 'broadsword')).toBe('unusable')
    // NPC 는 항상 ok
    expect(strRequirementState(data, guard(), 'broadsword')).toBe('ok')
  })
})

describe('명중 판정', () => {
  it('용이면 크리티컬, 마면 사고표(토글)', () => {
    const rng = createRNG(100)
    const a = pc()
    const d = guard()
    let sawCrit = false
    let sawMishap = false
    for (let i = 0; i < 3000 && !(sawCrit && sawMishap); i++) {
      const atk = rollAttack(rng, data, a, 'broadsword', d, { kind: 'melee', damageType: 'slashing' })
      if ('rejected' in atk) continue
      if (atk.critical) {
        sawCrit = true
        expect(atk.result.dragon).toBe(true)
      }
      if (atk.result.demon) {
        sawMishap = true
        expect(atk.mishap).not.toBeNull()
      }
    }
    expect(sawCrit).toBe(true)
    expect(sawMishap).toBe(true)
  })

  it('뽑지 않은/파손된 무기는 거부', () => {
    const rng = createRNG(101)
    const a = pc()
    const d = guard()
    expect(rollAttack(rng, data, a, 'knife', d, { kind: 'melee', damageType: null })).toEqual({
      rejected: 'not-drawn',
    })
    const broken = { ...a, damagedWeaponIds: ['broadsword'] }
    expect(
      rollAttack(rng, data, broken, 'broadsword', d, { kind: 'melee', damageType: null }),
    ).toEqual({ rejected: 'weapon-damaged' })
  })

  it('엎드린 대상 근접 공격은 보온 + 피해 보너스 플래그', () => {
    const rng = createRNG(102)
    const a = pc()
    const d = { ...guard(), prone: true }
    const atk = rollAttack(rng, data, a, 'broadsword', d, { kind: 'melee', damageType: 'slashing' })
    if ('rejected' in atk) throw new Error('rejected')
    expect(atk.proneBonus).toBe(true)
    expect(atk.result.mode).toBe('boon')
  })
})

describe('리액션', () => {
  it('턴을 소모한 방어자는 리액션 불가', () => {
    const rng = createRNG(200)
    const a = pc()
    const d = { ...guard(), acted: true }
    const atk = hitAttack(rng, a, d)
    expect('rejected' in tryParry(rng, data, d, atk, d.drawnWeaponIds[0]!)).toBe(true)
    expect('rejected' in tryDodge(rng, data, d, atk)).toBe(true)
  })

  it('암습은 패리·회피 불가', () => {
    const rng = createRNG(201)
    const a = pc()
    const d = guard()
    const atk = hitAttack(rng, a, d, { sneak: true })
    const parry = tryParry(rng, data, d, atk, d.drawnWeaponIds[0]!)
    expect('rejected' in parry && parry.rejected).toBe('sneak-attack')
  })

  it('원거리 공격 패리는 방패 필요', () => {
    const rng = createRNG(202)
    const archer = pc(2)
    const d = guard() // 브로드소드만 있음
    const atk = hitAttack(rng, archer, d, { kind: 'ranged' })
    const parry = tryParry(rng, data, d, atk, d.drawnWeaponIds[0]!)
    expect('rejected' in parry && parry.rejected).toBe('shield-required')
  })

  it('크리티컬은 용을 굴려야만 막는다', () => {
    const rng = createRNG(203)
    const a = pc()
    const d = guard()
    // 크리티컬 공격을 얻는다
    let crit: AttackRoll | null = null
    for (let i = 0; i < 5000 && !crit; i++) {
      const atk = rollAttack(rng, data, a, 'broadsword', d, { kind: 'melee', damageType: 'slashing' })
      if (!('rejected' in atk) && atk.critical) crit = atk
    }
    expect(crit).not.toBeNull()
    // 패리·회피 결과가 용이 아닌 성공이면 막지 못한다
    for (let i = 0; i < 300; i++) {
      const parry = tryParry(rng, data, d, crit!, d.drawnWeaponIds[0]!)
      if ('rejected' in parry) continue
      if (parry.parried) expect(parry.result.dragon).toBe(true)
      const dodge = tryDodge(rng, data, d, crit!)
      if (!('rejected' in dodge) && dodge.dodged) expect(dodge.result.dragon).toBe(true)
    }
  })

  it('용 패리는 반격 — 단 크리티컬 공격에는 없음', () => {
    const rng = createRNG(204)
    const a = pc()
    const d = guard()
    let sawCounter = false
    for (let i = 0; i < 5000 && !sawCounter; i++) {
      const atk = hitAttack(rng, a, d)
      if (atk.critical) continue
      const parry = tryParry(rng, data, d, atk, d.drawnWeaponIds[0]!)
      if ('rejected' in parry) continue
      if (parry.counterattack) {
        sawCounter = true
        expect(parry.result.dragon).toBe(true)
        expect(parry.parried).toBe(true)
      }
    }
    expect(sawCounter).toBe(true)
  })
})

describe('피해', () => {
  it('방어구가 피해를 줄이고, 유형 보정(옵션)이 적용된다', () => {
    const d = guard() // 징 박은 가죽 2
    expect(armorRating(data, d, null)).toBe(2)
    // 타격에는 +2 (옵션 룰 on)
    expect(armorRating(data, d, 'bludgeoning')).toBe(4)
  })

  it('크리티컬 doubleDice 는 무기 주사위만 2배', () => {
    const rng = createRNG(300)
    const a = pc()
    const d = guard()
    const atk = hitAttack(rng, a, d)
    const dmg = rollDamage(rng, data, a, atk, 'doubleDice')
    // 브로드소드 2D6 → 4개
    expect(dmg.weaponDice).toHaveLength(4)
  })

  it('암습 + subtle 무기는 주사위 +1', () => {
    const rng = createRNG(301)
    const rogue = pc()
    rogue.drawnWeaponIds = ['knife']
    rogue.weaponsAtHand = ['knife']
    const d = guard()
    const atk = hitAttack(rng, { ...rogue }, d, { sneak: true })
    const dmg = rollDamage(rng, data, rogue, atk, null)
    // 나이프 D8 → 2개
    expect(dmg.weaponDice).toHaveLength(2)
  })

  it('완전 흡수된 근접 피해는 공격 무기에 반사된다', () => {
    const d = { ...pc(), armorId: 'plate-armor', helmetId: 'great-helm' } // 방어구 8
    const dmg = {
      total: 5, weaponDice: [5], bonusDice: [], ignoreArmor: false,
      damageType: 'slashing' as const, breakdown: '5',
    }
    const applied = applyDamage(data, d, dmg, { melee: true })
    expect(applied.taken).toBe(0)
    expect(applied.reflectedToWeapon).toBe(5)
  })

  it('0 HP 도달 → 쓰러짐 + 죽음 판정 시작 (PC)', () => {
    const d = { ...pc(), hp: 3 }
    const dmg = {
      total: 5, weaponDice: [5], bonusDice: [], ignoreArmor: true,
      damageType: null, breakdown: '20',
    }
    const applied = applyDamage(data, d, dmg, { melee: false })
    expect(applied.defender.hp).toBe(0)
    expect(applied.droppedToZero).toBe(true)
    expect(applied.defender.prone).toBe(true)
    expect(applied.defender.deathRolls).toEqual({ successes: 0, failures: 0 })
    expect(applied.defender.dead).toBe(false)
  })

  it('한 방 과잉 피해 = 즉사', () => {
    const d = { ...pc(), hp: 5 } // maxHp 14
    const dmg = {
      total: 5 + 14, weaponDice: [19], bonusDice: [], ignoreArmor: true,
      damageType: null, breakdown: '19',
    }
    const applied = applyDamage(data, d, dmg, { melee: false })
    expect(applied.instantDeath).toBe(true)
    expect(applied.defender.dead).toBe(true)
  })

  it('0 HP 에서 추가 피해 = 죽음 판정 실패 1회', () => {
    const d = { ...pc(), hp: 0, prone: true, deathRolls: { successes: 0, failures: 1 } }
    const dmg = {
      total: 3, weaponDice: [3], bonusDice: [], ignoreArmor: true,
      damageType: null, breakdown: '3',
    }
    const applied = applyDamage(data, d, dmg, { melee: false })
    expect(applied.defender.deathRolls?.failures).toBe(2)
  })

  it('NPC 는 0 HP 에서 즉시 무력화', () => {
    const d = { ...guard(), hp: 2 }
    const dmg = {
      total: 10, weaponDice: [10], bonusDice: [], ignoreArmor: true,
      damageType: null, breakdown: '10',
    }
    expect(applyDamage(data, d, dmg, { melee: false }).defender.dead).toBe(true)
  })
})

describe('내구도', () => {
  it('패리 피해가 내구도를 넘으면 무기 파손, 관통은 예외', () => {
    const d = guard()
    const big = {
      total: 99, weaponDice: [99], bonusDice: [], ignoreArmor: false,
      damageType: 'slashing' as const, breakdown: '99',
    }
    const out = checkParryDurability(data, d, d.drawnWeaponIds[0]!, big)
    expect(out.broken).toBe(true)
    const pierce = { ...big, damageType: 'piercing' as const }
    expect(checkParryDurability(data, d, d.drawnWeaponIds[0]!, pierce).broken).toBe(false)
  })

  it('반사 피해도 내구도 검사', () => {
    const a = pc()
    expect(checkAttackerWeaponDurability(data, a, 'broadsword', 99).broken).toBe(true)
    expect(checkAttackerWeaponDurability(data, a, 'broadsword', 3).broken).toBe(false)
  })
})

describe('특수 공격', () => {
  it('넘어뜨리기 성공 시 prone', () => {
    const rng = createRNG(400)
    const a = pc()
    a.drawnWeaponIds = ['staff'] // toppling 보온
    a.weaponsAtHand = ['staff']
    let toppled = false
    for (let i = 0; i < 200 && !toppled; i++) {
      const out = trySpecialTopple(rng, data, a, 'staff', guard())
      if (out.success) {
        toppled = true
        expect(out.defender.prone).toBe(true)
      }
    }
    expect(toppled).toBe(true)
  })

  it('무장 해제: 방패는 거부, 성공 시 무기 이탈', () => {
    const rng = createRNG(401)
    const a = pc()
    const shieldGuy = pc(3)
    const rejected = trySpecialDisarm(rng, data, a, 'broadsword', shieldGuy, 'shield-small')
    expect(rejected.rejected).toBeTruthy()

    let disarmed = false
    for (let i = 0; i < 300 && !disarmed; i++) {
      const out = trySpecialDisarm(rng, data, a, 'broadsword', guard(), 'broadsword')
      if (out.success) {
        disarmed = true
        expect(out.defender.drawnWeaponIds).not.toContain('broadsword')
        expect(out.distance).toBeGreaterThanOrEqual(1)
      }
    }
    expect(disarmed).toBe(true)
  })

  it('약점 찌르기: 베인 추가 + 관통 강제', () => {
    const ctx = findWeakSpotContext({ kind: 'melee', damageType: 'slashing' })
    expect(ctx.damageType).toBe('piercing')
    expect(ctx.extra?.banes).toBe(1)
  })
})

describe('죽음 판정', () => {
  const dying = (): Combatant => ({
    ...pc(), hp: 0, prone: true, deathRolls: { successes: 0, failures: 0 },
  })

  it('3성공 → D6 회복, 3실패 → 사망, 용/마 = 2배', () => {
    const rng = createRNG(500)
    let recovered = 0
    let died = 0
    for (let seed = 0; seed < 200; seed++) {
      let c: Combatant = dying()
      let guard2 = 0
      while (!c.dead && c.deathRolls && guard2++ < 20) {
        const out = deathRoll(createRNG(seed * 31 + guard2), c)
        if (out.roll.dragon) expect(out.successesAdded).toBe(2)
        if (out.roll.demon) expect(out.failuresAdded).toBe(2)
        c = out.combatant
        if (out.recovered) {
          recovered++
          expect(c.hp).toBeGreaterThanOrEqual(1)
          expect(c.hp).toBeLessThanOrEqual(6)
          break
        }
        if (out.died) {
          died++
          expect(c.dead).toBe(true)
          break
        }
      }
    }
    expect(recovered).toBeGreaterThan(0)
    expect(died).toBeGreaterThan(0)
    void rng
  })

  it('소생: 성공 시 죽음 판정 중단 + D6 HP', () => {
    const rng = createRNG(501)
    const healer = pc(4)
    let saved = false
    for (let i = 0; i < 300 && !saved; i++) {
      const out = trySaveLife(rng, data, healer, dying(), true)
      if (out.saved) {
        saved = true
        expect(out.target.hp).toBeGreaterThanOrEqual(1)
        expect(out.target.deathRolls).toBeNull()
      }
    }
    expect(saved).toBe(true)
  })
})
