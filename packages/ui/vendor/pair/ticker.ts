// @ts-nocheck: vendored from bot-avatars 0.2.2 (MIT, see LICENSE and README.md here), kept as upstream wrote it;
// it predates this repo's noUncheckedIndexedAccess, so it isn't type-checked or linted here.
/* One animation frame loop for every avatar on the page. Subscribers get
   the seconds since their last tick; the loop stops while the tab is
   hidden and while nobody is subscribed. */

type Tick = (dt: number) => void;

/** The last pointer position on the page, NaN while it is away. */
export const pointer = { x: NaN, y: NaN };

const subs = new Set<Tick>();
let raf = 0;
let last = 0;

/* OpenDash: at most 30 draws a second. Each draw costs the same at any rate, so on a 120 Hz screen this is a quarter
   of the work; the animation runs on real time, so it moves at the same speed, in fewer steps. */
const MIN_STEP = 1 / 30 - 0.002;

function frame(now: number) {
  raf = 0;
  const since = last ? (now - last) / 1000 : 0;
  if (last && since < MIN_STEP) {
    if (subs.size) raf = requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min(0.1, since);
  last = now;
  subs.forEach((fn) => fn(dt));
  if (subs.size) raf = requestAnimationFrame(frame);
}

function start() {
  if (raf || typeof document === 'undefined' || document.hidden) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

let wired = false;
function wire() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.x = NaN; pointer.y = NaN; });
  window.addEventListener('blur', () => { pointer.x = NaN; pointer.y = NaN; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else if (subs.size) start();
  });
}

export function subscribe(fn: Tick): () => void {
  wire();
  subs.add(fn);
  start();
  return () => {
    subs.delete(fn);
    if (!subs.size && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
