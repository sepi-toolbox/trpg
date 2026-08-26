import classesJson from './classes.json'
import weaponsJson from './weapons.json'
import armorJson from './armor.json'
import skillsJson from './skills.json'
import monstersJson from './monsters.json'
import dungeonJson from './dungeon.json'

import type {
  ArmorPiece,
  ClassDef,
  MonsterDef,
  SkillDef,
  Weapon,
} from '../rules/types'
import { parseDice } from '../rules/dice'

export interface FloorDef {
  depth: number
  name: string
  trapDc: number
  trapDamage: string
  treasure: string
  encounters: { monsterId: string; count: number; weight: number }[]
}

export interface DungeonDef {
  roomsPerFloor: number
  roomTable: { kind: RoomKind; weight: number }[]
  floors: FloorDef[]
}

export type RoomKind = 'combat' | 'treasure' | 'trap' | 'rest' | 'shrine'

export const CLASSES = classesJson as ClassDef[]
export const WEAPONS = weaponsJson as Weapon[]
export const ARMOR = armorJson as ArmorPiece[]
export const SKILLS = skillsJson as SkillDef[]
export const MONSTERS = monstersJson as MonsterDef[]
export const DUNGEON = dungeonJson as DungeonDef

function index<T extends { id: string }>(rows: T[]): Record<string, T> {
  const map: Record<string, T> = {}
  for (const row of rows) {
    if (map[row.id]) throw new Error(`중복 id: ${row.id}`)
    map[row.id] = row
  }
  return map
}

export const CLASS_BY_ID = index(CLASSES)
export const WEAPON_BY_ID = index(WEAPONS)
export const ARMOR_BY_ID = index(ARMOR)
export const SKILL_BY_ID = index(SKILLS)
export const MONSTER_BY_ID = index(MONSTERS)

/**
 * 데이터 테이블 무결성 검사.
 * 참조 깨짐과 잘못된 주사위 표기를 빌드/테스트 시점에 잡는다.
 * 테이블을 손으로 고치는 작업이라 런타임까지 끌고 가면 늦다.
 */
export function validateData(): string[] {
  const errors: string[] = []

  const checkDice = (where: string, notation: string) => {
    try {
      parseDice(notation)
    } catch (e) {
      errors.push(`${where}: ${(e as Error).message}`)
    }
  }

  for (const c of CLASSES) {
    checkDice(`class:${c.id}.hitDie`, c.hitDie)
    if (!WEAPON_BY_ID[c.startingWeapon])
      errors.push(`class:${c.id} → 없는 무기 "${c.startingWeapon}"`)
    if (!ARMOR_BY_ID[c.startingArmor])
      errors.push(`class:${c.id} → 없는 방어구 "${c.startingArmor}"`)
    for (const s of c.skills) {
      if (!SKILL_BY_ID[s]) errors.push(`class:${c.id} → 없는 기술 "${s}"`)
    }
  }

  for (const w of WEAPONS) checkDice(`weapon:${w.id}.damage`, w.damage)

  for (const s of SKILLS) checkDice(`skill:${s.id}.power`, s.power)

  for (const m of MONSTERS) {
    checkDice(`monster:${m.id}.hp`, m.hp)
    checkDice(`monster:${m.id}.damage`, m.damage)
  }

  const roomWeight = DUNGEON.roomTable.reduce((a, r) => a + r.weight, 0)
  if (roomWeight <= 0) errors.push('dungeon.roomTable 가중치 합이 0입니다')

  for (const f of DUNGEON.floors) {
    checkDice(`floor:${f.depth}.trapDamage`, f.trapDamage)
    checkDice(`floor:${f.depth}.treasure`, f.treasure)
    if (f.encounters.length === 0)
      errors.push(`floor:${f.depth} 조우표가 비어 있습니다`)
    for (const e of f.encounters) {
      if (!MONSTER_BY_ID[e.monsterId])
        errors.push(`floor:${f.depth} → 없는 몬스터 "${e.monsterId}"`)
      if (e.count < 1) errors.push(`floor:${f.depth} → count가 1 미만`)
      if (e.weight <= 0) errors.push(`floor:${f.depth} → weight가 0 이하`)
    }
  }

  return errors
}
