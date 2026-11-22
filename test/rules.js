/* Flick Hoops' rules (rules.js): the points, the fire ball, the bots' odds. */
"use strict";
const assert = require("assert");
const R = require("../rules");
let n = 0; const ok = (m) => { n++; console.log("ok  " + m); };

assert.deepStrictEqual(R.score("swish", 0), { pts: 3, streak: 1, fire: false }); ok("a swish is 3");
assert.deepStrictEqual(R.score("rim", 0), { pts: 2, streak: 1, fire: false }); ok("a rim-in is 2");
assert.deepStrictEqual(R.score("miss", 5), { pts: 0, streak: 0, fire: false }); ok("a miss is 0 and ends the streak");
let st = 0, total = 0;
for (let i = 0; i < 3; i++) { const r = R.score("swish", st); st = r.streak; total += r.pts; }
assert.strictEqual(total, 9); ok("three in a row are plain");
const f = R.score("swish", st); assert.deepStrictEqual(f, { pts: 4, streak: 4, fire: true }); ok("the fourth, after three makes, is a fire ball: +1");
assert.strictEqual(R.score("rim", 7).pts, 3); ok("a fire rim-in is 3");

const rand = R.rng(42), rand2 = R.rng(42);
for (let i = 0; i < 20; i++) assert.strictEqual(rand(), rand2());
ok("the seeded random is repeatable");
for (const lvl of R.LEVELS) {
  const r = R.rng(7); let make = 0, clean = 0; const N = 20000;
  for (let i = 0; i < N; i++) { const s = R.botShot(lvl, r); if (s !== "miss") make++; if (s === "swish") clean++; }
  assert(Math.abs(make / N - R.SKILL[lvl].make) < 0.02, lvl + " make rate " + make / N);
  assert(Math.abs(clean / make - R.SKILL[lvl].clean) < 0.02, lvl + " clean share");
}
ok("each bot level shoots to its odds");
assert(R.SKILL.easy.make < R.SKILL.normal.make && R.SKILL.normal.make < R.SKILL.hard.make); ok("harder bots make more");
const g = R.rng(3); for (const lvl of R.LEVELS) { const t = R.botGap(lvl, g); assert(t >= R.SKILL[lvl].gap[0] && t <= R.SKILL[lvl].gap[0] + R.SKILL[lvl].gap[1]); }
assert(R.SKILL.hard.gap[0] < R.SKILL.easy.gap[0]); ok("a bot's pace is by its level");
console.log(n + " rules checks passed");
