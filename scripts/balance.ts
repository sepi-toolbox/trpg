/**
 * 밸런스 시뮬레이터.
 *
 *   npm run balance            # 클래스당 300회
 *   npm run balance -- 2000    # 회수 지정
 *
 * "합리적인 플레이어" 정책(src/game/autoplay.ts)으로 던전을 자동 주파해서
 * 클래스별 클리어율과 도달 층 분포를 뽑는다.
 * JSON 테이블을 고친 뒤 이 숫자가 어떻게 움직이는지 보고 조정하면 된다.
 */
import { simulateClass } from '../src/game/autoplay'
import { CLASSES, DUNGEON } from '../src/data'

const RUNS = Number(process.argv[2]) || 300

console.log(`밸런스 시뮬레이션 — 클래스당 ${RUNS}회, 시드 0..${RUNS - 1}\n`)

const depthHeader = DUNGEON.floors.map((f) => `${f.depth}층`.padStart(6)).join('')
console.log(`클래스     클리어율   평균도달${depthHeader}`)
console.log('─'.repeat(40 + DUNGEON.floors.length * 6))

for (const cls of CLASSES) {
  const stats = simulateClass(cls.id, RUNS)
  const hist = stats.depthHistogram.map((n) => String(n).padStart(6)).join('')
  console.log(
    `${cls.name.padEnd(9)} ${(stats.clearRate * 100).toFixed(1).padStart(6)}%   ` +
      `${stats.averageDepth.toFixed(2).padStart(6)}${hist}`,
  )
}

console.log(
  '\n도달 층 = 사망하거나 클리어한 시점의 층. 클리어율이 0%면 그 클래스는 사실상 플레이 불가입니다.',
)
