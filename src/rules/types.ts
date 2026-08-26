/** 능력치 6종. 데이터 테이블의 컬럼 키와 1:1로 대응한다. */
export const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const
export type AbilityKey = (typeof ABILITY_KEYS)[number]

export const ABILITY_LABELS: Record<AbilityKey, string> = {
  str: '근력',
  dex: '민첩',
  con: '체력',
  int: '지능',
  wis: '의지',
  cha: '매력',
}

export type Abilities = Record<AbilityKey, number>

/** 유리함/불리함. 2d20 중 높은/낮은 눈을 채택. */
export type RollMode = 'normal' | 'advantage' | 'disadvantage'

export interface Weapon {
  id: string
  name: string
  /** 데미지 주사위 표기 */
  damage: string
  /** 명중/데미지에 쓰는 능력치 */
  ability: AbilityKey
  /** 크리티컬 확정 최소 눈 (기본 20) */
  critRange: number
  tags: string[]
}

export interface ArmorPiece {
  id: string
  name: string
  /** 기본 방어도 */
  baseDefense: number
  /** 민첩 보정 반영 상한 (null이면 무제한) */
  dexCap: number | null
}

export interface ClassDef {
  id: string
  name: string
  description: string
  /** 레벨당 생명력 주사위 */
  hitDie: string
  /** 생성 시 능력치 보정 */
  abilityBonus: Partial<Abilities>
  /**
   * 표준 배열/굴린 능력치를 배분하는 우선순위.
   * 높은 값부터 이 순서대로 꽂는다 — 클래스마다 "좋은 빌드"가 다르기 때문에
   * 고정 배열 하나로는 전사 편향이 생긴다.
   */
  abilityPriority: AbilityKey[]
  startingWeapon: string
  startingArmor: string
  /** 숙련 보너스가 붙는 능력치 */
  proficiencies: AbilityKey[]
  /** 클래스 고유 기술 id */
  skills: string[]
}

export interface SkillDef {
  id: string
  name: string
  description: string
  /** 전투당 사용 횟수 */
  uses: number
  kind: 'attack' | 'heal' | 'buff'
  /** kind별 의미: attack=데미지 표기, heal=회복 표기, buff=지속 라운드 수 */
  power: string
  ability: AbilityKey
  /** attack 전용 — 명중 판정 방식 (기본 normal) */
  mode?: RollMode
  /** attack 전용 — 크리티컬 최소 눈 (기본 20) */
  critRange?: number
  /** buff 전용 — 방어도 증가량 */
  defenseBonus?: number
}

export interface MonsterDef {
  id: string
  name: string
  level: number
  hp: string
  defense: number
  attackBonus: number
  damage: string
  initiativeBonus: number
  /** 처치 시 경험치 */
  xp: number
  traits: string[]
}

export interface Character {
  name: string
  classId: string
  level: number
  abilities: Abilities
  maxHp: number
  hp: number
  weaponId: string
  armorId: string
  proficiencies: AbilityKey[]
  skills: string[]
  skillUses: Record<string, number>
  xp: number
  /** 활성화된 버프의 남은 턴 수 */
  buffTurns: number
}

export interface Combatant {
  id: string
  name: string
  hp: number
  maxHp: number
  /** 기본 방어도 (버프 제외) */
  defense: number
  /** 버프로 붙은 방어도. buffTurns가 0이 되면 함께 사라진다. */
  defenseBonus: number
  buffTurns: number
  attackBonus: number
  damage: string
  critRange: number
  initiative: number
  side: 'party' | 'foe'
}
