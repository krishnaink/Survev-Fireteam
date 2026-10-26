# Bot-mode combat and practice menu update

Base: `origin/bot-mode`, commit `fd8f5c8ec86c8fcb8ed940eae99188adb9888c47`.

## Behavior

- Each practice bot has a primary gun, optional secondary gun (including Random
  or a second copy of its primary), and a melee weapon.
- Quick switch and auto melee can be enabled independently for each bot. Quick
  switching starts after an actual shot and uses normal weapon-manager swaps.
  It alternates loaded guns or holsters/re-equips a lone slow sniper when doing
  so saves time. Native equip delays, shared shotgun deployment groups, burst
  locks and reload rules still apply; weapon definitions are unchanged.
- Practice bots aim at a projectile interception point using bullet speed,
  muzzle distance and the target's velocity. Accuracy controls a brief aim bias;
  intrinsic gun spread still applies. Bots wait for their configured reaction
  time and line of sight, and fire on the weapon's native cadence without the
  extra Spec Ops burst pauses. Melee prediction accounts for relative movement
  and remaining swing wind-up. A pending swing can finish before switching back.
- These combat controls are constructed only for practice bots. Ordinary
  Spec Ops combat keeps its existing paths.
- The practice panel has **Your setup** and **Bots** tabs. Loadout, gear and item
  spawning are in Your setup; bot count, weapons, movement, combat and respawns
  are in Bots. Switching tabs retains edits. Start/Apply stays accessible while
  scrolling. Keyboard arrows, Home and End navigate the tabs. The existing
  **P** key still opens the panel on this branch.
- **Spawn on ground** creates a normal pickup near the player on their current
  layer. Items remain outside the inventory until picked up. The selector also
  includes perks, which are granted through their normal pickup behavior.
  Ammo/consumable quantities can be set; weapons, gear and perks spawn singly.
  The debug editor's separate inventory-give action is unchanged.

The uploaded userscript was reviewed as text and its string constants were
decoded for reference. It is not executed, injected into the client or included
in this patch. The implementation uses the game's server APIs.

## Updating

Stop the running server. Save `bot-mode-update.patch` in a clean bot-mode checkout
and run:

```sh
git apply --check bot-mode-update.patch
git apply bot-mode-update.patch
bun run dev
```

Reload all browser windows after restarting. Protocol **1028** carries the new
bot settings; the client and server must be updated together. Old saved practice
settings are sanitized with defaults for the added fields.

## Validation

- Server and client typechecks pass.
- All **37 practice tests** pass, including settings/message round trips,
  duplicate guns, actual faster sniper shots with native delays, auto melee,
  delayed melee damage, ground pickups and perk pickup behavior.
- The full suite reports **15,156 passed / 26 failed**. Failures are confined to
  the existing map-asset and Spec Ops tests. An unchanged bot-mode checkout also
  reports 26 failures; a separate fixed-seed comparison of all 189 Spec Ops
  tests shows no new failing assertions (current failures are a subset of the
  baseline's failures).
- Normal-profile and incognito browser sessions run separate practice matches.
  Both confirm tab state and bot setup. The browser confirms actual AWC and perk
  ground pickups with unchanged player inventory, keyboard tab navigation and
  damage from a configured live bot. No page errors occur.
- The exact lint command runs oxlint with five existing warnings, then fails
  downloading dprint's plugin through this environment's proxy. Standalone
  oxlint succeeds, and the changed TypeScript files pass formatting checks with
  the same official formatter plugin installed locally.

No deployment files, local configuration, external scripts or dependencies are
included. Changes are committed locally and are not pushed.
