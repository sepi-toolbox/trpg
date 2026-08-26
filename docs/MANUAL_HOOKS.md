# manual 효과 분류 — 훅 승격 작업 목록

> `hook: "manual"` 222건 전수 분류 (기준 커밋 시점). 1·2군 완료 후 잔여 198건. 승격 = 엔진이 자동 처리하도록
> 훅/연결을 만드는 것. **위에서부터 싸고 효과가 크다** — 1·2군은 새 훅 없이 끝난다.
> 파티 전제 효과는 1인 플레이에서 가치가 없으므로 후순위로 몰았다.

## 1군 — 즉시 연결형 ✅ 완료 (blanket 만 보류 — 수면 추위 시스템 없음)

이미 엔진에 파라미터/extra 가 있는데 호출부가 인벤토리를 안 보고 있는 것들.

| 대상 | 연결 지점 | 비고 |
|---|---|---|
| items/map | `pathfind(hasMap)` | 옵션 이미 존재 — 소지 검사만 |
| items/tent-small·tent-large | `makeCamp` 옵션 | hasSleepingFur 와 같은 방식 |
| items/boots | 여정 사고 `extra.bootsReduce` | 엔진에 감산 코드 있음 — 소지 가정만 풀면 됨 |
| items/cloak | 여정 사고 `extra.conditionWithoutCloak` + 폭우 | extra 이미 구조화 |
| items/fur-coat, blanket | 추위 판정 보온/베인 | hazards 추위 판정 호출부 |
| items/fishing-rod, fishing-net | `fish()` 수확 주사위 (D4/D6) | journey.ts |
| items/snare, bear-trap | `hunt(kind: trap)` 자격 검사 | 덫 없으면 덫 사냥 불가 |
| items/quiver-wooden·iron | `requiresQuiver` 무기 사격 자격 | 무기 feature 이미 존재 |
| table:journey-mishap 11 (사나운 짐승) | `animals.json` 에서 스폰 → 전투 | 동물 데이터 신설로 가능해짐 |
| items/backpack | ~~encumbrance~~ | ✅ 이미 구현됨 — manual 표기만 정리 |

## 2군 — 데이터 치환형 ✅ 완료 (force-fist 는 버프 지속 시스템 필요 → 4군으로 이동)

| 대상 | 치환 | 비고 |
|---|---|---|
| spells/gale | `knockback {dice: 2D4, damagePerMeter}` + perPL | 무리 2D6 특례만 desc 유지 |
| spells/surge | `knockback {dice: 2D6, damagePerMeter}` | 수원 조건은 desc |
| spells/cyclone | `knockback {dice: 2D4, damagePerMeter, prone}` | 베인 특례는 desc |
| spells/psychic-blow | `knockback {dice: 2D6, damagePerMeter}` | 회피·패리 가능은 기본 경로 |
| abilities/battle-cry | `healCondition {count: 1}` | 1인 플레이 기준 자신 = 아군 전원 |
| ~~spells/force-fist~~ | → 4군 | 지속 버프 추적이 먼저 필요 |

## 3군 — 소형 신규 훅 (엔진 한 지점 수정으로 끝) · 18건

| 제안 훅 | 대상 | 수정 지점 |
|---|---|---|
| `immuneFear` | abilities/fearless | `fearAttack()` 진입부 |
| `parryRangedWithMelee` | abilities/deflect-arrow | `tryParry` 방패 검사 |
| `reduceFallDamage {perWpDice}` | abilities/catlike | `fallDamage()` |
| `ignoreLongRangeBane` | abilities/eagle-eye | `rangedDistanceState` 호출부 |
| `autoSuccess {activity}` | abilities/master-chef(조리)·quartermaster(야영)·lone-wolf(야영 불요), spells/instant-meal | journey.ts 각 활동 진입부 |
| `armorSet {rating, stacking: max}` | spells/granite-skin | `armorRating` |
| `movementMultiplier {x2}` | spells/long-stride | `movementOf` 호출부 |
| `selfHit {damageBonus?}` | melee-mishap 6, ranged-mishap 5·6 | 사고 적용부 — 무기 피해를 자신/아군에 |
| `dropWeapon {distanceDice?}` | melee-mishap 1·4, ranged-mishap 1 | PC 무기 드랍 + 줍기 액션 (적측은 구현됨) |
| `outOfAmmo` | ranged-mishap 2 | 1군 화살통 연결과 세트 |
| `lifeDrain` | monster/blood-flit#3~6 | 피해량만큼 몬스터 HP 회복 |
| `throwAnyMelee` | abilities/throwing-arm | effectiveRange 의 thrown 판정 확장 |
| 중상 적용기 (`extra.skillPenalty` 등 해석) | severe-injuries 5·13·14·16·17 | **extra 는 이미 구조화됨** — 스킬 레벨/이동력에 반영하는 함수만 |

## 4군 — 중형 신규 훅 (지속 상태 시스템 필요 — 한 번 만들면 여럿이 탄다) · 약 30건

**(a) 결박/경직 계열** — `bind {escape: {skill|attr, modifier}, damagePerRound?}` 하나로:
spells/root-snare·thorn-field·slumber·rime(결박부), monster/web-stalker#5·moss-hulk#3(물림)·
barrow-lord#5, fear 7(경직)·8(공황 질주), melee-mishap 3(무기 박힘 — 무기판 bind), items/marbles

**(b) 조건부 판정 보정** — `conditionalBoon/Bane {when}` 하나로:
abilities/unforgiving(나를 때린 상대)·hunters-mark(지정 대상), items/fine-garments·rags·
simple-clothes·perfume·abacus·book·herbal-concoction·lockpicks-simple·saddle·rope(등반)
— when 어휘: `vsTarget`, `hasItem/withoutItem`, `skillGroup`, `situation(수동 확인)`

**(c) 다중 타격** — `multiStrike {countDice?, count, bane?}`:
abilities/twin-shot·double-slash, monster/sky-talon#2

**(d) 아침 굴림 저주** — `curse {morningDie, effectDesc}`:
magical-mishap 11·12·13·14·17 (+ monster/abyss-fiend#3 의 D6 저주표)

**(e) 전투 특수** — 개별 훅:
`freeAttackAgainst`(melee-mishap 2 빈틈), `weaponImpaired`(무기 손상 경상태 — PLAN 8단계
잠정 해소), `damageReduction`(spells/stone-ward, 리액션 주문 경로 필요), `critRange`
(spells/imbue-weapon), `berserk`(abilities/berserker), `aura`(abilities/musician + 악기
아이템 6종의 파라미터 보정), `castTwoSpells`(abilities/master-spellcaster),
`noHealUntilWarm`(monster/marsh-lurker#6), 나이 재계산(magical-mishap 18·19)

## manual 유지 (승격 부적합) · 약 100건

- **사람 판단·정보형**: adaptive("정당화되면"), intuition, insight, monster-hunter,
  treasure-hunter, disguise, sense-magic, past-echo, mind-speech, far-sight,
  seeking-sense, beast-tongue, new-hair, smoke-puff 등 — 판정 근거 자체가 재량
- **파티 전제** (1인 플레이 무의미 — 파티 확장 시 재검토): guardian, weasel,
  backstabbing(아군 2m), battle-cry 의 광역부, musician 의 아군 광역부, 도움 액션류
- **소환·동료** (별도 우군 시스템 필요): summon-earth/fire/wind/water, companion
- **지배·복잡 대결**: puppeteer, abyss-fiend#6, slumber 의 NPC WP 특례
- **캐릭터 영구 변경·의식**: return-from-death, perpetuate, spell-bind, charge-vessel,
  siphon-will, magic-talent(습득 시스템에서 이미 검사됨 — 표기용)
- **제작**: master-blacksmith/carpenter/tanner (제작 시스템 없음 — 물체 파괴 부분만
  3군 `objectDamage` 로 뺄 수 있음), needle-thread, 도구 필요 표기류
- **생활·유틸 트릭**: open-close, tidy-room, flower-step, mend-clothes, ignite,
  heat-chill, lock-unlock, mind-stool, feather-fall(낙하 자체가 드묾), unseen-hand,
  mind-lift, soar, blink-step, stone-pillar/rampart(지형), warding/counter-shield/unbind
  (적 시전자 등장 전까지 무대상)
- **수납·탈것·가축**: barrel~wagon, buy-* (도축 식량만 필요해지면 소형 훅)
- **연출·전파형 공포**: fear 4(새하얀 얼굴)·5(비명)·6(격분의 강제 공격부) — 1인 무대상
- **기타 무대상**: whistle, lamp-oil(광원 시스템이 이미 별도 처리), paper/parchment/
  quill(기록용), focus 매개체 표기(brooch·chalk·hourglass·reliquary — 시전 요구 조건
  검사에서 이미 소지 검사됨), magical-mishap 10·15·16·20(GM 재량 성격)

## 권장 순서

1. **1군 + 2군** (한나절감, 코드 거의 없음) → manual 약 20건 감소, 여정 루프 체감 큼
2. **3군** 중 전투 사고표 3종(`selfHit`/`dropWeapon`/`outOfAmmo`)과 `immuneFear`,
   중상 적용기 — 전투·중상 옵션 룰이 온전해진다
3. **4군 (a) bind 계열** — 훅 하나로 10건 이상 처리, 몬스터 전투 다양성 급상승
4. 4군 (b) conditionalBoon — 아이템 태반이 살아난다
