/**
 * data/ 디렉터리의 JSON을 GameData 하나로 조립하는 로더.
 * 파일이 늘어나면 여기에만 추가한다.
 */
import type { GameData } from './types'

import config from '../../data/config.json'
import derived from '../../data/derived.json'
import kin from '../../data/kin.json'
import skills from '../../data/skills.json'
import abilities from '../../data/abilities.json'
import professions from '../../data/professions.json'
import weapons from '../../data/weapons.json'
import armor from '../../data/armor.json'
import items from '../../data/items.json'
import spells from '../../data/spells.json'
import monsters from '../../data/monsters.json'
import npcs from '../../data/npcs.json'
import animals from '../../data/animals.json'
import fearTable from '../../data/tables/fear.json'
import meleeMishapTable from '../../data/tables/melee-mishap.json'
import rangedMishapTable from '../../data/tables/ranged-mishap.json'
import severeInjuriesTable from '../../data/tables/severe-injuries.json'
import magicalMishapTable from '../../data/tables/magical-mishap.json'
import journeyMishapTable from '../../data/tables/journey-mishap.json'
import huntingTable from '../../data/tables/hunting.json'

/**
 * 이름 공란 채우기 — 내러티브(이름·묘사)는 데이터에서 비워 두는 것이 규칙이므로
 * (성권이 나중에 채운다), 화면·로그에서는 id 를 임시 이름으로 쓴다.
 * 몬스터 공격표처럼 id 가 없는 행은 눈(roll) 번호로 대신한다.
 */
function fillNames(node: unknown): void {
  if (Array.isArray(node)) {
    for (const v of node) fillNames(v)
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    if (o.name === '') {
      if (typeof o.id === 'string') o.name = o.id
      else if (typeof o.roll === 'number') o.name = `공격 ${o.roll}`
    }
    for (const v of Object.values(o)) fillNames(v)
  }
}

export function loadGameData(): GameData {
  // JSON 리터럴 추론이 union 타입(예: NPC skills 키 합집합)으로 좁혀지는 것을 풀기 위한 캐스팅.
  // 실제 형태 보증은 validate.ts 가 담당한다.
  const data = {
    config,
    baseChanceTable: derived.baseChanceTable,
    damageBonusTable: derived.damageBonusTable,
    ageTable: derived.ageTable,
    movementModTable: derived.movementModTable,
    conditions: derived.conditions,
    kin,
    skills,
    abilities,
    professions,
    weapons,
    armor,
    items,
    spells,
    monsters,
    npcs,
    animals,
    tables: [
      fearTable, meleeMishapTable, rangedMishapTable, severeInjuriesTable,
      magicalMishapTable, journeyMishapTable, huntingTable,
    ],
  } as unknown as GameData
  fillNames(data)
  return data
}
