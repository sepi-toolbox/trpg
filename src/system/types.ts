/**
 * DB 시스템 — 데이터 테이블 스키마.
 *
 * 이 파일이 데이터 테이블(data/*.json)의 계약이다.
 * 규칙 수치는 이 타입에 맞는 JSON으로만 존재하고, 코드는 JSON을 해석만 한다.
 * → 밸런스 조정과 콘텐츠 작성은 JSON 편집만으로 끝난다.
 *
 * 필드 채우기 분담 (docs/SCHEMA.md 참고):
 *   - 기계 필드(수치·주사위·태그): 규칙 원문 그대로. 함부로 바꾸면 규칙이 바뀐다.
 *   - name / description / flavor: 자유 텍스트. 성권이 자유롭게 수정.
 */

/* ─────────────────────────── 공통 ─────────────────────────── */

/** 능력치 6종. 코드 전반에서 이 키로 참조한다. */
export const ATTRIBUTES = ['str', 'con', 'agl', 'int', 'wil', 'cha'] as const
export type AttributeId = (typeof ATTRIBUTES)[number]

/**
 * 주사위 표기. "D6" | "2D8" | "D8+1" | "3" 형식.
 * 갯수 생략 시 1개. 대소문자 무관.
 */
export type DiceNotation = string

/** 화폐. 1골드 = 10실버 = 100코퍼 */
export interface Cost {
  amount: number
  unit: 'gold' | 'silver' | 'copper'
}

export type Supply = 'common' | 'uncommon' | 'rare' | 'unique'

/** 피해 유형 (옵션 룰 damageTypes 켜졌을 때 의미를 가짐) */
export type DamageType = 'slashing' | 'piercing' | 'bludgeoning'

/**
 * 상태이상 6종 — 능력치와 1:1 대응 (해당 능력치 기반 판정에 베인).
 * 표시 이름은 data/tables/conditions.json 에서 편집.
 */
export type ConditionId =
  | 'exhausted' // STR
  | 'sickly' //    CON
  | 'dazed' //     AGL
  | 'angry' //     INT
  | 'scared' //    WIL
  | 'disheartened' // CHA

/** 시간 단위: 라운드(10초) / 스트레치(15분) / 시프트(6시간) */
export type TimeUnit = 'round' | 'stretch' | 'shift'

/* ─────────────────────── 효과 훅 (Effect DSL) ─────────────────────── */

/**
 * 능력·주문·몬스터 공격의 효과를 데이터로 기술하기 위한 공용 어휘.
 *
 * 원칙:
 *  - 자주 나오는 효과 형태는 훅으로 구조화한다 → 엔진이 자동 실행.
 *  - 훅으로 못 담는 복잡한 효과는 { hook: "manual" } + description
 *    → 엔진은 텍스트를 표시하고 결과 입력을 받는다 (초벌에서는 이것으로 충분).
 *  - 6단계(능력 엔진)에서 manual을 하나씩 전용 훅으로 승격한다.
 *
 * params 는 훅별 자유 형식. validate.ts 가 알려진 훅의 필수 파라미터를 검사한다.
 */
export interface Effect {
  hook: EffectHook
  params?: Record<string, unknown>
}

export type EffectHook =
  // 판정 수정
  | 'boon' //        params: { roll: RollSelector }
  | 'bane' //        params: { roll: RollSelector }
  | 'autoSuccess' // params: { roll: RollSelector }
  // 자원·피해
  | 'damage' //      params: { dice, type?: DamageType, ignoreArmor?, target? }
  | 'heal' //        params: { dice }
  | 'healWp' //      params: { dice }
  | 'drainWp' //     params: { dice }
  | 'extraDamageDie' // params: { dice } — 명중 후 피해에 주사위 추가
  // 상태
  | 'condition' //   params: { condition: ConditionId | 'choice' }
  | 'healCondition' // params: { count: number | 'all' }
  | 'fearAttack' //  params: { radius?: number, bane?: boolean }
  | 'knockback' //   params: { dice, damagePerMeter?: boolean, prone?: boolean }
  | 'prone'
  | 'poison' //      params: { kind: 'lethal'|'paralyzing'|'sleeping', potency: number }
  // 전투 흐름
  | 'extraAttack' //  params: { bane?: boolean }
  | 'extraParry' //   자기 턴 소모 없이 패리
  | 'extraDodge'
  | 'initiativeSwap' // params: { mode: 'drawTwo' | 'keepPrevious' | 'chooseAny' }
  // 기타
  | 'maxHpBonus' //  params: { amount }
  | 'maxWpBonus' //  params: { amount }
  | 'movementBonus' // params: { amount }
  | 'armorBonus' //  params: { amount }
  | 'light' //       params: { radius, duration: TimeUnit }
  | 'manual' //      구조화 불가 — description 표시 후 수동 처리

/** boon/bane 훅이 어느 판정에 걸리는지 지정 */
export interface RollSelector {
  /** 특정 스킬 id 목록, 또는 능력치 기반 전체('attr:agl'), 'all' */
  skills?: string[]
  attribute?: AttributeId
  all?: boolean
}

/* ─────────────────────────── 파생 규칙 표 ─────────────────────────── */

/** 능력치 → 기본치(base chance) 구간표 */
export interface BaseChanceRow {
  min: number
  max: number
  baseChance: number
}

/** STR/AGL → 피해 보너스 구간표 */
export interface DamageBonusRow {
  min: number
  max: number
  /** null = 보너스 없음 */
  bonus: DiceNotation | null
}

/** 나이 구간 효과 */
export interface AgeRow {
  id: 'young' | 'adult' | 'old'
  name: string
  /** 생성 시 굴림 D6 범위 */
  roll: { min: number; max: number }
  /** 자유 선택 훈련 스킬 수 (직업 6종은 별도 고정) */
  extraTrainedSkills: number
  /** 능력치 보정 (상한 18) */
  attributeMods: Partial<Record<AttributeId, number>>
}

/** AGL → 이동력 보정 구간표 */
export interface MovementModRow {
  min: number
  max: number
  mod: number
}

/* ─────────────────────────── 종족 ─────────────────────────── */

export interface Kin {
  id: string
  name: string
  description: string
  /** 기본 이동력 (AGL 보정 전) */
  movement: number
  /** 생성 굴림 D12 범위 */
  roll: { min: number; max: number }
  /** 고유 능력 id (abilities.json 참조). 복수 가능 */
  abilityIds: string[]
}

/* ─────────────────────────── 스킬 ─────────────────────────── */

export interface Skill {
  id: string
  name: string
  attribute: AttributeId
  /**
   * core: 핵심 스킬 30종 (기본치 자동 부여)
   * weapon: core 중 무기 스킬 (표시 그룹용)
   * magic: 마법 유파 — 보조 스킬, 훈련 없으면 기본치 0
   */
  kind: 'core' | 'weapon' | 'magic'
  description: string
}

/* ─────────────────────────── 능력 (종족 고유 + 영웅) ─────────────────────────── */

export interface Ability {
  id: string
  name: string
  description: string
  kind: 'innate' | 'heroic'
  /**
   * 습득 요건 (시작 능력에는 미적용 — 규칙 원문).
   * skillIds 중 하나가 level 이상이면 충족. null = 요건 없음.
   * skillIds 에 'anyWeapon' | 'anyMeleeWeapon' | 'anyStrMeleeWeapon' | 'anyMagic' 허용.
   */
  requirement: { skillIds: string[]; level: number } | null
  /** WP 소모. 0 = 소모 없음(패시브), 'varies' = 가변 */
  wpCost: number | 'varies'
  /** 발동이 액션인가 (전투 기준). free = 액션 아님, reaction = 리액션 */
  activation: 'action' | 'free' | 'reaction' | 'passive'
  /** Robust/Focused 처럼 중복 습득 가능 여부 */
  stackable: boolean
  effects: Effect[]
}

/* ─────────────────────────── 직업 ─────────────────────────── */

export interface GearSetItem {
  /** weapons/armor/items 테이블의 id */
  itemId: string
  /** 수량. 주사위면 생성 시 굴림 (예: 식량 "D8") */
  qty?: number | DiceNotation
}

export interface GearSet {
  /** 생성 굴림 D6 범위 */
  roll: { min: number; max: number }
  items: GearSetItem[]
  /** 시작 은화 */
  silver: DiceNotation
}

export interface Profession {
  id: string
  name: string
  description: string
  keyAttribute: AttributeId
  /**
   * 직업 스킬 8종. 훈련 스킬 6종은 여기서 골라야 한다.
   * 마법사처럼 하위 선택지가 갈리면 variants 사용 (기본은 skillIds 하나).
   */
  skillIds?: string[]
  variants?: { id: string; name: string; skillIds: string[] }[]
  /**
   * 시작 영웅 능력 후보 (하나 선택). 빈 배열 = 영웅 능력 없음(마법사 — 대신 마법).
   */
  heroicAbilityIds: string[]
  /** 마법사 전용: 시작 시 유파 스킬 + 주문 선택 */
  startingMagic?: { spells: number; tricks: number } | null
  gearSets: GearSet[]
  /** 별명 후보 6개 (D6) — 콘텐츠 필드 */
  nicknames: string[]
}

/* ─────────────────────────── 장비 ─────────────────────────── */

export type WeaponFeature =
  | 'subtle' //     은닉 무기 — 암습 피해 증가 대상
  | 'toppling' //   넘어뜨리기 특수 공격에 보온
  | 'long' //       사거리 4m, 아군 너머 공격 가능
  | 'thrown' //     투척 가능 (사거리 STR)
  | 'noParry' //    패리 불가 (플레일)
  | 'noDamageBonus' // 피해 보너스 없음 (석궁)
  | 'requiresQuiver'
  | 'tiny' //       소지 한도 무관
  | 'requiresMount' // 랜스
  | 'unarmed'

export interface Weapon {
  id: string
  name: string
  /** 사용 스킬 (skills.json id) */
  skillId: string
  grip: '1H' | '2H'
  /** 요구 STR. null = 없음. 미달 시 베인, 절반 미만이면 사용 불가 */
  strRequirement: number | null
  /**
   * 사거리. 숫자 = 미터.
   * 'STR' = 사용자 STR 미터 (투척), 'STRx2' = STR×2 미터.
   */
  range: number | 'STR' | 'STRx2'
  damage: DiceNotation
  /** 패리 시 이 값을 넘는 피해면 무기 파손. null = 파손 없음/패리 불가 */
  durability: number | null
  cost: Cost | null
  supply: Supply | null
  damageTypes: DamageType[]
  features: WeaponFeature[]
  /** melee | ranged — 원거리 무기는 명중에 해당 스킬, 피해 보너스는 AGL */
  category: 'melee' | 'ranged' | 'shield'
  /** 금속제 여부 — 손에 지니면 마법 시전 불가 (부분 금속 포함) */
  metal: boolean
}

export interface Armor {
  id: string
  name: string
  kind: 'armor' | 'helmet'
  /** 방어 등급. 투구는 갑옷에 합산 */
  rating: number
  cost: Cost
  supply: Supply
  /** 착용 페널티: 해당 스킬 판정에 베인 */
  baneSkillIds: string[]
  /** 원거리 공격 전체에 베인 (그레이트 헬름) */
  baneRangedAttacks: boolean
  /** 옵션 룰 damageTypes 켜졌을 때 유형별 등급 보정 */
  typeModifiers: Partial<Record<DamageType, number>>
  /** 금속제 여부 — 착용하면 마법 시전 불가 */
  metal: boolean
}

export interface Item {
  id: string
  name: string
  category:
    | 'clothes'
    | 'instrument'
    | 'tradeGoods'
    | 'study'
    | 'lightSource'
    | 'tool'
    | 'container'
    | 'medicine'
    | 'hunting'
    | 'vehicle'
    | 'animal'
    | 'service'
  cost: Cost
  supply: Supply
  /** 소지 무게. 0 = tiny(한도 무관), 0.25 = 식량 4개당 1 */
  weight: number
  description: string
  /** 구조화 가능한 효과 (예: 광원 radius, 도구 피해). 없으면 [] */
  effects: Effect[]
  /**
   * 광원 전용: 스트레치마다 굴리는 꺼짐 판정 주사위 면수 (1이면 꺼짐).
   * 광원 아니면 null.
   */
  extinguishDie: number | null
  /** 금속제 여부 — 손에 드는 물건일 때 마법 제한에 관여 (철촉 화살통 등) */
  metal: boolean
}

/* ─────────────────────────── 마법 ─────────────────────────── */

export type SpellRequirement = 'word' | 'gesture' | 'focus' | 'ingredient'

export interface SpellRange {
  kind: 'meters' | 'touch' | 'personal'
  meters?: number
  /** 범위형: cone(길이=meters) | sphere(반경=meters) */
  shape?: 'cone' | 'sphere'
}

export interface Spell {
  id: string
  name: string
  /** 'general' 또는 유파 스킬 id */
  school: string
  kind: 'trick' | 'spell'
  /** 트릭은 rank 0 취급. 랭크는 기계적 효과 없음(습득 순서 지표) — 원문 명시 */
  rank: number
  /**
   * 습득 전제. null = 없음.
   * { spellId } 또는 { school: 'any' | 유파 id }
   */
  prerequisite: { spellId?: string; school?: string } | null
  requirements: SpellRequirement[]
  /** focus/ingredient 의 구체물 — 콘텐츠 필드 */
  requirementNote: string | null
  castingTime: 'action' | 'reaction' | 'stretch' | 'shift'
  range: SpellRange
  duration: 'instant' | 'round' | 'stretch' | 'shift' | 'concentration' | 'permanent'
  /** 위력 1~3 사용 여부. false = 항상 2 WP (트릭은 항상 1 WP) */
  usesPowerLevel: boolean
  /** 위력 1 기준 효과. 위력당 증가는 perPowerLevel 에 */
  effects: Effect[]
  /** 위력 1 초과분당 추가 효과 (예: 피해 +D8) */
  perPowerLevel: Effect[] | null
  description: string
}

/* ─────────────────────────── 몬스터 ─────────────────────────── */

export type MonsterSize = 'small' | 'normal' | 'large' | 'huge' | 'swarm'

export interface MonsterAttack {
  /** D6 눈 (1~6) */
  roll: number
  name: string
  description: string
  /** 자동 명중이 기본. 예외 플래그 */
  canParry: boolean
  canDodge: boolean
  effects: Effect[]
}

export interface Monster {
  id: string
  name: string
  description: string
  /** 라운드당 행동 수 = 선제 카드 수 */
  ferocity: number
  size: MonsterSize
  movement: { land: number; fly?: number; swim?: number }
  /** 자연 방어구. null = 없음 */
  armor: number | null
  hp: number
  /** 피해 절반 (방어구 적용 후, 올림) */
  resistances: DamageType[]
  /** 완전 무효. 'nonMagical' = 마법·화염 외 전부 면역 같은 특례는 note로 */
  immunities: DamageType[]
  /** PERSUASION 허용 여부 (기본 불가) */
  persuadable: boolean
  /** 회피/패리 기본 스킬 15 — 예외 있으면 여기 */
  defenseSkill: number
  /** 기재된 스킬만. 미기재는 기본치 5 */
  skills: Record<string, number>
  attacks: MonsterAttack[]
  /** 구조화 안 되는 특성 (임시 텍스트) */
  traits: string[]
}

/* ─────────────────────────── NPC ─────────────────────────── */

export interface NpcTemplate {
  id: string
  name: string
  kind: 'minion' | 'boss'
  skills: Record<string, number>
  /** [{ abilityId, count }] — Robust ×6 등 */
  heroicAbilities: { abilityId: string; count: number }[]
  damageBonus: Partial<Record<'str' | 'agl', DiceNotation>>
  hp: number
  /** 미니언은 null (WP 미사용) */
  wp: number | null
  gearIds: string[]
}

/* ─────────────────────────── 굴림표 (콘텐츠 표) ─────────────────────────── */

/** 범용 굴림표 행 — 중상표, 공포표, 마법 사고표, 사고표, 약점표 등 */
export interface RollTableRow {
  min: number
  max: number
  name: string
  description: string
  effects: Effect[]
  /** 치유 기간 등 부가 수치 (표별 자유 형식) */
  extra?: Record<string, unknown>
}

export interface RollTable {
  id: string
  name: string
  die: number // 6, 8, 12, 20 …
  rows: RollTableRow[]
}

/* ─────────────────────────── 설정 (옵션 룰 토글) ─────────────────────────── */

export interface RulesConfig {
  /** 실패 시 상태이상 대가로 재굴림 */
  pushRolls: boolean
  /** 참격/관통/타격 유형별 방어구 보정·저항 */
  damageTypes: boolean
  /** 0 HP 생존 후 중상표 */
  severeInjuries: boolean
  /** 약점(weakness) — 성장 마크 추가 획득 */
  weaknesses: boolean
  /** 기념품(memento) */
  mementos: boolean
  /** 밀치기(shove) */
  shove: boolean
  /** 특수 공격 (넘어뜨리기/무장해제/붙잡기/약점 찌르기) */
  specialAttacks: boolean
  /** 근접/원거리 대실패 사고표 */
  mishapTables: boolean
  /** 마법 대실패 사고표 */
  magicalMishaps: boolean
  /** 소지 한도 */
  encumbrance: boolean
  /** 즉석 무기 */
  improvisedWeapons: boolean
}

/* ─────────────────────────── 데이터 묶음 ─────────────────────────── */

/** data/ 디렉터리 전체를 로드한 형태. 로더가 이 모양으로 조립한다. */
export interface GameData {
  config: RulesConfig
  baseChanceTable: BaseChanceRow[]
  damageBonusTable: DamageBonusRow[]
  ageTable: AgeRow[]
  movementModTable: MovementModRow[]
  conditions: { id: ConditionId; attribute: AttributeId; name: string }[]
  kin: Kin[]
  skills: Skill[]
  abilities: Ability[]
  professions: Profession[]
  weapons: Weapon[]
  armor: Armor[]
  items: Item[]
  spells: Spell[]
  monsters: Monster[]
  npcs: NpcTemplate[]
  tables: RollTable[]
}
