import { SpecOpsBuyablePerks, specOpsUnequipSku } from "../maps/specOpsShop.ts";
import type { UnlockDef } from "./unlockDefs.ts";

/** Dummy game types so Spec Ops shop SKUs can ride PerkModeRoleSelect. */
export const SpecOpsSkuDefs: Record<string, UnlockDef> = {
    specops_sentry: {
        type: "unlock",
        name: "Sentry Gun",
        unlocks: [],
    },
    specops_airstrike: {
        type: "unlock",
        name: "Airstrike",
        unlocks: [],
    },
    specops_carepackage: {
        type: "unlock",
        name: "Care Package",
        unlocks: [],
    },
    specops_ammo: {
        type: "unlock",
        name: "Ammo Resupply",
        unlocks: [],
    },
    specops_self_revive: {
        type: "unlock",
        name: "Self Revive",
        unlocks: [],
    },
    specops_satchel_01: {
        type: "unlock",
        name: "Armor Satchel Lv1",
        unlocks: [],
    },
    specops_satchel_02: {
        type: "unlock",
        name: "Armor Satchel Lv2",
        unlocks: [],
    },
    specops_satchel_03: {
        type: "unlock",
        name: "Armor Satchel Lv3",
        unlocks: [],
    },
    specops_satchel_04: {
        type: "unlock",
        name: "Armor Satchel Lv4",
        unlocks: [],
    },
    specops_buyback_0: {
        type: "unlock",
        name: "Buy Back",
        unlocks: [],
    },
    specops_buyback_1: {
        type: "unlock",
        name: "Buy Back",
        unlocks: [],
    },
    specops_buyback_2: {
        type: "unlock",
        name: "Buy Back",
        unlocks: [],
    },
    specops_buyback_3: {
        type: "unlock",
        name: "Buy Back",
        unlocks: [],
    },
    /** Generic / fallback buy-station pulse. */
    specops_station_marker: {
        type: "unlock",
        name: "Buy Station",
        unlocks: [],
        mapIndicator: {
            sprite: "ping-map-coming.img",
            tint: 0x9dff9d,
            pulse: true,
            pulseTint: 0x6b8f3c,
        },
    },
    specops_marker_weapon: {
        type: "unlock",
        name: "Weapon Station",
        unlocks: [],
        mapIndicator: {
            sprite: "loot-weapon-ak.img",
            tint: 0xffaa44,
            pulse: true,
            pulseTint: 0xcc7722,
        },
    },
    specops_marker_gear: {
        type: "unlock",
        name: "Equipment Station",
        unlocks: [],
        mapIndicator: {
            sprite: "loot-medical-healthkit.img",
            tint: 0x66ccff,
            pulse: true,
            pulseTint: 0x3399cc,
        },
    },
    specops_marker_armor: {
        type: "unlock",
        name: "Armor Station",
        unlocks: [],
        mapIndicator: {
            sprite: "loot-chest-02.img",
            tint: 0xcccccc,
            pulse: true,
            pulseTint: 0x888888,
        },
    },
    specops_marker_support: {
        type: "unlock",
        name: "Support Station",
        unlocks: [],
        mapIndicator: {
            sprite: "loot-throwable-frag.img",
            tint: 0x88ff88,
            pulse: true,
            pulseTint: 0x44aa44,
        },
    },
    specops_marker_perk: {
        type: "unlock",
        name: "Perk Station",
        unlocks: [],
        mapIndicator: {
            sprite: "loot-perk-steelskin.img",
            tint: 0xdd88ff,
            pulse: true,
            pulseTint: 0x9944cc,
        },
    },
    specops_contract_hold: {
        type: "unlock",
        name: "Hold Zone",
        unlocks: [],
        mapIndicator: {
            sprite: "ping-map-danger.img",
            tint: 0xffcc44,
            pulse: true,
            pulseTint: 0xffaa00,
        },
    },
    specops_contract_wanted: {
        type: "unlock",
        name: "Most Wanted",
        unlocks: [],
        mapIndicator: {
            sprite: "player-the-hunted.img",
            tint: 0xff6644,
            pulse: true,
            pulseTint: 0xcc3311,
        },
    },
    // Hired support roles that are not faction perk-mode roles — still need
    // registered game types so PerkModeRoleSelect buy messages can serialize.
    assaulter: {
        type: "unlock",
        name: "Assaulter",
        unlocks: [],
    },
    suppressor: {
        type: "unlock",
        name: "Suppressor",
        unlocks: [],
    },
    flanker: {
        type: "unlock",
        name: "Flanker",
        unlocks: [],
    },
    cqc: {
        type: "unlock",
        name: "CQC",
        unlocks: [],
    },
};

for (let i = 0; i < SpecOpsBuyablePerks.length; i++) {
    const perk = SpecOpsBuyablePerks[i];
    SpecOpsSkuDefs[specOpsUnequipSku(perk)] = {
        type: "unlock",
        name: "Sell Perk",
        unlocks: [],
    };
}
