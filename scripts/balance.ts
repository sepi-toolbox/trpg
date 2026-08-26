/**
 * 밸런스 시뮬레이터.
 *
 *   npm run balance          # 직업당 100판
 *   npm run balance -- 500   # 회수 지정
 *
 * "평균적인 플레이어" 정책(src/app/autopilot.ts)으로 모험 전체를 자동 주파한다.
 * 데이터 테이블(JSON)을 고친 뒤 이 숫자의 변화를 보고 조정하면 된다.
 * broken 이 0이 아니면 밸런스가 아니라 엔진 결함이다 — 즉시 조사할 것.
 */
import { loadGameData } from '../src/system/load'
import { simulate } from '../src/app/autopilot'
import type { AutoProfession } from '../src/app/autopilot'

const RUNS = Number(process.argv[2]) || 100
const data = loadGameData()

console.log(`밸런스 시뮬레이션 — 직업당 ${RUNS}판, 시드 0..${RUNS - 1}\n`)
console.log('직업     클리어      사망(보스전)     엔진결함   평균 일수')
console.log('─'.repeat(60))

for (const profession of ['fighter', 'mage'] as AutoProfession[]) {
  const s = simulate(data, profession, RUNS)
  const pct = (n: number) => `${((n / RUNS) * 100).toFixed(0)}%`.padStart(4)
  console.log(
    `${(profession === 'fighter' ? '무인' : '술사').padEnd(7)} ` +
      `${String(s.cleared).padStart(4)} (${pct(s.cleared)})  ` +
      `${String(s.dead).padStart(4)} (보스 ${s.deathAtBoss})   ` +
      `${String(s.broken).padStart(5)}     ` +
      `${s.averageDays.toFixed(1)}일`,
  )
}

console.log('\nbroken > 0 이면 진행 불가 버그다. 클리어율 조정은 data/*.json 에서.')
