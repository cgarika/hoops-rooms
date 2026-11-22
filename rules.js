/* Flick Hoops' rules, shared by the server and (as a port) the app: what a shot is worth, the fire ball, and the bots' shooting.
   The phone plays the ball itself (HoopsSim in the app); it reports how each shot ended: "swish" (through the net, touching nothing),
   "rim" (in after the rim or the board) or "miss". The server never sees a ball: it counts the points, keeps the streaks, and refuses what a
   person could not have done (shots too close together, shots after the bell, shots from a seat that is not shooting). */
"use strict";

const RESULTS = ["swish", "rim", "miss"];
const SWISH = 3, RIM = 2, FIRE_AFTER = 3, FIRE_BONUS = 1;
/* The phone has the next ball in the cup 0.45 s after a throw and a throw takes a second or more to end, so two results are at least about this far apart (a little less for jitter). */
const MIN_GAP_MS = 300;
const FIRST_SHOT_MS = 1000;  // the first result of a round comes at least this long after the bell (a ball's flight)
const GRACE_MS = 2200;       // a ball already in the air at the bell still counts, for this long

/** Points for one result given the streak before it, and the streak after. */
function score(result, streak) {
  if (result === "miss") return { pts: 0, streak: 0, fire: false };
  const fire = streak >= FIRE_AFTER;
  return { pts: (result === "swish" ? SWISH : RIM) + (fire ? FIRE_BONUS : 0), streak: streak + 1, fire };
}

const LEVELS = ["easy", "normal", "hard"];
/* A bot's shooting: how long between its shots, how often one goes in, and how often a make is clean. */
const SKILL = {
  easy:   { gap: [1900, 1300], make: 0.36, clean: 0.40 },
  normal: { gap: [1500, 1000], make: 0.58, clean: 0.60 },
  hard:   { gap: [1250, 700],  make: 0.80, clean: 0.78 },
};

function rng(seed) {   // mulberry32
  let s = (seed >>> 0) || 1;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The ms until a bot's next shot. */
function botGap(level, rand) { const k = SKILL[level] || SKILL.normal; return k.gap[0] + rand() * k.gap[1]; }
/** How a bot's shot ends. */
function botShot(level, rand) {
  const k = SKILL[level] || SKILL.normal;
  if (rand() >= k.make) return "miss";
  return rand() < k.clean ? "swish" : "rim";
}

module.exports = { RESULTS, SWISH, RIM, FIRE_AFTER, FIRE_BONUS, MIN_GAP_MS, FIRST_SHOT_MS, GRACE_MS, LEVELS, SKILL, score, rng, botGap, botShot };
