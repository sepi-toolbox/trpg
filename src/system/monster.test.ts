import { describe, expect, it } from 'vitest'
import { createRNG } from './rng'
import { loadGameData } from './load'
import {
  applyDamageToMonster,
  blockingSize,
  chooseMonsterAttack,
  monsterDefense,
  monsterInteractionRules,
  reactToMonsterAttack,
  refreshMonsterRound,
  rollMonsterAttack,
  spawnMonster,
  toppleMonster,
} from './monster'
import { combatantFromCharacter } from './combatant'
import { createCharacter } from './character'
import type { Combatant } from './combatant'

const data = loadGameData()

function pc(): Combatant {
  const c = createCharacter(createRNG(1), data, {
    name: '용사',
    kinId: 'human',
    professionId: 'fighter',
    ageId: 'adult',
    attributes: { str: 15, con: 14, agl: 13, int: 12, wil: 10, cha: 8 },
    trainedSkillIds: [
      'swords', 'axes', 'evade', 'brawling', 'spears', 'bows',
      'awareness', 'acrobatics', 'bushcraft', 'healing',
    ],
    heroicAbilityId: 'veteran',
    gearRoll: 1,
  })
  return combatantFromCharacter(data, c)
}

describe('소환·라운드', () => {
  it('흉포도만큼 행동 수를 갖고 시작한다', () => {
    const lurker = spawnMonster(data, 'marsh-lurker')
    expect(lurker.ferocity).toBe(2)
    expect(lurker.actionsLeft).toBe(2)
    const spent = { ...lurker, actionsLeft: 0 }
    expect(refreshMonsterRound(spent).actionsLeft).toBe(2)
  })
})

describe('공격표', () => {
  it('같은 눈 연속이면 다음 항목(6→1)', () => {
    const rng = createRNG(1)
    let m = spawnMonster(data, 'stonehide')
    const seen = new Set<number>()
    let prev: number | null = null
    for (let i = 0; i < 200; i++) {
      const out = rollMonsterAttack(rng, data, refreshMonsterRound(m))
      m = out.monster
      expect(out.pick.chosen).toBe(m.lastAttackRoll)
      if (prev !== null) expect(out.pick.chosen).not.toBe(prev)
      if (out.pick.rolled === prev) {
        expect(out.pick.chosen).toBe((out.pick.rolled % 6) + 1)
      }
      prev = out.pick.chosen
      seen.add(out.pick.chosen)
    }
    expect(seen.size).toBeGreaterThanOrEqual(5)
  })

  it('행동 수를 소모한다', () => {
    const rng = createRNG(2)
    const m = spawnMonster(data, 'marsh-lurker')
    const out = rollMonsterAttack(rng, data, m)
    expect(out.monster.actionsLeft).toBe(1)
  })

  it('직접 선택도 연속 제한을 지킨다', () => {
    const m = { ...spawnMonster(data, 'stonehide'), lastAttackRoll: 3 }
    expect(chooseMonsterAttack(data, m, 3)).toEqual({ rejected: 'repeat' })
    const ok = chooseMonsterAttack(data, m, 4)
    if ('rejected' in ok) throw new Error(ok.rejected)
    expect(ok.pick.attack.roll).toBe(4)
  })
})

describe('PC의 리액션', () => {
  const stomp = data.monsters.find((m) => m.id === 'stonehide')!.attacks
  const slam = stomp.find((a) => a.roll === 1)! // canParry+canDodge
  const roar = stomp.find((a) => a.roll === 4)! // 회피·패리 불가

  it('회피 불가 공격은 거부', () => {
    const out = reactToMonsterAttack(createRNG(3), data, pc(), roar, 'dodge')
    expect('rejected' in out && out.rejected).toBe('cannot-dodge')
  })

  it('canParry 공격만 패리 가능', () => {
    const sweep = stomp.find((a) => a.roll === 2)! // canParry: false
    const rejected = reactToMonsterAttack(createRNG(4), data, pc(), sweep, 'parry')
    expect('rejected' in rejected && rejected.rejected).toBe('cannot-parry')
    const ok = reactToMonsterAttack(createRNG(5), data, pc(), slam, 'parry')
    expect('rejected' in ok).toBe(false)
  })

  it('턴 소모한 방어자는 거부', () => {
    const acted = { ...pc(), acted: true }
    const out = reactToMonsterAttack(createRNG(6), data, acted, slam, 'dodge')
    expect('rejected' in out && out.rejected).toBe('already-acted')
  })
})

describe('몬스터 피해 — 방어구·저항·면역', () => {
  it('자연 방어구 차감 후 저항 절반(올림)', () => {
    const m = spawnMonster(data, 'stonehide') // 방어 3, 참격 저항
    const out = applyDamageToMonster(data, m, {
      total: 13, damageType: 'slashing', ignoreArmor: false,
    })
    // 13 - 3 = 10 → 절반 5
    expect(out.absorbed).toBe(3)
    expect(out.resisted).toBe(true)
    expect(out.taken).toBe(5)
    expect(out.monster.hp).toBe(44 - 5)
  })

  it('저항 절반은 올림', () => {
    const m = spawnMonster(data, 'stonehide')
    const out = applyDamageToMonster(data, m, {
      total: 8, damageType: 'slashing', ignoreArmor: false,
    })
    // 8-3=5 → ceil(2.5)=3
    expect(out.taken).toBe(3)
  })

  it('면역은 완전 무효', () => {
    const ghost = spawnMonster(data, 'marsh-lurker')
    const out = applyDamageToMonster(data, ghost, {
      total: 99, damageType: 'slashing', ignoreArmor: true,
    })
    expect(out.immune).toBe(true)
    expect(out.monster.hp).toBe(27)
  })

  it('유형 없는 피해(마법 등)는 면역·저항을 우회한다', () => {
    const ghost = spawnMonster(data, 'marsh-lurker')
    const out = applyDamageToMonster(data, ghost, {
      total: 10, damageType: null, ignoreArmor: true,
    })
    expect(out.taken).toBe(10)
  })

  it('0 HP → 사망(죽음 판정 없음)', () => {
    const m = spawnMonster(data, 'stonehide')
    const out = applyDamageToMonster(data, m, {
      total: 999, damageType: null, ignoreArmor: true,
    })
    expect(out.monster.dead).toBe(true)
  })
})

describe('몬스터의 회피·패리', () => {
  it('고정 15 판정, 행동 소모, 행동 없으면 거부', () => {
    const m = spawnMonster(data, 'stonehide') // 행동 1
    const out = monsterDefense(createRNG(7), data, m, { critical: false }, 'dodge')
    if ('rejected' in out) throw new Error(out.rejected)
    expect(out.result.target).toBe(15)
    expect(out.monster.actionsLeft).toBe(0)

    const again = monsterDefense(createRNG(8), data, out.monster, { critical: false }, 'dodge')
    expect('rejected' in again && again.rejected).toBe('no-actions-left')
  })

  it('무기 없는 몬스터는 패리 불가', () => {
    const m = spawnMonster(data, 'stonehide')
    const out = monsterDefense(createRNG(9), data, m, { critical: false }, 'parry', false)
    expect('rejected' in out && out.rejected).toBe('cannot-parry-unarmed')
  })

  it('크리티컬은 용으로만 방어', () => {
    for (let seed = 0; seed < 300; seed++) {
      const m = spawnMonster(data, 'stonehide')
      const out = monsterDefense(createRNG(seed), data, m, { critical: true }, 'dodge')
      if ('rejected' in out) continue
      if (out.avoided) expect(out.result.dragon).toBe(true)
    }
  })
})

describe('몬스터 상대 특수 규칙', () => {
  it('넘어뜨리기: EVADE 15 고정, 성공 시 prone', () => {
    let toppled = false
    for (let seed = 0; seed < 300 && !toppled; seed++) {
      const out = toppleMonster(createRNG(seed), data, pc(), 'broadsword', spawnMonster(data, 'stonehide'))
      if (out.success) {
        toppled = true
        expect(out.monster.prone).toBe(true)
      }
    }
    expect(toppled).toBe(true)
  })

  it('상호작용 규칙: 무장 해제·붙잡기·밀치기·공포·독 불가, 설득은 데이터', () => {
    const rules = monsterInteractionRules(data, 'stonehide')
    expect(rules.canDisarm).toBe(false)
    expect(rules.canGrapple).toBe(false)
    expect(rules.immuneToFear).toBe(true)
    expect(rules.persuadable).toBe(false)
    expect(monsterInteractionRules(data, 'marsh-lurker').persuadable).toBe(true)
  })

  it('크기 → 봉쇄 면적', () => {
    expect(blockingSize('small')).toBe(0)
    expect(blockingSize('normal')).toBe(2)
    expect(blockingSize('large')).toBe(4)
    expect(blockingSize('huge')).toBe(8)
    expect(blockingSize('swarm')).toBe(0)
  })
})
