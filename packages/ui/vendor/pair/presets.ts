// @ts-nocheck: vendored from bot-avatars 0.2.2 (MIT, see LICENSE and README.md here), kept as upstream wrote it;
// it predates this repo's noUncheckedIndexedAccess, so it isn't type-checked or linted here.
import type { BotAvatarFace, BotAvatarPreset, BotAvatarState, BotAvatarType } from './types';

/**
 * The built-in types: each body has its own colour and says where on it the
 * face sits. Every type wears the eyes alone by default.
 */
export const botAvatarPresets = {
  opendash: { label: 'OpenDash Pair', color: '#A79AF4', face: 'eyes', faceX: 60, faceY: 30, faceScale: 0.62, saturation: 1, furLength: 0.6, furFuzz: 0.55, fabricShadow: 0.45, fabricLightFront: 50 },
} as Record<BotAvatarType, BotAvatarPreset>;

export const botAvatarTypes = Object.keys(botAvatarPresets) as BotAvatarType[];
export const botAvatarFaces: BotAvatarFace[] = ['eyes', 'mouth'];
export const botAvatarStates: BotAvatarState[] = ['default', 'working', 'sleeping', 'thinking', 'listening', 'success', 'error'];

/** Body colour by type — the palette on its own. */
export const botAvatarPalette: Record<BotAvatarType, string> = Object.fromEntries(
  botAvatarTypes.map((t) => [t, botAvatarPresets[t].color])
) as Record<BotAvatarType, string>;

export const stateLabels: Record<BotAvatarState, string> = {
  default: 'idle',
  working: 'working',
  sleeping: 'sleeping',
  thinking: 'thinking',
  listening: 'listening',
  success: 'success',
  error: 'needs attention',
};
