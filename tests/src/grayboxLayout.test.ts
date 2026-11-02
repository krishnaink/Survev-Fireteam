import { expect, test } from "vitest";

import { GrayboxEditorModel } from "../../client/src/debug/grayboxEditorModel.ts";
import {
    createGrayboxLayout,
    parseGrayboxLayout,
    serializeGrayboxLayout,
    snapGrayboxCoordinate,
} from "../../shared/debug/grayboxLayout.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { createGame } from "./gameTestHelpers.ts";

test("graybox layouts validate, serialize, and snap coordinates", () => {
    const layout = createGrayboxLayout("specops");
    layout.objects.push({
        id: "layout-1",
        kind: "obstacle",
        type: "reserve_wall_int_10",
        x: 12.5,
        y: 24,
        ori: 1,
        layer: 0,
    });

    expect(parseGrayboxLayout(serializeGrayboxLayout(layout))).toEqual(layout);
    expect(snapGrayboxCoordinate(12.26, 0.5)).toBe(12.5);
    expect(() => parseGrayboxLayout({ ...layout, version: 99 })).toThrow(
        "Unsupported layout version",
    );
});

test("graybox editor history restores placement and movement", () => {
    const model = new GrayboxEditorModel("specops");
    const wall = model.add({
        kind: "obstacle",
        type: "reserve_wall_int_10",
        x: 10,
        y: 10,
        ori: 0,
        layer: 0,
    });
    model.update(wall.id, { x: 14, ori: 1 });

    expect(model.layout.objects[0]).toMatchObject({ x: 14, ori: 1 });
    expect(model.undo()).toBe(true);
    expect(model.layout.objects[0]).toMatchObject({ x: 10, ori: 0 });
    expect(model.redo()).toBe(true);
    expect(model.layout.objects[0]).toMatchObject({ x: 14, ori: 1 });
});

test("server applies live graybox obstacles and ignores design markers", () => {
    const game = createGame(TeamMode.Solo, "specops");
    const layout = createGrayboxLayout("specops");
    layout.objects.push(
        {
            id: "layout-1",
            kind: "obstacle",
            type: "reserve_wall_int_10",
            x: 32,
            y: 32,
            ori: 0,
            layer: 0,
        },
        {
            id: "layout-2",
            kind: "obstacle",
            type: "house_door_01",
            x: 42,
            y: 32,
            ori: 1,
            layer: 0,
        },
        {
            id: "layout-3",
            kind: "zombie_spawn",
            type: "zombie_spawn",
            x: 50,
            y: 50,
            ori: 0,
            layer: 0,
        },
    );

    game.map.applyDebugLayout(serializeGrayboxLayout(layout));
    expect(game.map.debugLayoutObstacles.map((object) => object.type)).toEqual([
        "reserve_wall_int_10",
        "house_door_01",
    ]);
    expect(game.map.obstacles).toEqual(expect.arrayContaining(game.map.debugLayoutObstacles));

    game.map.applyDebugLayout(serializeGrayboxLayout(createGrayboxLayout("specops")));
    expect(game.map.debugLayoutObstacles).toHaveLength(0);
});
