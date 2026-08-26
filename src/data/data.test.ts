import { describe, expect, it } from 'vitest'
import {
  ARMOR,
  CLASSES,
  DUNGEON,
  MONSTERS,
  SKILLS,
  WEAPONS,
  validateData,
} from './index'
import { diceRange } from '../rules/dice'

describe('데이터 테이블 무결성', () => {
  it('참조 깨짐이나 잘못된 주사위 표기가 없다', () => {
    expect(validateData()).toEqual([])
  })

  it('테이블이 비어 있지 않다', () => {
    expect(CLASSES.length).toBeGreaterThan(0)
    expect(WEAPONS.length).toBeGreaterThan(0)
    expect(ARMOR.length).toBeGreaterThan(0)
    expect(SKILLS.length).toBeGreaterThan(0)
    expect(MONSTERS.length).toBeGreaterThan(0)
    expect(DUNGEON.floors.length).toBeGreaterThan(0)
  })
})

describe('밸런스 가드레일', () => {
  it('층이 깊어질수록 난이도가 단조 증가한다', () => {
    const floors = DUNGEON.floors
    for (let i = 1; i < floors.length; i++) {
      expect(floors[i]!.depth).toBe(floors[i - 1]!.depth + 1)
      expect(floors[i]!.trapDc).toBeGreaterThanOrEqual(floors[i - 1]!.trapDc)
      expect(diceRange(floors[i]!.treasure).avg).toBeGreaterThan(
        diceRange(floors[i - 1]!.treasure).avg,
      )
    }
  })

  it('몬스터 레벨이 오르면 기대 데미지도 오른다', () => {
    const sorted = [...MONSTERS].sort((a, b) => a.level - b.level)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.level === sorted[i - 1]!.level) continue
      expect(diceRange(sorted[i]!.damage).avg).toBeGreaterThanOrEqual(
        diceRange(sorted[i - 1]!.damage).avg,
      )
    }
  })

  it('무기 기대 데미지가 상식적인 범위 안에 있다', () => {
    for (const w of WEAPONS) {
      const { avg } = diceRange(w.damage)
      expect(avg).toBeGreaterThanOrEqual(3)
      expect(avg).toBeLessThanOrEqual(8)
      expect(w.critRange).toBeGreaterThanOrEqual(18)
      expect(w.critRange).toBeLessThanOrEqual(20)
    }
  })

  it('공격 기술은 같은 클래스 기본 무기보다 기대 데미지가 높다', () => {
    for (const cls of CLASSES) {
      const weapon = WEAPONS.find((w) => w.id === cls.startingWeapon)!
      const weaponAvg = diceRange(weapon.damage).avg
      const attackSkills = cls.skills
        .map((id) => SKILLS.find((s) => s.id === id)!)
        .filter((s) => s.kind === 'attack')
      for (const s of attackSkills) {
        expect(diceRange(s.power).avg).toBeGreaterThan(weaponAvg)
      }
    }
  })
})
