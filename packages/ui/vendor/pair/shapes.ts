// @ts-nocheck: vendored from bot-avatars 0.2.2 (MIT, see LICENSE and README.md here), kept as upstream wrote it;
// it predates this repo's noUncheckedIndexedAccess, so it isn't type-checked or linted here.
import type { BotAvatarType } from './types';

export const SHAPE_PATHS = {
  opendash: 'M27.9 32.8C27.9 23 45.7 13.3 62.3 9.8C79.4 6.4 84.5 14.5 87 21.8C91.7 38.3 79.4 47.3 66.2 46.9C56.4 46.9 44.9 44.7 36.8 43.5C30.9 42.6 27.9 39.2 27.9 32.8ZM10 70.3C10 58.4 20.2 47.7 33.4 48.1C43.6 48.1 67.9 50.2 78.1 54.5C87 57.9 90.4 62.2 90 69.8C89.6 83.9 65.7 91.1 43.6 90.7C23.6 90.3 10 84.7 10 70.3Z',
} as Record<BotAvatarType, string>;

export const SHAPE_PARTS: Partial<Record<BotAvatarType, string>> = {};

export const SHAPE_SOLIDS: Partial<Record<BotAvatarType, readonly { path: string; centerX: number; centerY: number }[]>> = {
  opendash: [
    { path: 'M27.9 32.8C27.9 23 45.7 13.3 62.3 9.8C79.4 6.4 84.5 14.5 87 21.8C91.7 38.3 79.4 47.3 66.2 46.9C56.4 46.9 44.9 44.7 36.8 43.5C30.9 42.6 27.9 39.2 27.9 32.8Z', centerX: 60, centerY: 29 },
    { path: 'M10 70.3C10 58.4 20.2 47.7 33.4 48.1C43.6 48.1 67.9 50.2 78.1 54.5C87 57.9 90.4 62.2 90 69.8C89.6 83.9 65.7 91.1 43.6 90.7C23.6 90.3 10 84.7 10 70.3Z', centerX: 49, centerY: 70 },
  ],
};
