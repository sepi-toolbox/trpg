import { describe, expect, it } from 'vitest'
import { createRNG } from './rng'
import { loadGameData } from './load'
import {
  KM_PER_SHIFT_FOOT,
  KM_PER_SHIFT_MOUNTED,
  cook,
  fish,
  forage,
  forcedMarch,
  hunt,
  makeCamp,
  pathfind,
} from './journey'
import {
  burnShift,
  damageObject,
  extinguishRoll,
  formatSilver,
  lightSourceFromItem,
  mastercrafted,
  repairWeapon,
  toSilver,
} from './gear'
import { combatantFromCharacter, weaponOf } from './combatant'
import { createCharacter } from './character'
import type { Traveler } from './journey'

const data = loadGameData()

const traveler = (overrides: Partial<Traveler> = {}): Traveler => ({
  skillLevels: { bushcraft: 12, 'hunting-fishing': 12, bows: 12 },
  conditions: [],
  ...overrides,
})

/* ─────────── 장비 세부 (8단계) ─────────── */

describe('화폐', () => {
  it('환산과 표시', () => {
    expect(toSilver({ amount: 3, unit: 'gold' })).toBe(30)
    expect(toSilver({ amount: 5, unit: 'copper' })).toBe(0.5)
    expect(formatSilver(123.4)).toEqual({ gold: 12, silver: 3, copper: 4 })
  })
})

describe('명품', () => {
  it('가격 ×10, STR −3, 내구도 +3', () => {
    const base = weaponOf(data, 'broadsword')
    const master = mastercrafted(base)
    expect(master.cost!.amount).toBe(base.cost!.amount * 10)
    expect(master.strRequirement).toBe(base.strRequirement! - 3)
    expect(master.durability).toBe(base.durability! + 3)
  })
})

describe('수리', () => {
  const crafter = () => {
    const c = createCharacter(createRNG(1), data, {
      name: '장인',
      kinId: 'human',
      professionId: 'fighter',
      ageId: 'adult',
      attributes: { str: 15, con: 14, agl: 13, int: 12, wil: 10, cha: 8 },
      trainedSkillIds: [
        'swords', 'axes', 'evade', 'brawling', 'spears', 'bows',
        'crafting', 'awareness', 'bushcraft', 'healing',
      ],
      heroicAbilityId: 'veteran',
      gearRoll: 1,
    })
    return { ...combatantFromCharacter(data, c), damagedWeaponIds: ['broadsword'] }
  }

  it('도구 없음·파손 아님 거부, 성공 시 파손 해제', () => {
    expect(repairWeapon(createRNG(2), data, crafter(), 'knife', true)).toEqual({
      rejected: 'not-damaged',
    })
    expect(repairWeapon(createRNG(3), data, crafter(), 'broadsword', false)).toEqual({
      rejected: 'no-tools',
    })
    let repaired = false
    for (let seed = 0; seed < 100 && !repaired; seed++) {
      const out = repairWeapon(createRNG(seed), data, crafter(), 'broadsword', true)
      if ('rejected' in out) continue
      if (out.repaired) {
        repaired = true
        expect(out.crafter.damagedWeaponIds).not.toContain('broadsword')
      }
    }
    expect(repaired).toBe(true)
  })
})

describe('광원', () => {
  it('꺼짐 판정(1이면 꺼짐)과 연료 소진', () => {
    const torch = { ...lightSourceFromItem(data, 'torch'), lit: true }
    let wentOutSeen = false
    let stayedSeen = false
    for (let seed = 0; seed < 100; seed++) {
      const out = extinguishRoll(createRNG(seed), data, torch)
      if (out.wentOut) {
        wentOutSeen = true
        expect(out.source.lit).toBe(false)
      } else stayedSeen = true
    }
    expect(wentOutSeen && stayedSeen).toBe(true)

    const burned = burnShift(torch)
    expect(burned.wentOut).toBe(true)
    expect(burned.source.fuelShifts).toBe(0)
  })
})

describe('물체 파괴', () => {
  it('자동 명중 — 방어 등급 차감, 0 HP 파괴', () => {
    const door = { hp: 10, armorRating: 3 }
    const out = damageObject(createRNG(5), door, '2D8')
    expect(out.taken).toBeGreaterThanOrEqual(0)
    const smashed = damageObject(createRNG(6), door, '99')
    expect(smashed.destroyed).toBe(true)
  })
})

/* ─────────── 여정 (9단계) ─────────── */

describe('이동·강행군', () => {
  it('상수', () => {
    expect(KM_PER_SHIFT_FOOT).toBe(15)
    expect(KM_PER_SHIFT_MOUNTED).toBe(30)
  })

  it('강행군: 탈진 부여, 이미 탈진·3시프트 초과 거부', () => {
    const out = forcedMarch(traveler(), 2)
    if ('rejected' in out) throw new Error(out.rejected)
    expect(out.conditions).toContain('exhausted')

    expect(forcedMarch(traveler({ conditions: ['exhausted'] }), 2)).toEqual({
      rejected: 'already-exhausted',
    })
    expect(forcedMarch(traveler(), 3)).toEqual({ rejected: 'over-limit' })
  })
})

describe('길찾기', () => {
  it('용 = 거리 2배, 실패 = 사고표, 지도 없으면 베인', () => {
    let sawDouble = false
    let sawMishap = false
    for (let seed = 0; seed < 500 && !(sawDouble && sawMishap); seed++) {
      const out = pathfind(createRNG(seed), data, traveler(), { hasMap: true })
      if (out.roll.dragon) {
        sawDouble = true
        expect(out.distanceFactor).toBe(2)
      }
      if (!out.roll.success && !out.roll.dragon) {
        sawMishap = true
        expect(out.mishap).not.toBeNull()
      }
    }
    expect(sawDouble && sawMishap).toBe(true)

    const noMap = pathfind(createRNG(1), data, traveler(), {})
    expect(noMap.roll.mode).toBe('bane')
  })

  it('사고표의 거리 배율이 반영된다', () => {
    for (let seed = 0; seed < 500; seed++) {
      const out = pathfind(createRNG(seed), data, traveler(), { hasMap: true })
      if (out.mishap?.extra?.['distanceFactor'] !== undefined) {
        expect(out.distanceFactor).toBe(out.mishap.extra['distanceFactor'])
      }
    }
  })
})

describe('야영', () => {
  it('침낭 모피 없으면 베인, 텐트는 보온', () => {
    expect(makeCamp(createRNG(1), data, traveler(), {}).roll.mode).toBe('bane')
    expect(
      makeCamp(createRNG(2), data, traveler(), { hasSleepingFur: true, usingTent: true }).roll.mode,
    ).toBe('boon')
  })
})

describe('사냥·낚시·채집·조리', () => {
  it('사냥: 추적 → 사냥감 → 처치 → 식량. 멧돼지 역습', () => {
    let gotFood = false
    let sawBoarAttack = false
    let sawTrapReject = false
    for (let seed = 0; seed < 800; seed++) {
      const w = hunt(createRNG(seed), data, traveler(), { kind: 'weapon', weaponSkillId: 'bows' })
      if (w.rations > 0) {
        gotFood = true
        expect(w.killRoll?.success).toBe(true)
      }
      if (w.attackedByPrey) {
        sawBoarAttack = true
        expect(w.animal?.extra?.['attacksOnFailure']).toBe(true)
      }
      const t = hunt(createRNG(seed), data, traveler(), { kind: 'trap' })
      if (t.rejected === 'trap-not-allowed') {
        sawTrapReject = true
        expect(t.animal?.extra?.['trapAllowed']).not.toBe(true)
      }
    }
    expect(gotFood).toBe(true)
    expect(sawBoarAttack).toBe(true)
    expect(sawTrapReject).toBe(true)
  })

  it('낚시: 낚싯대 1~4, 그물 1~6', () => {
    for (let seed = 0; seed < 200; seed++) {
      const rod = fish(createRNG(seed), data, traveler(), 'rod')
      if (rod.rations > 0) expect(rod.rations).toBeLessThanOrEqual(4)
      const net = fish(createRNG(seed + 1000), data, traveler(), 'net')
      if (net.rations > 0) expect(net.rations).toBeLessThanOrEqual(6)
    }
  })

  it('채집: 겨울 베인·가을 보온, 성공 시 1~3', () => {
    expect(forage(createRNG(1), data, traveler(), 'winter').roll.mode).toBe('bane')
    expect(forage(createRNG(2), data, traveler(), 'fall').roll.mode).toBe('boon')
    for (let seed = 0; seed < 100; seed++) {
      const out = forage(createRNG(seed), data, traveler(), 'summer')
      if (out.rations > 0) expect(out.rations).toBeLessThanOrEqual(3)
    }
  })

  it('조리: 시프트당 최대 10식, 실패 = 날 것', () => {
    const out = cook(createRNG(3), data, traveler(), 15)
    expect(out.cooked + out.raw).toBe(10)
    const kitchen = cook(createRNG(4), data, traveler(), 15, { unlimitedBatch: true })
    expect(kitchen.cooked + kitchen.raw).toBe(15)
  })
})
