# 데이터 테이블 스키마 가이드

`data/` 디렉터리의 JSON이 게임 규칙 데이터의 전부다. 코드는 이 데이터를 해석만 한다.
타입 정의 원본은 `src/system/types.ts`, 무결성 검사는 `src/system/validate.ts`.

**편집 후에는 반드시 `npm test`.** 참조 깨짐·주사위 오표기·표 구멍을 전부 잡아준다.

## 필드 분담

| 표기 | 의미 |
|---|---|
| 🔧 | 기계 필드 — 규칙 수치. 바꾸면 규칙이 바뀐다. 밸런스 조정은 여기서 |
| ✏️ | 콘텐츠 필드 — 이름·묘사. 자유롭게 수정 (`(임시)` 표시는 채워야 할 자리) |

id 는 코드가 참조하므로 **바꾸지 않는다** (바꿔야 하면 참조를 전부 같이 바꾸고 npm test).

**이름 공란 규칙**: 나중에 추가된 데이터는 `name: ""` 로 비워져 있다 (내러티브는 성권 담당).
빈 이름은 화면·로그에 자동으로 id 가 대신 표시된다 (몬스터 공격표 행은 "공격 N") —
채우는 즉시 그 이름이 뜬다. 빈 이름 항목의 `description` 이 채워져 있으면 그것은
**규칙 요약**이다 (manual 효과 등 엔진이 자동 실행 못 하는 부분) — 지우지 말고 표현만 다듬을 것.

## 공통 표기

- **주사위**: `"D6"`, `"2D8"`, `"2D6+1"`, `"5"`(고정값). 대소문자 무관.
- **화폐**: `{ "amount": 12, "unit": "gold" }` — gold/silver/copper (1:10:100).
- **능력치 id**: `str` `con` `agl` `int` `wil` `cha`
- **상태이상 id**: `exhausted`(STR) `sickly`(CON) `dazed`(AGL) `angry`(INT) `scared`(WIL) `disheartened`(CHA)
- **구간표**: `{ "min": 13, "max": 16, ... }` — 1~18(또는 주사위 눈) 전 구간을 빈틈·겹침 없이 덮어야 한다.

## 파일별 요약

### config.json — 옵션 룰 토글 🔧
`pushRolls`(푸쉬 굴림) `damageTypes`(피해 유형) `severeInjuries`(중상표) `weaknesses`(약점)
`mementos`(기념품) `shove`(밀치기) `specialAttacks`(특수 공격) `mishapTables`(전투 사고표)
`magicalMishaps`(마법 사고표) `encumbrance`(소지 한도) `improvisedWeapons`(즉석 무기)

### derived.json — 파생 규칙 표 🔧
- `baseChanceTable`: 능력치 → 기본치 (3~7)
- `damageBonusTable`: STR/AGL → 피해 보너스 (null | "D4" | "D6")
- `ageTable`: 나이 → 추가 훈련 스킬 수 + 능력치 보정. `name` ✏️
- `movementModTable`: AGL → 이동력 보정
- `conditions`: 상태이상 ↔ 능력치 대응. `name` ✏️

### kin.json — 종족
`movement` 🔧 기본 이동력 / `roll` 🔧 생성 D12 구간 / `abilityIds` 🔧 고유 능력 참조
`name` `description` ✏️

### skills.json — 스킬 (핵심 30종 + 마법 유파)
`attribute` 🔧 / `kind` 🔧 core·weapon·magic / `name` `description` ✏️
핵심 스킬(core+weapon)은 정확히 30종이어야 한다 — 검증기가 강제.

### abilities.json — 종족 고유 능력 + 영웅 능력
- `kind` 🔧 innate | heroic
- `requirement` 🔧 습득 요건 `{ "skillIds": [...], "level": 12 }` | null.
  skillIds 에 와일드카드 허용: `anyWeapon` `anyMeleeWeapon` `anyStrMeleeWeapon` `anyMagic`
- `wpCost` 🔧 숫자 | `"varies"` (0 = 소모 없음)
- `activation` 🔧 action | free | reaction | passive
- `stackable` 🔧 중복 습득 가능 여부 (강골·집중 류)
- `trigger` 🔧 패시브 적용 시점: `"always"`(상시 — maxHpBonus 등) | `"stretchRest"`(휴식 시) | null(발동형)
- `effects` 🔧 아래 "효과 훅" 참조
- `name` `description` ✏️

### professions.json — 직업
- `keyAttribute` 🔧
- `skillIds` 🔧 직업 스킬 정확히 8종. 하위 선택지가 갈리면 `variants` 사용(술사의 유파처럼)
- `heroicAbilityIds` 🔧 시작 영웅 능력 후보 (빈 배열 = 없음, 대신 `startingMagic`)
- `startingMagic` 🔧 `{ "spells": 3, "tricks": 3 }` | null
- `gearSets` 🔧 D6 구간 3세트. 아이템 id 는 weapons/armor/items 어디든 가능.
  수량이 주사위면 생성 시 굴림 (식량 `"qty": "D6"`)
- `silver` 🔧 시작 은화 주사위
- `name` `description` `nicknames`(정확히 6개) ✏️

### weapons.json — 무기
- `skillId` 🔧 사용 스킬 / `grip` 🔧 1H·2H / `strRequirement` 🔧 (미달=베인, 절반 미만=사용 불가)
- `range` 🔧 숫자(m) | `"STR"` | `"STRx2"` (투척 = 사용자 STR 기반)
- `damage` `durability` 🔧 (durability null = 파손 없음. `noParry` 무기는 반드시 null)
- `damageTypes` 🔧 slashing/piercing/bludgeoning (복수면 공격 시 선택)
- `features` 🔧: `subtle`(암습 강화) `toppling`(넘어뜨리기 보온) `long`(4m·아군 너머)
  `thrown` `noParry` `noDamageBonus`(석궁) `requiresQuiver` `tiny` `requiresMount` `unarmed`
- `category` 🔧 melee | ranged | shield
- `metal` 🔧 금속제 여부 — 손에 지니면 마법 시전 불가 (부분 금속 포함, 지팡이·곤봉·투석구·활은 false)
- `name` ✏️

### armor.json — 갑옷·투구
`rating` 🔧 (투구는 갑옷에 합산) / `baneSkillIds` 🔧 착용 페널티 / `baneRangedAttacks` 🔧
`typeModifiers` 🔧 피해 유형별 등급 보정 (옵션 룰 damageTypes 켜졌을 때)
`metal` 🔧 금속제 여부 — 착용 시 마법 시전 불가 (가죽 갑옷만 false) / `name` ✏️

### items.json — 일반 장비
`weight` 🔧 (0 = tiny, 0.25 = 식량처럼 4개당 1) / `effects` 🔧 / `extinguishDie` 🔧 광원 전용
`metal` 🔧 손에 드는 금속 물건이면 true (철촉 화살통 등 — 마법 제한 관여)
`name` `description` ✏️

### spells.json — 주문·트릭
- `school` 🔧 `general` | 유파 스킬 id / `kind` 🔧 trick | spell / `rank` 🔧 (기계 효과 없음, 트릭=0)
- `prerequisite` 🔧 `{ "spellId": ... }` | `{ "school": "any" | 유파 }` | null
- `requirements` 🔧 word/gesture/focus/ingredient 조합 + `requirementNote` ✏️ 구체물
- `castingTime` 🔧 action | reaction | stretch | shift (리액션 주문은 액션 소모 없음)
- `range` 🔧 `{ "kind": "meters"|"touch"|"personal", "meters"?, "shape"?: "cone"|"sphere" }`
- `duration` 🔧 instant | round | stretch | shift | concentration | permanent
- `usesPowerLevel` 🔧 위력 1~3 사용 여부 (트릭은 false 강제)
- `effects` 🔧 위력 1 기준 / `perPowerLevel` 🔧 위력 1 초과분당 추가 효과
- `name` `description` ✏️

### monsters.json — 몬스터
- `ferocity` 🔧 라운드당 행동 수(선제 카드 수)
- `size` 🔧 small | normal | large | huge | swarm
- `movement` 🔧 `{ "land": 12, "fly"?: ..., "swim"?: ... }` — 턴당 이동력
- `armor` `hp` 🔧 / `resistances`(절반) `immunities`(무효) 🔧
- `persuadable` 🔧 (기본 false) / `defenseSkill` 🔧 회피·패리 고정치 (기본 15)
- `skills` 🔧 기재된 것만. 나머지는 기본치 5
- `attacks` 🔧 **정확히 6개, 눈 1~6** — 검증기 강제. 각 공격:
  `canParry` `canDodge` 🔧 (몬스터 공격은 자동 명중, 기본 회피만 가능) + `effects` 🔧
  같은 눈 연속 시 다음 항목으로 넘어가는 규칙은 엔진이 처리
- `name` `description` `traits`(구조화 안 된 특성 메모) ✏️ + 공격의 `name` `description` ✏️

### npcs.json — NPC 템플릿
`kind` 🔧 minion(0 HP 즉사, WP 없음 — wp 는 null. 예외: 주문 보유 미니언은 시전용 wp 허용) | boss
`skills` `hp` `wp` 🔧 / `heroicAbilities` 🔧 `[{ "abilityId": "robust", "count": 6 }]`
`damageBonus` 🔧 / `gearIds` 🔧 / `spellIds` 🔧 시전 가능 주문 / `resistances` 🔧 피해 유형 저항(절반)
`name` ✏️ + `traits` ✏️ (구조화 안 된 특성 — 규칙 요약 메모)

### animals.json — 동물 (사냥감·가축 등)
`movement` `hp` 🔧 / `attack` 🔧 `{ "skillLevel": 12, "damage": "D8" }` — 몬스터와 달리 일반 스킬 판정으로 공격
`skills` 🔧 기재된 것만 (나머지 기본치 5) / `name` ✏️

### tables/*.json — 굴림표
공포표·사고표·중상표 등. `die` 🔧 주사위 면수, `rows` 는 min~max 로 전 눈을 덮어야 한다.
각 행: `effects` 🔧 + `name` `description` ✏️

## 효과 훅 (effects)

효과는 `{ "hook": "...", "params": { ... } }` 배열. 엔진이 자동 실행할 수 있는 어휘:

| 훅 | params | 의미 |
|---|---|---|
| `boon` / `bane` / `autoSuccess` | `roll: { skills?, attribute?, all? }` | 판정 수정 |
| `damage` | `dice, type?, ignoreArmor?` | 피해 |
| `heal` / `healWp` / `drainWp` | `dice` | HP/WP 회복·상실 |
| `extraDamageDie` | `dice` | 명중 후 피해 주사위 추가 |
| `condition` | `condition: id \| "choice"` | 상태이상 부여 |
| `healCondition` | `count: 숫자 \| "all"` | 상태이상 해소 |
| `fearAttack` | `radius?, bane?` | 공포 공격 유발 |
| `knockback` | `dice, damagePerMeter?, prone?` | 밀쳐냄 |
| `prone` | — | 넘어뜨림 |
| `poison` | `kind, potency` | 독 (lethal/paralyzing/sleeping) |
| `extraAttack` / `extraParry` / `extraDodge` | `bane?` | 추가 행동 |
| `initiativeSwap` | `mode: drawTwo \| keepPrevious \| chooseAny` | 선제 조작 |
| `maxHpBonus` / `maxWpBonus` / `movementBonus` / `armorBonus` | `amount` | 상시 보정 |
| `light` | `radius, duration` | 광원 |
| `manual` | — | **구조화 불가** — description 을 표시하고 수동 처리 |

훅으로 못 담는 효과는 `manual` 로 두면 된다. 엔진은 description 을 보여주고 결과를 입력받는다.
6단계(능력 엔진)에서 manual 항목을 하나씩 전용 훅으로 승격한다 — 새 훅이 필요하면
`types.ts` 의 `EffectHook` 과 `validate.ts` 의 `KNOWN_HOOKS` 에 추가.

## 자주 하는 작업

**몬스터 추가**: monsters.json 에 한 마리 복사 → id/이름/수치 수정 → 공격 6개 채우기 → `npm test`
**무기 밸런스 조정**: weapons.json 의 damage/strRequirement/durability 수정 → `npm test`
**옵션 룰 끄기**: config.json 에서 false → 코드는 안 건드림
**이름 짓기**: `(임시)` 붙은 name/description 을 자유롭게 교체. id 는 그대로.
