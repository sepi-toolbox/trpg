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
import fearTable from '../../data/tables/fear.json'
import meleeMishapTable from '../../data/tables/melee-mishap.json'
import rangedMishapTable from '../../data/tables/ranged-mishap.json'
import severeInjuriesTable from '../../data/tables/severe-injuries.json'
import magicalMishapTable from '../../data/tables/magical-mishap.json'
import journeyMishapTable from '../../data/tables/journey-mishap.json'
import huntingTable from '../../data/tables/hunting.json'

export function loadGameData(): GameData {
  // JSON 리터럴 추론이 union 타입(예: NPC skills 키 합집합)으로 좁혀지는 것을 풀기 위한 캐스팅.
  // 실제 형태 보증은 validate.ts 가 담당한다.
  return {
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
    tables: [
      fearTable, meleeMishapTable, rangedMishapTable, severeInjuriesTable,
      magicalMishapTable, journeyMishapTable, huntingTable,
    ],
  } as unknown as GameData
}
