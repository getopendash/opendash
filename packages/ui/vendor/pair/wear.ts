// @ts-nocheck: vendored from bot-avatars 0.2.2 (MIT, see LICENSE and README.md here), kept as upstream wrote it;
// it predates this repo's noUncheckedIndexedAccess, so it isn't type-checked or linted here.
/* Pair wears nothing: the accessories' renderer (wear.ts, mesh.ts) is left out, and these never draw. */
import type { BotAvatarGlasses, BotAvatarHat } from './types';

export interface Wear {
  hat: BotAvatarHat;
  glasses: BotAvatarGlasses;
  headphones: boolean;
  bowTie: boolean;
  /** the hat's, the headphones' and the bow tie's colour */
  color: string;
  /** the body is plush: the bow tie is the same felt rather than satin */
  fabric?: boolean;
}

export interface WearRig {
  cy: number; sy: number; cp: number; sp: number;
  facing: number;
  halfDepth: number;
  lx: number; ly: number;
}

export interface EyeSpot {
  x: number;
  y: number;
  sx: number;
  sy: number;
  z: number;
  /** the eye's design position on the face, and the face sphere's depth there */
  ox: number;
  oy: number;
  fz: number;
}

export function drawGlasses(..._: unknown[]): void {}
export function drawWearBehind(..._: unknown[]): void {}
export function drawWearFront(..._: unknown[]): void {}
