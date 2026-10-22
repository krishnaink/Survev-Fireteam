# Survev Fireteam — Performance Architecture

> Written: 2026-10-21 | Branch: perf/lag-reduction  
> Purpose: Phase 1 read-and-map for targeted lag reduction.

---

## 1. Server Process Model

```
bun run start
  ├── API process          :8000   (Hono HTTP)
  ├── Game Manager         :8001   (IPC parent, spawns game procs)
  ├── Game process × N     :9000+  (one per active match)
  └── prod-web.ts          :3000   (Caddy proxy / static host)
```

Each game process runs two independent timers (set via `NanoTimer` on Windows,
`setInterval` elsewhere):

| Timer | Rate | Purpose |
|-------|------|---------|
| `game.update()` | `Config.gameTps = 100` (10 ms/tick) | Physics, AI, damage, explosions |
| `game.netSync()` | `Config.netSyncTps = 33` (~30 ms/tick) | Serialise dirty objects, send to clients |

The game loop and net-sync loop are **decoupled**: update runs ~3× per sync tick.
This means burst work (many explosions in one tick) is paid in full before the
next sync sends the result to clients.

---

## 2. Server Game Loop — `game.update()` (`server/src/game/game.ts`)

```
game.update(dt)
  profiler.flush()                ← reset per-subsystem timers
  profiler.addSample("gas")       → gas.update(dt)
  profiler.addSample("specOps")   → specOps.update(dt)   ← AI + wave logic (biggest)
  profiler.addSample("players")   → playerBarn.update(dt)
  profiler.addSample("clients")   → clientBarn.update(dt)
  profiler.addSample("map")       → map.update(dt)
  profiler.addSample("loot")      → lootBarn.update(dt)
  profiler.addSample("bullets")   → bulletBarn.update(dt)
  profiler.addSample("projectiles")→ projectileBarn.update(dt)
  profiler.addSample("explosions") → explosionBarn.update()   ← spike source
  profiler.addSample("smoke")     → smokeBarn.update(dt)
  profiler.addSample("airdrops")  → airdropBarn.update(dt)
  profiler.addSample("deadBodies")→ deadBodyBarn.update(dt)
  profiler.addSample("decals")    → decalBarn.update(dt)   ← O(N) lifetime checks
  profiler.addSample("planes")    → planeBarn.update(dt)
  ──────
  tickTime = performance.now() - now
  if tickTime > 1000ms  → logger.error + profiler.getStats()
  if tickTime > tickTimeWarnThreshold (4× budget) → logger.warn
  if Config.logging.debugLogs:
      tickTimes.push(tickTime)
      every 15 s → log "Avg ms/tick | Load %"
```

**`profiler`** (`server/src/game/profiler.ts`): stack-based, `performance.now()`
timestamps per subsystem. `getStats()` sorts by descending `took` ms.
It resets every tick (`profiler.flush()` at the top of `update()`).
There is currently **no option to log profiler stats periodically** — it only
prints on critical overload. (Phase 2 adds that hook.)

---

## 3. Net Sync — `game.netSync()` (`game.ts`)

```
netSync()
  t1: objectRegister.serializeObjs()   → iterate all objects; write BitStream for dirty ones
  t2: clientBarn.sendMsgs()            → per client: compute visible set, build UpdateMsg, send
  t3: flush()                          → zero dirty flags, clear newExplosions/newBullets lists
```

### `objectRegister.serializeObjs()` (`gameObject.ts:172`)

Iterates `this.objects[]` (all registered GameObjects). For each:
- `dirtyFull[id]` → call `obj.serializeFull()` (writes both partial + full streams)
- `dirtyPart[id]` → call `obj.serializePartial()` (writes partial stream only)

Serialization writes into pre-allocated per-object `BitStream` buffers (set up
in `BaseGameObject.init()`). No allocation per tick.

### `clientBarn.sendMsgs()` (`client.ts:46`)

For each client (two passes: healthy first, backpressured second):
1. Compute visible AABB from player zoom
2. `grid.intersectAABBSetInto()` → new visible set (reuses scratch buffer to avoid alloc)
3. Diff old vs new visible: compute `fullObjects`, `partObjects`, `delObjIds`
4. Build `UpdateMsg` (explosions, bullets, plane zones go in the shared `msgsToSend` stream)
5. `socket.send(buffer)` via Bun WebSocket

Explosions are serialised into a shared `ClientBarn.msgsToSend` stream that all
clients read from, rather than duplicating per client.

---

## 4. Explosion Flow — Server to Client

### Server side (`server/src/game/objects/explosion.ts`)

**`ExplosionBarn.update()`** processes every queued explosion **in the same tick
it was added**. The queue is populated during `projectileBarn.update()` (when
`bomb_iron` fuse time expires) and `bulletBarn.update()` (on-hit explosions).

```
ExplosionBarn.update()
  for each explosion in this.explosions:
    explode(explosion)
      ├── addDecal(def.decalType, …)         ← registers Decal object into grid/objectRegister
      ├── (smoke explosion → addEmitter, return)
      ├── grid.intersectCollider(circleRad)  ← broad-phase: all objects in radius
      │   .filter(Player | Obstacle | Loot, sameLayer, !dead)  ← array allocation per explosion
      ├── step = min(acos(1 - (0.75/rad)²/2), 0.3)           ← raycast angle step
      │   for rad=14: step ≈ 0.0536 rad → ~117 rays
      ├── for angle from -π to π, step angle:
      │     for each obj in objects:
      │       coldet.test(centerCircle, obj.collider)          ← center-inside check
      │       collider.intersectSegment(obj.collider, …)       ← line-segment intersection
      │     lineCollisions.sort(…)                             ← sort per ray (heap alloc)
      │     damageObject(…)
      ├── spawn shrapnel bullets (fireBullet × shrapnelCount)
      └── clear this.explosions
```

**Ray count formula**: `2π / acos(1 - (0.75/rad)²/2)`
- `bomb_iron` rad ≈ 14 → ~117 rays
- `frag` rad ≈ 12 → ~99 rays

With a 3-plane airstrike (20 bombs each = 60 bombs), bombs drop 1 per 2 ticks
(`dropDelayCounter % 2`), so at most ~10 land per tick, but fuses expire
together → **60–80 explosions in 1–2 ticks** near the end of the airstrike.

Each explosion: up to 117 rays × N nearby objects intersection tests +
1 `.filter()` allocation + N sort allocations.

### Decal accumulation

Each `explosion_bomb_iron` call creates a `decal_bomb_iron_explosion` server
object (registered in grid, serialised, sent full to all nearby clients).
With 60–80 bombs: 60–80 new Decal objects per airstrike.

`decal_frag_explosion` and `decal_frag_small_explosion` have **no `lifetime`
field** — they are **permanent** objects. They accumulate across the match
until the game ends, growing the serialisation and grid-query costs.

`decal_bomb_iron_explosion` already has `lifetime: { min: 2.5, max: 4 }` and
`fadeChance: 1` — this was an earlier fix.

### Shrapnel bullets

`frag` spawns `shrapnelCount` bullets (typically 3–6). Each bullet calls
`grid.intersectLineSegment()` in its `init()`. With 60 frags × 6 shrapnel =
360 additional bullets in one tick.

### Client side (`client/src/objects/explosion.ts`)

The client receives `newExplosions[]` in the UpdateMsg. For each:
- Creates particle effects (emitters spawned in `particles.ts`)
- Camera shake (`camera.ts` shake accumulation — stacks with 80 simultaneous)
- Audio: `audioManager.playSound("bomb_iron_explosion", …)` — limited by
  `audioMaxVoices` (12/24/48 per quality level in `graphicsQuality.ts`)

---

## 5. Bullet Flow

**Server**: `BulletBarn.update()` iterates `this.bullets[]` (pool, not reallocated).
Each active bullet calls `bullet.update(dt)` → `checkForCollisions(posOld)`.
Collision query: `grid.intersectLineSegment(posOld, pos)` — swept segment.

Shrapnel bullets from explosions are added to `newBullets[]` during the same
tick; they are ticked starting **next** tick (because `active` flag is set at
end of `init`). This correctly prevents double-processing.

**Allocation issue in `fireBullet()`**: `this.bullets.find((b) => !b.active && b.sentToClient)`
— linear scan of the pool every time a bullet is fired. With hundreds of active
bullets, this becomes O(N). Pool is only trimmed when `> 512` and `< 50%` active.

Also: `this.damagedObjIds = new Set()` on every `init()` — a fresh Set allocation
per bullet.

---

## 6. Projectile Flow

**Server** (`server/src/game/objects/projectile.ts`): Projectiles move with
gravity arc. When fuse time expires, `explosionBarn.addExplosion()` is called.

`AirStrikePlane.dropBomb()` calls `projectileBarn.addProjectile()` per bomb.
Bombs drop every 2 ticks from each plane (`dropDelayCounter % 2 == 0`).
`bombCount = 20` per plane, 3–4 planes per Spec Ops airstrike zone.

`bomb_iron` `fuseTime` (in `throwableDefs.ts`) determines how many ticks elapse
before all bombs detonate. They tend to cluster-detonate within a few ticks,
causing the spike.

---

## 7. Decal Flow (Server → Client)

### Server `DecalBarn.update(dt)` (`server/src/game/objects/decal.ts`)

Linear scan of `this.decals[]`. Decrements `lifeTime`; splices dead decals.
`splice` is O(N) — bad if many decals accumulate (N can be hundreds after
extended Spec Ops matches).

### Client `DecalBarn.m_update()` (`client/src/objects/decal.ts`)

Two loops:
1. `decalPool.m_getPool()` — update gore level for each active Decal (cheap)
2. `decalRenders[]` — for every active `DecalRender`: update sprite position,
   scale, alpha, **call `renderer.addPIXIObj()`** every frame with no
   off-screen culling.

`renderer.addPIXIObj()` checks if layer/zOrd/zIdx changed; if sprite is already
at correct position in the right layer it early-returns. But the camera transform
(`camera.m_pointToScreen()`) is computed every frame for every decal regardless
of whether it's on screen.

There is **no frustum check** in `DecalRender.update()`. With 200–400 permanent
decals accumulated over a long Spec Ops match, this submits ~400 PIXI draw calls
per frame even when decals are off-screen.

---

## 8. Smoke & Plane Flow

### Smoke (`server/src/game/objects/smoke.ts`)

Server `SmokeBarn.update(dt)`: moves emitters, ages particles. Sent as Smoke
objects in UpdateMsg.

Client `smoke.ts`: `smokeMaxDist` and `smokeSkipEvery` from `graphicsQuality.ts`
already throttle rendering at medium/low quality.

### Planes (`server/src/game/objects/plane.ts`)

**`PlaneBarn.update(dt)`**:
- Iterates `airstrikeZones[]` → each zone fires one plane per `airstrikeInterval`
- `AirStrikePlane.update(dt)` drops one bomb per 2 ticks once drop zone reached
- `getAirstrikeZonePos()` iterates `livingPlayers` to find highest-density area —
  called once per plane spawn (not every tick)
- `AirstrikeZone.getAirstrikePos()` may iterate `livingPlayers` with shuffleArray
  (array allocation)

Planes are sent to clients via `PlaneBarn.flush()` → `newAirstrikeZones` array.
Client renders plane sprites and zone indicator rings.

---

## 9. Spec Ops AI — `SpecOpsManager.update(dt)` (`specOpsManager.ts`)

The `SpecOpsManager` is a 311 KB / 8,383-line file. The `update()` method runs
every game tick (inside `profiler.addSample("specOps")`).

### Per-tick work in `update()` (lines ~5950–6136)

```
specOps.update(dt)
  refreshPushPressure(dt)
  enemiesAlive count check → hudDirty
  phase timer (prep/intermission/combat)
    combat:
      contracts.update(dt)
      tickGloryHorde()
      tickGloryHelpers(dt)
      waveSpawnComplete check → beginIntermission()
  tickWaveSpawns(dt)         ← staggered enemy spawn queue
  nav.decay(dt)              ← NavField pressure decay
  nav.resetCrowd()           ← reset crowd density grid
  for each brain: nav.occupy(brain.player.pos)
  for each brain: brain.update(dt, this)    ← THE HOT PATH
  tickDiscoveryHunt(dt)
  relocateStuckEnemies()
  toRemove cleanup
```

### Per-brain `brain.update(dt, specOps)` (called every tick for every living AI)

Each AI brain runs every tick at full `gameTps = 100`. With 30–60 enemies alive,
this is 30–60 full brain evaluations per 10 ms tick.

Inside each brain update, the AI:
1. Evaluates target selection (`getTarget()`) — scans nearby players
2. Calls `findRouteWaypoint()` which may invoke:
   - `isPathClear()` → `grid.intersectLineSegment()`
   - `MapNavGraph.firstWaypoint()` → A* pathfinding with `pathCache`
   - `collectNavObstacles()`, `buildingContaining()` — grid queries
3. Fires weapons (triggers `playerBarn` → `weaponManager`)
4. Throws grenades (triggers `projectileBarn.addProjectile()`)

The `MapNavGraph.path()` has a `pathCache` (Map<string, Vec2[] | null>) keyed by
`"x1,y1→x2,y2|layer1|layer2"`. Cache key is computed every time; **cache does
NOT expire or have a TTL** — it's valid for the static map geometry but player
positions change, so `firstWaypoint(from, goal)` is called with different
`from` values each tick, generating many unique cache keys.

### `livingHumans()` / `livingWeakEnemies()` usage

These are computed via array comprehension inside the update flow. From grep:
- Line 6095: `this.livingWeakEnemies().length` — called every combat tick during glory wipe
- Line 6152: `this.livingHumans()` — called on early-start, not hot path

### NavField (`nav` in SpecOpsManager)

`nav.decay(dt)` and `nav.resetCrowd()` run every tick. The NavField is a
pressure-diffusion grid used for enemy routing. `nav.occupy()` is called per
alive brain — O(N_enemies).

---

## 10. Client Render Loop (`client/src/game.ts`, `renderer.ts`)

### `game.ts` (75 KB) — main client update

Called by PIXI ticker every animation frame (~60 fps):
```
game.m_update(dt)
  processGameUpdate()       ← consume server UpdateMsg (sets dirty flags, creates client objects)
  camera.m_update()
  renderer.m_update()       ← sort PIXI layers if dirty
  playerBarn.m_update()
  bulletBarn.m_update()
  particleBarn.m_update()   ← particle system (capped by particleCap)
  decalBarn.m_update()      ← all decals + all decalRenders (NO off-screen cull)
  mapSpriteBarn.m_update()
  projectileBarn.m_update()
  planeBarn.m_update()
  smokeBarn.m_update()
  mapIndicatorBarn.m_update()
```

### Graphics Quality Profiles (`graphicsQuality.ts`)

| Setting | Low | Medium | High |
|---------|-----|--------|------|
| `particleCap` | 128 | 256 | 512 |
| `audioMaxVoices` | 12 | 24 | 48 |
| `explosionRippleMult` | 0.2 | 0.5 | 1.0 |
| `smokeMaxDist` | 36 | 55 | ∞ |
| `smokeSkipEvery` | 2 | 1 | 1 |
| `npcSimplifyDist` | 28 | 48 | 9999 |
| `cullMargin` | 32 | 40 | 48 |

There is no `decalCap` or decal culling parameter. Decal sprites are submitted
regardless of camera position.

### Renderer (`renderer.ts`)

Four `RenderGroup` (PIXI Container) layers. Each has a `dirty` flag; when dirty,
`checkSort()` does a full `children.sort()` by `zOrd`/`zIdx`. Adding any new
object (including every decal sprite on init) sets `dirty = true`.

When 80 bomb decals are created simultaneously, `addSortedChild()` is called
80 times → 80 `dirty = true` → one full sort of the entire layer's children list
(potentially 1000+ elements).

---

## 11. Key Numbers Summary

| Event | Count | Per-tick cost |
|-------|-------|---------------|
| One airstrike | 3–4 planes × 20 bombs | 60–80 explosions in 1–2 ticks |
| Rays per bomb_iron (rad≈14) | 117 | × N nearby objects |
| Shrapnel per frag (rad≈12) | ~3–6 bullets | 360 bullets for 60 frags |
| AI brains per tick | 30–60 (mid-wave) | each: 1+ grid queries, possible A* |
| Decals (permanent) | unlimited accumulation | linear scan + PIXI submit per frame |
| gameTps | 100 | 10 ms budget per tick |
| netSyncTps | 33 | ~30 ms budget per sync |

---

## 12. File Reference

| File | Role |
|------|------|
| `server/src/game/game.ts` | Game class, update/netSync, profiler wiring |
| `server/src/game/gameProcess.ts` | Bun process, timers, IPC |
| `server/src/game/profiler.ts` | Per-subsystem timing |
| `server/src/game/objects/explosion.ts` | Raycast explosion, shrapnel |
| `server/src/game/objects/bullet.ts` | Bullet pool, collision |
| `server/src/game/objects/plane.ts` | Airstrike zones, bomb drops |
| `server/src/game/objects/decal.ts` | Server decal lifetime |
| `server/src/game/objects/gameObject.ts` | ObjectRegister, serializeObjs |
| `server/src/game/client.ts` | ClientBarn, per-client UpdateMsg |
| `server/src/game/specOpsManager.ts` | Wave logic, AI brains (311 KB) |
| `server/src/game/specOpsNav.ts` | MapNavGraph (A* baked at map start) |
| `client/src/game.ts` | Client render loop |
| `client/src/renderer.ts` | PIXI layer management |
| `client/src/objects/decal.ts` | Client decal render (no culling) |
| `client/src/graphicsQuality.ts` | Quality presets (particleCap, voices) |
| `shared/gameConfig.ts` | airstrike.bombCount=20, planeVel=350 |
| `shared/defs/mapObjectDefs.ts` | decal definitions, lifetimes |
