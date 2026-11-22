/* Gear step 5 (2026-11-21): Flick Hoops' gear. The table's slots, clamps, the effects (ball arc, shoes' extra time, wristband streak bonus), no gear = the base, the host's switch, bands, bots.
   Port TEST_PORT_GEAR (default 5643; never 3111-3131). */
"use strict";
const os = require("os"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const G = require("../gear");
const PORT = Number(process.env.TEST_PORT_GEAR || 5643);
if ((PORT >= 3111 && PORT <= 3131) || PORT === 5702 || PORT === 5930) { console.error("refusing " + PORT); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
const check = (ok, what, extra) => { if (ok) passed++; else failed++; console.log((ok ? "PASS " : "FAIL ") + what + (!ok && extra !== undefined ? "  " + JSON.stringify(extra) : "")); };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return false; };
const MAX = { hball: { item: "hball:dragon", level: 12 }, hshoes: { item: "hshoes:sapphire", level: 10 }, band: { item: "band:pearl", level: 8 } };
function mk(name) {
  const s = io("http://127.0.0.1:" + PORT, { path: "/socket.io", transports: ["websocket"], reconnection: false, forceNew: true });
  const c = { s, room: null, joined: null, id: "g_" + name };
  s.on("state", (d) => { c.room = d.room; });
  s.on("joined", (j) => { c.joined = j; });
  c.create = (gear) => { s.emit("create", { name, playerId: c.id, gear }); return until(() => c.joined); };
  c.join = (code, gear) => { s.emit("join", { code, name, playerId: c.id, gear }); return until(() => c.joined); };
  return c;
}
(async () => {
  console.log("\nthe table");
  check(JSON.stringify(G.slotsOf("hoops")) === '["hball","hshoes","band"]' && JSON.stringify(G.T.games.hoops.stats) === '["arc","time","streak"]', "Flick Hoops: ball, shoes, wristband; arc, time, streak");
  for (const slot of G.slotsOf("hoops")) {
    const items = Object.keys(G.T.items).filter((k) => G.T.items[k].slot === slot);
    check(items.length === 4 && ["common", "rare", "epic", "legendary"].every((x, i) => G.rarityOf(items[i]) === x), `${slot}: COMMON, RARE, EPIC, LEGENDARY`, items);
  }
  const g = G.clean("hoops", MAX);
  check(g.score === 30 && g.stats.arc === 10 && g.stats.time === 9 && g.stats.streak === 7, "clean: levels and stats", g);
  check(G.clean("hoops", { hball: { item: "hball:classic", level: 99 } }).slots.hball.level === 6 && G.clean("hoops", null) === null, "caps and no gear");
  console.log("\nthe effects, small and clamped");
  const e0 = G.hoopsEffects(null), e10 = G.hoopsEffects({ arc: 99, time: 99, streak: 99 });
  check(e0.arc === 0 && e0.extraMs === 0 && e0.streakPts === 0, "no gear: the base", e0);
  check(e10.arc === 0.4 && e10.extraMs === 5000 && e10.streakPts === 10, "a stat over 10 is held at 10", e10);
  check(G.streakBonus(null, 5) === 0 && G.streakBonus(e10, 0) === 0 && G.streakBonus(e10, 1) === 2 && G.streakBonus(G.hoopsEffects({ streak: 3 }), 4) === 0 && G.streakBonus(G.hoopsEffects({ streak: 4 }), 1) === 1, "the streak bonus: none at the base, none on the first basket, +1 per four points after it");
  console.log("\nthe server");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "hoops-gear-"));
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT: String(PORT), TEST_HOOKS: "1", RANK_DIR: data, STATS_DIR: data, DATA_DIR: data, COUNTDOWN_MS: "250", MS_PER_SECOND: "200", SUDDEN_MS: "2500" }), stdio: "ignore" });
  const cl = []; const m = (n) => { const c = mk(n); cl.push(c); return c; };
  try {
    await sleep(800);
    const a = m("Ann"); await a.create(MAX); await until(() => a.room);
    check(a.room.players[0].gear.score === 30 && a.room.players[0].gear.stats.arc === 10 && a.room.gearOn === true, "the room shows the clamped gear, on by default", a.room.players[0].gear);
    const b = m("Bob"); await b.join(a.joined.code, { hball: { item: "hball:classic", level: 99 }, hshoes: { item: "hshoes:classic", level: 1 }, band: { item: "band:classic", level: 1 } });
    await until(() => a.room.players.length === 2);
    check(a.room.players[1].gear.levels.hball === 6, "a joiner's level is clamped to its rarity");
    b.s.emit("settings", { gear: false }); await sleep(150);
    check(a.room.gearOn === true, "only the host may switch gear");
    a.s.emit("settings", { gear: false }); await until(() => a.room.gearOn === false);
    check(a.room.players[0].gear.stats.streak === 0, "off: the stats shown are the base");
    a.s.emit("settings", { gear: true }); await until(() => a.room.gearOn === true);
    a.s.emit("gear", { hball: { item: "hball:sapphire", level: 7 } }); await until(() => a.room.players[0].gear.items.hball === "hball:sapphire");
    check(a.room.players[0].gear.levels.hball === 7, "a lobby gear event is cleaned and applied");
    // play: the wristband pays more on the second basket in a row; the plain seat pays the base
    a.s.emit("gear", { hball: { item: "hball:dragon", level: 12 }, hshoes: { item: "hshoes:sapphire", level: 4 }, band: { item: "band:sapphire", level: 9 } }); await sleep(100);
    a.s.emit("start", {});
    await until(() => a.room.phase === "play");
    const bell = a.room.phaseEndsAt;
    await sleep(1100);
    a.s.emit("shot", { r: "swish" }); b.s.emit("shot", { r: "swish" }); await sleep(420);
    a.s.emit("shot", { r: "swish" }); b.s.emit("shot", { r: "swish" }); await sleep(250);
    check(a.room.players[0].score === 3 + 3 + 2 && a.room.players[1].score === 6, "two swishes: 8 with the wristband (streak points 8, +2 on the second), 6 at the base", [a.room.players[0].score, a.room.players[1].score]);
    // the shoes: Level 4 shoes = 3 points = 1.5 s past the bell for that seat only
    await sleep(Math.max(0, bell + 3000 - Date.now()));
    const before = a.room.players[0].shots;
    a.s.emit("shot", { r: "rim" }); b.s.emit("shot", { r: "rim" }); await sleep(300);
    check(a.room.players[0].shots === before + 1 && a.room.phase === "play", "3 s past the bell the geared seat's shot still counts and the round has not been settled", [a.room.players[0].shots, before, a.room.phase]);
    check(a.room.players[1].shots === 2, "the plain seat's late shot is refused", a.room.players[1].shots);
    await until(() => a.room.phase !== "play", 6000);
    // bots
    const c = m("Cat"); await c.create(MAX); await until(() => c.room);
    c.s.emit("addBot", { level: "easy" }); await until(() => c.room.players.length === 2);
    check(c.room.players[1].gear && c.room.players[1].gear.score === 30, "a bot wears the humans' mean gear score");
    check(G.bandOk(30, 3) === false && G.bandOk(10, 14) === true, "quick play matches within 6 gear score");
  } finally { for (const x of cl) x.s.close(); srv.kill(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
