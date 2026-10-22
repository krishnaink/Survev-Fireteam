/**
 * Client graphics quality profiles for weak and strong hardware.
 */

import { coldet } from "../../shared/utils/coldet.ts";
import { v2, type Vec2 } from "../../shared/utils/v2.ts";

export const GraphicsQualities = ["low", "medium", "high"] as const;
export type GraphicsQuality = (typeof GraphicsQualities)[number];

export interface GraphicsProfile {
    quality: GraphicsQuality;
    highResTex: boolean;
    /** User render scale 0.5–1.0, applied on top of quality resolution. */
    renderScale: number;
    particleCap: number;
    cameraEmitterRateMult: number;
    cameraEmitterEnabled: boolean;
    explosionRippleMult: number;
    /** Hide aura FX for non-local players past this world distance. */
    npcSimplifyDist: number;
    /** Hide smoke sprites past this distance (Infinity = never). */
    smokeMaxDist: number;
    /** Only draw every Nth smoke particle (1 = all). */
    smokeSkipEvery: number;
    /** Soft cap on concurrent one-shot SFX voices. */
    audioMaxVoices: number;
    /** Extra world units around the camera frustum for culling. */
    cullMargin: number;
    /** When false, never skip off-screen trees/bushes. */
    foliageCulling: boolean;
    /** When true, PIXI ticker has no FPS cap. */
    uncapFps: boolean;
}

export interface GraphicsOverrides {
    highResTex?: boolean;
    foliageCulling?: boolean;
    ambientParticles?: boolean;
    simplifyDistantNpcs?: boolean;
    reduceSmokeFx?: boolean;
    uncapFps?: boolean;
}

const QualityDefaults: Record<
    GraphicsQuality,
    & Omit<GraphicsProfile, "quality" | "renderScale" | "foliageCulling" | "uncapFps" | "highResTex">
    & { highResTex: boolean }
> = {
    low: {
        highResTex: false,
        particleCap: 128,
        cameraEmitterRateMult: 4,
        cameraEmitterEnabled: false,
        explosionRippleMult: 0.2,
        npcSimplifyDist: 28,
        smokeMaxDist: 36,
        smokeSkipEvery: 2,
        audioMaxVoices: 12,
        cullMargin: 32,
    },
    medium: {
        highResTex: false,
        particleCap: 256,
        cameraEmitterRateMult: 2,
        cameraEmitterEnabled: true,
        explosionRippleMult: 0.5,
        npcSimplifyDist: 48,
        smokeMaxDist: 55,
        smokeSkipEvery: 1,
        audioMaxVoices: 24,
        cullMargin: 40,
    },
    high: {
        highResTex: true,
        particleCap: 512,
        cameraEmitterRateMult: 1,
        cameraEmitterEnabled: true,
        explosionRippleMult: 1,
        npcSimplifyDist: 9999,
        smokeMaxDist: Infinity,
        smokeSkipEvery: 1,
        audioMaxVoices: 48,
        cullMargin: 48,
    },
};

export function parseGraphicsQuality(value: unknown): GraphicsQuality {
    const key = String(value ?? "").toLowerCase();
    if ((GraphicsQualities as readonly string[]).includes(key)) {
        return key as GraphicsQuality;
    }
    return "high";
}

export function clampRenderScale(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0.5, Math.round(n * 100) / 100));
}

/** Defaults for advanced toggles when applying a quality preset. */
export function advancedDefaultsForQuality(quality: GraphicsQuality): {
    highResTex: boolean;
    ambientParticles: boolean;
    simplifyDistantNpcs: boolean;
    reduceSmokeFx: boolean;
    foliageCulling: boolean;
} {
    const base = QualityDefaults[quality] ?? QualityDefaults.high;
    return {
        highResTex: base.highResTex,
        ambientParticles: base.cameraEmitterEnabled,
        simplifyDistantNpcs: base.npcSimplifyDist < 9000,
        reduceSmokeFx: base.smokeMaxDist < Infinity || base.smokeSkipEvery > 1,
        foliageCulling: true,
    };
}

export function resolveGraphicsProfile(
    quality: GraphicsQuality,
    renderScale: number,
    overrides: GraphicsOverrides = {},
): GraphicsProfile {
    const base = QualityDefaults[quality] ?? QualityDefaults.high;
    const simplify = overrides.simplifyDistantNpcs;
    const reduceSmoke = overrides.reduceSmokeFx;
    const ambient = overrides.ambientParticles;

    return {
        quality,
        renderScale: clampRenderScale(renderScale),
        highResTex: overrides.highResTex ?? base.highResTex,
        particleCap: base.particleCap,
        cameraEmitterRateMult: base.cameraEmitterRateMult,
        cameraEmitterEnabled: ambient ?? base.cameraEmitterEnabled,
        explosionRippleMult: base.explosionRippleMult,
        npcSimplifyDist: simplify === false
            ? 9999
            : simplify === true
            ? Math.min(base.npcSimplifyDist, 48)
            : base.npcSimplifyDist,
        smokeMaxDist: reduceSmoke === false
            ? Infinity
            : reduceSmoke === true
            ? (Number.isFinite(base.smokeMaxDist) ? base.smokeMaxDist : 48)
            : base.smokeMaxDist,
        smokeSkipEvery: reduceSmoke === false
            ? 1
            : reduceSmoke === true
            ? Math.max(base.smokeSkipEvery, 2)
            : base.smokeSkipEvery,
        audioMaxVoices: base.audioMaxVoices,
        cullMargin: base.cullMargin,
        foliageCulling: overrides.foliageCulling ?? true,
        uncapFps: !!overrides.uncapFps,
    };
}

/** PIXI canvas resolution = min(dpr, quality ceiling) × user render scale. */
export function pixiResolution(profile: GraphicsProfile): number {
    const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
    const qualityCap = profile.quality === "high" ? 1.25 : profile.quality === "medium" ? 1 : 1;
    return Math.min(dpr, qualityCap) * profile.renderScale;
}

/** @deprecated Prefer resolveGraphicsProfile + pixiResolution(profile). */
export function isHighGraphics(highResTex: boolean): boolean {
    return highResTex;
}

/** Detect weak GPU / CPU / WebGL and recommend a default preset. */
export function detectRecommendedQuality(): GraphicsQuality {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (!nav) return "high";

    const mem = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
    if (typeof mem === "number" && mem > 0 && mem <= 4) return "low";
    if (nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 4) return "low";

    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl || !(gl instanceof WebGLRenderingContext)) {
            return "low"; // canvas / no WebGL
        }
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
        if (typeof maxTex === "number" && maxTex > 0 && maxTex < 4096) {
            return "low";
        }
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        if (dbg) {
            const renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "")
                .toLowerCase();
            // Common weak / old discrete and iGPU strings.
            if (
                /rx 4|rx 5[0-6]|r[79] [0-9]{3}|gt |gtx [4-7]|intel hd|uhd graphics|mali-|adreno [1-4]/
                    .test(renderer)
            ) {
                return "low";
            }
            if (/rx 580|rx 590|gtx 9|gtx 10[5-6]|intel iris/.test(renderer)) {
                return "medium";
            }
        }
        // WebGL1 without WebGL2 is often older hardware.
        const gl2 = canvas.getContext("webgl2");
        if (!gl2) return "medium";
    } catch (_e) {
        return "medium";
    }

    return "high";
}

export function suggestLowGraphicsDefault(): boolean {
    return detectRecommendedQuality() !== "high";
}

export function defaultRenderScaleForQuality(quality: GraphicsQuality): number {
    if (quality === "low") return 0.75;
    if (quality === "medium") return 0.9;
    return 1;
}

/** Expanded camera frustum test for map object culling. */
export function inCameraView(
    pos: Vec2,
    rad: number,
    viewMin: Vec2,
    viewMax: Vec2,
): boolean {
    return coldet.testCircleAabb(pos, rad, viewMin, viewMax);
}

export function expandViewAabb(
    min: Vec2,
    max: Vec2,
    margin: number,
): { min: Vec2; max: Vec2 } {
    return {
        min: v2.create(min.x - margin, min.y - margin),
        max: v2.create(max.x + margin, max.y + margin),
    };
}

// Back-compat wrappers used by earlier wiring.
export function particleCap(highResTex: boolean): number {
    return highResTex ? 512 : 192;
}

export function cameraEmitterRateMult(highResTex: boolean): number {
    return highResTex ? 1 : 3;
}

export function explosionRippleMult(highResTex: boolean): number {
    return highResTex ? 1 : 0.35;
}

/** Bump when announcement copy changes so snoozed users see the new note. */
export const COMMUNITY_ANNOUNCEMENT_VERSION = 5;
export const COMMUNITY_ANNOUNCEMENT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
export const COMMUNITY_DISCORD_URL = "https://discord.gg/w2MDPCpYqC";
export const COMMUNITY_CHANGELOG_URL = "changelogRec.html";
