# Survev Fireteam — Performance Baseline

> Written: 2026-10-21 | Branch: perf/lag-reduction  
> Purpose: Repeatable stress scenario + how to collect numbers.

---

## How to Enable Per-Subsystem Logging

The game loop already logs average ms/tick every 15 seconds when
`Config.logging.debugLogs` is `true` (the default in dev mode). To also see
per-subsystem profiler stats, set `logging.debugLogs: true` in
`survev-config.hjson` **or** run in dev mode.

To observe a spike in real time:

```powershell
# Terminal 1 — run dev server (logs go to stdout)
bun run dev

# Terminal 2 — tail logs (PowerShell)
# (bun dev writes to stdout; redirect or use split terminal)
```

When a tick exceeds `4 × (1000 / gameTps)` ms (= **40 ms at TPS 100**),
the server logs `"[WARN] Slow tick: …ms | profiler: …"` automatically.  
When it exceeds **1000 ms**, `"[ERROR] Very slow tick"` fires with full
profiler stats.

For continuous 15-second rolling averages, set `logging.debugLogs: true`.
The output format is:
```
[DEBUG] Avg ms/tick: X.XX | Load: Y.Y%
```

---

## Repeatable Stress Scenario

### Setup

1. `bun run dev` (dev mode, single process, no Docker)
2. Join a Spec Ops match (map: `specops`, any difficulty)
3. Reach Wave ≥ 3 so enemies are plentiful (≥ 20 alive)
4. Call an airstrike (obtainable from the shop during prep)

> **Important**: the airstrike fires 3–4 planes × 20 bombs = 60–80 bomb_iron
> projectiles. Their fuses (~1.5 s) expire within a 2-tick window, causing
> the worst-case explosion spike.

### Trigger sequence

| Step | Action | Expected spike |
|------|--------|----------------|
| A | Fire airstrike (all 3 planes) | 60–80 `explosionBarn` entries in 1–2 ticks |
| B | Mass grenade throw (8+ frags) | ~50 extra shrapnel bullets per tick |
| C | Survive to wave 10+ (lots of dead AI = many decals) | Accumulated decal linear scan |

### What to record

After each scenario, note the output of the debug log:

```
[DEBUG] Avg ms/tick: X.XX | Load: Y.Y%
```

And check the game's warn/error logs for slow-tick profiler dumps.

---

## Baseline Numbers (UNMEASURED — Placeholder)

> ⚠️ **These numbers have not yet been measured.** They must be recorded in a
> live dev session before any optimisation work begins. The rows below are
> placeholders showing the measurement protocol.

### How to read numbers from the game

Enable `logging.debugLogs: true` in your local `survev-config.hjson` (not
committed), then run `bun run dev`.

Watch for the 15-second rolling lines. During the airstrike spike you will see
warn-level slow-tick logs with profiler stats like:

```
[WARN] Slow tick: 52.3ms | subsystem ms: explosions=38.1 specOps=8.2 bullets=4.1 ...
```

Record peak tick time + per-subsystem breakdown.

### Protocol

1. Join Spec Ops, reach Wave 3, note 15-s avg (idle baseline).
2. Call airstrike, record peak warn log + profiler dump.
3. Repeat step 2 three times; use the median peak as the number.
4. Paste below.

---

### Idle baseline (no airstrike, ~20 enemies alive)

| Metric | Value |
|--------|-------|
| Avg ms/tick (15-s window) | *UNMEASURED* |
| Load % | *UNMEASURED* |
| Subsystem breakdown | *UNMEASURED* |

### Airstrike spike (3 planes × 20 bombs, Wave 3)

| Metric | Value |
|--------|-------|
| Peak tick time (ms) | *UNMEASURED* |
| Peak load % | *UNMEASURED* |
| `explosions` subsystem (ms) | *UNMEASURED* |
| `specOps` subsystem (ms) | *UNMEASURED* |
| `bullets` subsystem (ms) | *UNMEASURED* |
| `decals` subsystem (ms) | *UNMEASURED* |
| Simultaneous explosions | *UNMEASURED* |

### Late-game (Wave 10+, many decals accumulated)

| Metric | Value |
|--------|-------|
| Decal count (server objectRegister) | *UNMEASURED* |
| Avg ms/tick with vs without airstrike | *UNMEASURED* |

---

## Static Analysis Numbers (code-derived, no measurement needed)

These are calculated from the source and are reliable without a live run.

| Parameter | Value | Source |
|-----------|-------|--------|
| `gameTps` | 100 | `config.ts:712` |
| `netSyncTps` | 33 | `config.ts:713` |
| Tick budget | **10 ms** | 1000 / 100 |
| Net sync budget | **~30 ms** | 1000 / 33 |
| Slow-tick warn threshold | **40 ms** | 4× budget (`game.ts`) |
| `bombCount` per plane | 20 | `shared/gameConfig.ts:292` |
| Planes per Spec Ops airstrike | 3–4 | `plane.ts` `addAirstrikeZone` |
| Bombs per airstrike (max) | **80** | 4 × 20 |
| `bomb_iron` radius | ~14 units | `throwableDefs.ts` |
| Rays per explosion (rad=14) | **~117** | `acos(1 - (0.75/14)²/2)` → step≈0.054 |
| Shrapnel per frag | 3–6 | `throwableDefs.ts` |
| Max bullets one airstrike (approx) | **480** | 80 × 6 shrapnel |
| AI brains per tick (Wave 10) | 30–60 | `specOpsManager.ts` wave config |
| Decal lifetime: `decal_frag_explosion` | **permanent** | no `lifetime` field in `mapObjectDefs.ts:35605` |
| Decal lifetime: `decal_bomb_iron_explosion` | 2.5–4 s | `mapObjectDefs.ts:35647` |
| Max queued object IDs | 65 535 | `gameObject.ts:53` |
| `particleCap` at high quality | 512 | `graphicsQuality.ts:76` |
| `audioMaxVoices` at high quality | 48 | `graphicsQuality.ts:83` |

---

## Reproducing the Worst Case Precisely

To produce a deterministic worst case for before/after comparisons:

```typescript
// Paste into the browser console while in a dev game, or use the EditMsg path
// (requires debug.allowEditMsg=true in config)
//
// Or: ask specOps manager to spawn wave and immediately call airstrike
// via the in-game debug panel if allowNpcSpawn=true.
```

Alternatively, use `tests/` vitest suites if a game simulation harness exists:

```powershell
bun run --cwd server test     # run existing server tests
```

---

## Next Steps Before Optimising

1. **Fill in the UNMEASURED rows above** (15 min of play + log reading).
2. **Confirm the hottest subsystem** from the profiler dump during spike.
3. Proceed to the ranked hotspot list below for approval before any code change.

See `docs/perf/CHANGES.md` for the per-change log (created at first change).
