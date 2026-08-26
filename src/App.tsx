import { useCallback, useRef, useState } from 'react'
import { createCharacter, createRNG, heroAttack, heroDefend, heroSkill } from './rules'
import type { RNG } from './rules/rng'
import type { Abilities } from './rules/types'
import {
  continueRun,
  currentFloor,
  enterRoom,
  roomsOnFloor,
  settleCombat,
  startRun,
} from './game/engine'
import type { RunState } from './game/engine'
import { DUNGEON } from './data'
import { CharacterCreation } from './ui/CharacterCreation'
import { CharacterPanel } from './ui/CharacterPanel'
import { CombatView } from './ui/CombatView'
import { DataTables } from './ui/DataTables'
import { LogPanel } from './ui/LogPanel'

export default function App() {
  const [run, setRun] = useState<RunState | null>(null)
  const rngRef = useRef<RNG | null>(null)

  const start = useCallback(
    (args: { name: string; classId: string; abilities: Abilities; seed: number }) => {
      const rng = createRNG(args.seed)
      rngRef.current = rng
      const character = createCharacter(rng, {
        name: args.name,
        classId: args.classId,
        abilities: args.abilities,
      })
      setRun(startRun(args.seed, character))
    },
    [],
  )

  const rng = rngRef.current

  return (
    <>
      <header className="app-header">
        <div>
          <h1>SEPI TRPG</h1>
          <div className="subtitle">
            d20 판정 · 선제 순서 · 데이터 테이블 기반 던전 크롤러
          </div>
        </div>
        {run && (
          <button
            className="danger"
            onClick={() => {
              rngRef.current = null
              setRun(null)
            }}
          >
            처음으로
          </button>
        )}
      </header>

      {!run || !rng ? (
        <CharacterCreation onStart={start} />
      ) : (
        <RunScreen run={run} rng={rng} setRun={setRun} onRestart={() => setRun(null)} />
      )}

      <DataTables />
    </>
  )
}

function RunScreen({
  run,
  rng,
  setRun,
  onRestart,
}: {
  run: RunState
  rng: RNG
  setRun: (s: RunState) => void
  onRestart: () => void
}) {
  const floor = currentFloor(run)
  const combat = run.combat

  const eventKind =
    run.roomKind === 'trap' ? 'bad' : run.roomKind === 'rest' || run.roomKind === 'treasure' ? 'good' : ''

  return (
    <div className="grid grid-2">
      <CharacterPanel
        character={run.character}
        gold={run.gold}
        floorName={floor.name}
        roomIndex={run.roomIndex}
        roomsTotal={roomsOnFloor(run)}
        skillUses={combat?.skillUses}
      />

      <div>
        {run.phase === 'exploring' && (
          <section className="panel">
            <h2>
              지하 {floor.depth}층 · {floor.name}
            </h2>
            <p className="muted">
              앞으로 {roomsOnFloor(run) - run.roomIndex}개의 방이 남았습니다. 문을 열면 전투,
              함정, 보물, 야영지, 제단 중 하나가 기다립니다.
            </p>
            <button className="primary" onClick={() => setRun(enterRoom(rng, run))}>
              다음 방으로
            </button>
          </section>
        )}

        {run.phase === 'combat' && combat && (
          <CombatView
            combat={combat}
            character={run.character}
            onAttack={(targetId) =>
              setRun({ ...run, combat: heroAttack(rng, combat, targetId) })
            }
            onSkill={(skillId, targetId) =>
              setRun({
                ...run,
                combat: heroSkill(rng, combat, run.character, skillId, targetId),
              })
            }
            onDefend={() => setRun({ ...run, combat: heroDefend(rng, combat) })}
            onSettle={() => setRun(settleCombat(rng, run))}
          />
        )}

        {run.phase === 'event' && (
          <section className="panel">
            <h2>방을 살펴본다</h2>
            <div className={`event-card ${eventKind}`}>{run.lastEvent}</div>
            <button className="primary" onClick={() => setRun(continueRun(run))}>
              계속
            </button>
          </section>
        )}

        {run.phase === 'dead' && (
          <section className="panel ending lose">
            <div className="headline">사망</div>
            <p className="muted">
              지하 {floor.depth}층 {run.roomIndex}번째 방에서 쓰러졌습니다. <br />
              Lv.{run.character.level} · 금화 {run.gold} · 경험치 {run.character.xp}
            </p>
            <button className="primary" onClick={onRestart}>
              다시 도전
            </button>
          </section>
        )}

        {run.phase === 'cleared' && (
          <section className="panel ending win">
            <div className="headline">던전 클리어</div>
            <p className="muted">
              지하 {DUNGEON.floors.length}층의 주인을 쓰러뜨렸습니다. <br />
              Lv.{run.character.level} · 금화 {run.gold} · 경험치 {run.character.xp}
            </p>
            <button className="primary" onClick={onRestart}>
              새 모험
            </button>
          </section>
        )}

        <LogPanel title="전투 기록" lines={combat ? combat.log : run.lastCombatLog} />
        <LogPanel title="탐험 기록" lines={run.log} />
      </div>
    </div>
  )
}
