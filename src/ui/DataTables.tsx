import { diceRange } from '../rules/dice'
import { ABILITY_LABELS } from '../rules/types'
import { MONSTERS, SKILLS, WEAPONS, DUNGEON, validateData } from '../data'

/**
 * 데이터 테이블 뷰어.
 * 밸런스를 볼 때 JSON을 열지 않고 기대값까지 같이 보려고 붙였다.
 */
export function DataTables() {
  const errors = validateData()

  return (
    <details className="panel data-dump">
      <summary>규칙 · 데이터 테이블 보기</summary>

      {errors.length > 0 && (
        <div className="event-card bad" style={{ marginTop: 12 }}>
          <strong>데이터 오류 {errors.length}건</strong>
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>몬스터</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>Lv</th>
            <th>HP</th>
            <th>방어</th>
            <th>명중</th>
            <th>데미지</th>
            <th>기대</th>
            <th>XP</th>
          </tr>
        </thead>
        <tbody>
          {MONSTERS.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td>{m.level}</td>
              <td>{m.hp}</td>
              <td>{m.defense}</td>
              <td>+{m.attackBonus}</td>
              <td>{m.damage}</td>
              <td>{diceRange(m.damage).avg.toFixed(1)}</td>
              <td>{m.xp}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>무기</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>데미지</th>
            <th>기대</th>
            <th>능력치</th>
            <th>크리</th>
          </tr>
        </thead>
        <tbody>
          {WEAPONS.map((w) => (
            <tr key={w.id}>
              <td>{w.name}</td>
              <td>{w.damage}</td>
              <td>{diceRange(w.damage).avg.toFixed(1)}</td>
              <td>{ABILITY_LABELS[w.ability]}</td>
              <td>{w.critRange}+</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>기술</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>종류</th>
            <th>위력</th>
            <th>횟수</th>
            <th>설명</th>
          </tr>
        </thead>
        <tbody>
          {SKILLS.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.kind === 'attack' ? '공격' : s.kind === 'heal' ? '회복' : '버프'}</td>
              <td>{s.power}</td>
              <td>{s.uses}</td>
              <td>{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>층 구성</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>층</th>
            <th>이름</th>
            <th>함정 DC</th>
            <th>함정 피해</th>
            <th>보물</th>
            <th>조우</th>
          </tr>
        </thead>
        <tbody>
          {DUNGEON.floors.map((f) => (
            <tr key={f.depth}>
              <td>{f.depth}</td>
              <td>{f.name}</td>
              <td>{f.trapDc}</td>
              <td>{f.trapDamage}</td>
              <td>{f.treasure}</td>
              <td>
                {f.encounters
                  .map((e) => `${e.monsterId}×${e.count} (${e.weight})`)
                  .join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}
