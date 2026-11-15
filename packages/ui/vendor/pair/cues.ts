// @ts-nocheck: vendored from bot-avatars 0.2.2 (MIT, see LICENSE and README.md here), kept as upstream wrote it;
// it predates this repo's noUncheckedIndexedAccess, so it isn't type-checked or linted here.
import type { DrawConfig } from './draw';
import type { Pose } from './engine';
import { shade } from './color';
import { drawPlasticCap, mulAffine, type FurStyle, type Material, type Rig } from './plastic';

/* Small objects made by the same inflated-surface renderer as the body.
   Their view stays fixed; cached pieces move in screen space without
   rebuilding their material. Thinking sends a pulse from puff to cloud. */
interface Piece {
  path: Path2D;
  key: string;
  x: number;
  y: number;
  scale: number;
  depth: number;
}
interface Cue {
  color: string;
  pieces: Piece[];
}
interface Sprite {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D;
  ready: boolean;
  resolution: number;
}

const MAX_SPRITES = 24;
const SPRITE_SPAN = 140;
const sprites = new Map<string, Sprite>();
let outlines: Cue[] | undefined;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const radians = (n: number) => (n * Math.PI) / 180;

/* Path2D and canvas allocation are deliberately lazy: importing the package
   in a server-rendered application must not require browser globals. */
function shapes(): Cue[] {
  if (outlines) return outlines;
  const cloud = new Path2D('M25 76 C13 76 5 68 5 57 C5 47 12 39 22 38 C20 25 30 15 42 15 C53 15 61 22 64 31 C73 24 84 29 86 39 C96 42 99 51 95 60 C93 71 83 77 70 77 Z');
  const puff = new Path2D();
  puff.ellipse(50, 50, 44, 42, -0.12, 0, Math.PI * 2);
  const innerArc = new Path2D('M31 27 C27 22 28 16 33 13 C38 10 43 12 47 16 C67 35 68 65 48 84 C44 89 38 90 33 86 C28 82 29 76 33 72 C46 60 46 41 31 27 Z');
  const outerArc = new Path2D('M34 10 C30 6 31 1 36 0 C41 -1 45 1 49 5 C77 30 77 70 49 95 C45 99 40 101 35 98 C30 95 30 90 34 86 C56 66 56 32 34 10 Z');
  const check = new Path2D('M11 49 C7 45 7 39 11 35 C15 31 21 31 25 35 L40 50 L73 15 C77 11 84 11 88 15 C92 19 92 25 88 30 L48 73 C44 78 38 79 33 74 Z');
  const stem = new Path2D('M50 8 C60 8 66 14 65 24 L62 66 C61 73 57 77 50 77 C43 77 39 73 38 66 L35 24 C34 14 40 8 50 8 Z');
  const piece = (path: Path2D, name: string, x: number, y: number, scale: number, depth = 13): Piece => ({ path, key: `state-cue:v1:${name}`, x, y, scale, depth });
  outlines = [
    { color: '#E7E2EF', pieces: [piece(puff, 'puff', 10, 86, 0.11), piece(puff, 'puff', 24, 70, 0.19), piece(cloud, 'cloud', 56, 38, 0.8, 15)] },
    { color: '#C9BDEB', pieces: [piece(innerArc, 'listening-inner', 27, 50, 0.77, 12), piece(outerArc, 'listening-outer', 61, 50, 0.88, 12)] },
    { color: '#B9D4BF', pieces: [piece(check, 'check', 50, 55, 0.96, 13)] },
    { color: '#E8C3A8', pieces: [piece(stem, 'attention-stem', 50, 36, 0.81, 13), piece(puff, 'puff', 50, 84, 0.22, 13)] },
  ];
  return outlines;
}

function newSprite(resolution: number): Sprite | null {
  const side = Math.ceil((resolution * SPRITE_SPAN) / 100);
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(side, side)
    : typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!canvas) return null;
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  return ctx ? { canvas, ctx, resolution, ready: false } : null;
}

/* A lit, rounded fallback appears immediately while plastic.ts builds its
   surface/fibre maps. This is replaced by the actual relief on landing. */
function fallback(ctx: CanvasRenderingContext2D, piece: Piece, rig: Rig, color: string, mat: Material) {
  const projection = mulAffine(rig.ctm, [rig.cy, rig.sy * rig.sp, 0, rig.cp, -50 * rig.cy, -50 * (rig.sy * rig.sp + rig.cp)]);
  ctx.save();
  ctx.setTransform(projection[0], projection[1], projection[2], projection[3], projection[4], projection[5]);
  ctx.globalAlpha = 1;
  ctx.translate(-rig.lx * 2, -rig.ly * 2 + 1.5);
  ctx.fillStyle = shade(color, -0.15 - 0.06 * mat.shadow, 0.02);
  ctx.fill(piece.path);
  ctx.translate(rig.lx * 2, rig.ly * 2 - 1.5);
  const light = ctx.createRadialGradient(50 + rig.lx * 22, 48 + rig.ly * 22, 3, 50, 49, 61);
  light.addColorStop(0, shade(color, 0.06 * mat.highlight));
  light.addColorStop(0.48, color);
  light.addColorStop(1, shade(color, -0.16 - 0.05 * mat.shadow, 0.015));
  ctx.fillStyle = light;
  ctx.fill(piece.path);
  ctx.restore();
}

function paint(sprite: Sprite, cue: Cue, cfg: DrawConfig, fur: FurStyle, mat: Material, light: number, back: number | undefined) {
  const ctx = sprite.ctx;
  const unit = sprite.resolution / 100;
  const center = sprite.canvas.width / 2;
  const cy = Math.cos(-0.13), sy = Math.sin(-0.13), cp = Math.cos(0.10), sp = Math.sin(0.10);
  const lx = Math.sin(light), ly = -Math.cos(light);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, sprite.canvas.width, sprite.canvas.height);
  let ready = true;
  for (const piece of cue.pieces) {
    const s = unit * piece.scale;
    const rig: Rig = {
      cy, sy, cp, sp, facing: cy * cp, roll: 0, halfDepth: piece.depth, cap: 0.9,
      lx, ly,
      ...(back === undefined ? {} : { bx: Math.sin(back), by: -Math.cos(back) }),
      dev: sprite.resolution * piece.scale,
      ctm: [s, 0, 0, s, center + (piece.x - 50) * unit, center + (piece.y - 50) * unit],
      still: cfg.still, round: 1,
    };
    ctx.save();
    ctx.globalAlpha = 1;
    const landed = drawPlasticCap(ctx, {
      ...cfg, path: piece.path, typeKey: piece.key, color: cue.color, fur,
      shading: cfg.shading === 'fabric' ? 'fabric' : 'plastic',
    }, rig, { base: cue.color }, null, mat);
    if (!landed) {
      ready = false;
      fallback(ctx, piece, rig, cue.color, mat);
    }
    ctx.restore();
  }
  sprite.ready = ready;
}

/** State weights are composited after material rendering: drawPlasticCap owns
    its internal alpha, so passing the transition alpha to it would lose fades. */
export function drawStateCue(ctx: CanvasRenderingContext2D, box: number, pose: Pose, cfg: DrawConfig, base: readonly number[]) {
  const weights = pose.cues;
  if (!weights || !weights.some(weight => weight > 0.001) || !(box > 0)) return;
  const cues = shapes();
  const fabric = cfg.shading === 'fabric';
  const light = radians(cfg.light ?? (fabric ? 295 : 300));
  const back = cfg.backLight === undefined ? undefined : radians(cfg.backLight);
  const mat: Material = {
    shadow: cfg.shadow ?? (fabric ? 1.15 : 0.35),
    highlight: cfg.highlight ?? (fabric ? 1.45 : 1.3),
    spread: cfg.spread ?? (fabric ? 1.6 : 1.55),
    rim: cfg.rim ?? (fabric ? 0.6 : 0.5),
    vivid: cfg.vivid ?? 0,
    front: radians(clamp(cfg.lightFront ?? 32, 0, 85)),
    shine: cfg.shine ?? 0,
    sheen: cfg.sheen ?? 0,
    backSoft: cfg.backSoftness ?? 1,
  };
  /* Short pile leaves the spaces between the arcs and the check's elbow open
     even on the smallest avatar. Dye and lighting do not depend on theme. */
  const fur: FurStyle = {
    length: Math.min(cfg.fur?.length ?? 1, 0.48),
    density: Math.min(cfg.fur?.density ?? 1.6, 1.4),
    fuzz: Math.min(cfg.fur?.fuzz ?? 0.9, 0.35),
    clumps: cfg.fur?.clumps ?? 0.4,
    curl: cfg.fur?.curl ?? 0.7,
    gravity: cfg.fur?.gravity ?? 0.9,
  };
  const size = Math.max(box * 0.34, 13);
  const deviceScale = Math.max(Math.hypot(base[0], base[1]), Math.hypot(base[2], base[3]), 0.1);
  const resolution = clamp(Math.ceil(size * deviceScale / 4) * 4, 24, 192);
  const appearance = [fabric ? 'fabric' : 'plastic', resolution, light, back ?? '', ...Object.values(mat), ...Object.values(fur)].join('|');
  /* Pausing retains the last phase, so the cloud freezes in place. A
     reduced-motion/rest pose supplies phase zero and gets no motion. */
  const phase = pose.cuePhase ?? 0;
  const rest = phase === 0;
  // draw.ts's 1.5× overscan and 0.1× vertical rise, in CSS canvas units.
  const cx = box * (0.75 + 0.45);
  const cy = box * (0.75 + 0.1 - 0.48);
  const alpha = ctx.globalAlpha;
  ctx.save();
  for (let i = 0; i < cues.length; i++) {
    const weight = clamp(weights[i], 0, 1);
    if (!(weight > 0.001)) continue;
    /* Thinking's puffs and cloud have their own cached layers. The pulse
       travels up the trail; every other cue keeps its existing single layer. */
    const layers = i === 0 ? cues[i].pieces.map(piece => ({ color: cues[i].color, pieces: [piece] })) : [cues[i]];
    for (let part = 0; part < layers.length; part++) {
      const key = `${i}:${part}|${appearance}`;
      let sprite = sprites.get(key);
      if (!sprite) {
        sprite = newSprite(resolution) ?? undefined;
        if (!sprite) continue;
        if (sprites.size >= MAX_SPRITES) sprites.delete(sprites.keys().next().value!);
        sprites.set(key, sprite);
      } else {
        // LRU keeps frequently used sizes/materials warm across many avatars.
        sprites.delete(key);
        sprites.set(key, sprite);
      }
      if (!sprite.ready) paint(sprite, layers[part], cfg, fur, mat, light, back);
      let breathe = rest ? 1 : 1 + 0.016 * Math.sin(phase * 1.45 + i * 0.55);
      let float = rest ? 0 : Math.sin(phase * 1.15 + i * 0.55) * box * 0.009;
      let angle = 0;
      let drift = 0;
      let px = 0;
      let py = 0;
      if (i === 0) {
        const piece = layers[part].pieces[0];
        px = (piece.x - 50) * sprite.resolution / 100;
        py = (piece.y - 50) * sprite.resolution / 100;
        const t = phase * Math.PI * 2 / 3.2 - part * 0.65;
        const pulse = (1 - Math.cos(t)) / 2;
        const cloud = part === 2;
        // Puffs only grow: the smallest one must not shrink below a pixel.
        breathe = rest ? 1 : 1 + pulse * (cloud ? 0.055 : 0.28);
        float = rest ? 0 : -pulse * Math.max(1.2, box * 0.06) * (cloud ? 1 : part === 1 ? 0.32 : 0.12);
        angle = rest || !cloud ? 0 : Math.sin(t) * radians(2);
        drift = rest || !cloud ? 0 : Math.sin(t) * box * 0.006;
      }
      const unit = size / sprite.resolution;
      const scale = unit * breathe;
      const a = Math.cos(angle) * scale, b = Math.sin(angle) * scale;
      /* Scale/rock about each piece's own center, preserving the trail's
         anchors instead of making the puffs orbit the entire sprite. */
      const ctm = mulAffine(base, [a, b, -b, a,
        cx + px * unit - a * px + b * py + drift,
        cy + py * unit - b * px - a * py + float]);
      ctx.setTransform(ctm[0], ctm[1], ctm[2], ctm[3], ctm[4], ctm[5]);
      ctx.globalAlpha = alpha * weight;
      ctx.drawImage(sprite.canvas, -sprite.canvas.width / 2, -sprite.canvas.height / 2);
    }
  }
  ctx.restore();
}
