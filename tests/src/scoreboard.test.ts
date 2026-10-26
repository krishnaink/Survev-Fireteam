import { expect, test } from "vitest";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { InputMsg } from "../../shared/net/inputMsg.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";
import "./testHelpers.ts";

const reviveDur = GameConfig.player.reviveDuration + 0.1;

test("Scoreboard: revive credits the reviver, down credits the downed player", () => {
    const game = createGame(TeamMode.Squad, "test_normal");
    const group = game.playerBarn.addGroup(false);
    const medic = game.playerBarn.addTestPlayer({ group });
    medic.promoteToRole("medic");
    const downedPlayer = game.playerBarn.addTestPlayer({ group });

    downedPlayer.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Airdrop,
        dir: v2.randomUnit(),
    });
    expect(downedPlayer.downed).toBeTruthy();

    const msg = new InputMsg();
    msg.addInput(GameConfig.Input.Interact);
    medic.handleInput(msg);
    game.step(reviveDur);
    expect(downedPlayer.downed).toBeFalsy();

    const rows = game.playerBarn.getScoreboard();
    const medicRow = rows.find((r) => r.playerId === medic.__id)!;
    const downedRow = rows.find((r) => r.playerId === downedPlayer.__id)!;
    expect(medicRow.revives).toBe(1);
    expect(medicRow.downs).toBe(0);
    expect(downedRow.downs).toBe(1);
    expect(downedRow.revives).toBe(0);
});

test("Scoreboard: cash earned tracks gains, ignores spending, refunds and starting cash", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    const specOps = game.specOps!;

    const before = player.specOpsCashEarned;
    specOps.grantCash(player, 500);
    specOps.grantCash(player, 250);
    expect(player.specOpsCashEarned).toBe(before + 750);

    specOps.grantCash(player, -300); // spending
    specOps.grantCash(player, 100, true, false); // refund-style grant
    expect(player.specOpsCashEarned).toBe(before + 750);

    const row = game.playerBarn.getScoreboard().find((r) => r.playerId === player.__id)!;
    expect(row.cashEarned).toBe(before + 750);
    expect(row.kills).toBe(player.kills);
});

test("Scoreboard: lists human operators only, sorted by id", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const a = game.playerBarn.addTestPlayer({ name: "A" });
    const b = game.playerBarn.addTestPlayer({ name: "B" });
    game.update(0.1);
    const ids = game.playerBarn.getScoreboard().map((r) => r.playerId);
    expect(ids).toContain(a.__id);
    expect(ids).toContain(b.__id);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
});
