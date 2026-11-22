/* The room flow over real sockets, against a server this script starts (TEST_PORT, default 5593; never 3111-3130): create and join, settings, bots, start, the phases
   (countdown, play, bell, over), shots counted (swish 3, rim 2, the fire ball), the sanity refusals (too soon, a seat not shooting, after the bell), sudden death,
   forfeit on leave, rematch, pass-and-play turns on one phone. */
"use strict";
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const PORT = Number(process.env.TEST_PORT || 5593);
if (PORT >= 3111 && PORT <= 3130) { console.error("refusing " + PORT); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (fn, what, ms = 12000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timed out waiting for " + what)); setTimeout(tick, 5); }; tick(); });
function client(name) {
  const s = io("http://127.0.0.1:" + PORT, { path: "/socket.io", transports: ["websocket"] });
  const c = { s, room: null, mySeat: -1, errs: [], joined: null };
  s.on("state", (d) => { c.room = d.room; c.mySeat = d.mySeat; });
  s.on("err", (m, o) => c.errs.push(o && o.code));
  s.on("joined", (j) => { c.joined = j; });
  c.create = () => { s.emit("create", { name, playerId: "p_" + name }); return wait(() => c.joined, "joined"); };
  c.join = (code) => { s.emit("join", { code, name, playerId: "p_" + name }); return wait(() => c.joined, "joined"); };
  return c;
}
let n = 0;
const ok = (m) => { n++; console.log("ok  " + m); };

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "hoops-flow-"));
  // a round is 30 s x MS_PER_SECOND = 6 s here; the grace after the bell is 2.2 s
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), TEST_HOOKS: "1", RANK_DIR: data, STATS_DIR: data, DATA_DIR: data, COUNTDOWN_MS: "250", MS_PER_SECOND: "200", SUDDEN_MS: "2500" }, stdio: "ignore" });
  const clients = [];
  const mk = (n_) => { const c = client(n_); clients.push(c); return c; };
  try {
    await sleep(700);
    const a = mk("Ann");
    await a.create();
    assert(/^[A-HJKMNPRTWXYZ]{6}$/.test(a.joined.code)); ok("a room is made with a letters-only code");
    a.s.emit("settings", { seconds: 30, court: "candy" });
    await wait(() => a.room && a.room.opts.seconds === 30, "settings");
    assert.strictEqual(a.room.opts.court, "orbit"); ok("a Plus court is refused to a host without Plus");
    a.s.emit("settings", { seconds: 99 }); await sleep(100); assert.strictEqual(a.room.opts.seconds, 30); ok("a length outside the list is ignored");
    a.s.emit("addBot", { level: "easy" }); a.s.emit("addBot", { level: "hard" });
    await wait(() => a.room.players.length === 3 && a.room.players[2].level === "hard", "bots");
    a.s.emit("start", {});
    await wait(() => a.room.phase === "countdown", "countdown");
    await wait(() => a.room.phase === "play", "play"); ok("start: countdown then play");
    assert(a.room.clockMs > 4000 && a.room.clockMs <= 6000, "clock " + a.room.clockMs);
    assert(a.room.players.every((p) => p.shooting)); ok("everyone is shooting at once");
    a.s.emit("shot", { r: "swish" }); await sleep(150); assert.strictEqual(a.room.players[0].score, 0); ok("no result in the first second of a round");
    await sleep(1150);   // a ball takes a second to get there: a result any sooner is refused
    a.s.emit("shot", { r: "swish" });
    await wait(() => a.room.players[0].score === 3, "swish"); ok("a swish scores 3");
    a.s.emit("shot", { r: "swish" }); await sleep(100);
    assert.strictEqual(a.room.players[0].score, 3); ok("a second shot too soon is refused");
    await sleep(380); a.s.emit("shot", { r: "rim" });
    await wait(() => a.room.players[0].score === 5, "rim"); ok("a rim-in scores 2");
    await sleep(380); a.s.emit("shot", { r: "swish" });
    await wait(() => a.room.players[0].score === 8 && a.room.players[0].fire, "fire"); ok("three makes light the fire ball");
    await sleep(380); a.s.emit("shot", { r: "swish" });
    await wait(() => a.room.players[0].score === 12, "fire swish"); ok("a fire ball is worth one more");
    await sleep(380); a.s.emit("shot", { r: "miss" });
    await wait(() => !a.room.players[0].fire && a.room.players[0].streak === 0, "miss"); ok("a miss puts the fire out");
    a.s.emit("shot", { r: "bogus" }); await sleep(900); a.s.emit("shot", { r: 7 }); await sleep(100); ok("a bad result is ignored");
    await wait(() => a.room.players[1].shots > 0 || a.room.players[2].shots > 0, "bots shoot", 8000); ok("bots shoot by themselves");
    await wait(() => a.room.status === "over", "over", 15000);
    assert(a.room.winners.length === 1 && a.room.winner === a.room.winners[0]); ok("the bell ends the round with one winner");
    const top = Math.max(...a.room.players.map((p) => p.score)); assert.strictEqual(a.room.players[a.room.winner].score, top); ok("the winner has the most");
    a.s.emit("shot", { r: "swish" }); await sleep(100); assert(a.room.players[0].score <= 12); ok("no shot counts after the end");
    a.s.emit("rematch", {});
    await wait(() => a.room.status === "playing" && a.room.players[0].score === 0, "rematch"); ok("rematch starts fresh scores");
    a.s.emit("leave", {}); await sleep(100);

    // sudden death: two tied at the bell shoot again, alone
    const x = mk("Xan"), y = mk("Yul"), z = mk("Zed");
    await x.create(); await y.join(x.joined.code); await z.join(x.joined.code);
    x.s.emit("start", {});
    await wait(() => x.room.phase === "play", "play");
    x.s.emit("testSet", { scores: [5, 5, 2] });
    await wait(() => x.room.players[1].score === 5, "set");
    await wait(() => x.room.phase === "countdown" && x.room.golden, "sudden death", 15000);
    await wait(() => x.room.phase === "play", "sudden play");
    assert.deepStrictEqual(x.room.players.map((p) => p.shooting), [true, true, false]); ok("a tie at the bell: only the tied shoot, a short sudden-death round");
    await sleep(1150); z.s.emit("shot", { r: "swish" }); await sleep(150); assert.strictEqual(x.room.players[2].score, 2); ok("someone out of it cannot score");
    x.s.emit("shot", { r: "swish" });
    await wait(() => x.room.players[0].score === 8, "sd swish");
    await wait(() => x.room.status === "over", "over", 12000);
    assert.strictEqual(x.room.winner, 0); ok("sudden death goes to the better of the tied");
    z.s.emit("leave", {}); y.s.emit("leave", {}); x.s.emit("leave", {});

    // leaving mid-round: the last one standing wins
    const h = mk("Hal"), g = mk("Gus");
    await h.create(); await g.join(h.joined.code);
    const late = mk("Late"); h.s.emit("start", {});
    await wait(() => h.room.phase === "play", "play");
    late.s.emit("join", { code: h.joined.code, name: "Late", playerId: "p_late" });
    await wait(() => late.errs.length, "refused"); assert.strictEqual(late.errs[0], "started"); ok("a started round refuses a newcomer");
    g.s.emit("leave", {});
    await wait(() => h.room.status === "over", "forfeit"); assert.strictEqual(h.room.winner, 0); ok("everyone else leaving ends it");

    // a Plus host picks a Plus court
    const pl = mk("Pluto"); pl.s.emit("create", { name: "Pluto", playerId: "p_Pluto", plus: true });
    await wait(() => pl.room, "plus room");
    pl.s.emit("settings", { court: "bath" }); await sleep(150);
    if (pl.room.players[0].plus) { assert.strictEqual(pl.room.opts.court, "bath"); ok("a Plus host picks the Bathtub Splash League"); } else { ok("(Plus claims are checked against the wallet's keys here: the pick stays the Orbital Toy Station)"); }

    // pass-and-play: one phone, turns in order, Ready between them
    const l = mk("Lia");
    l.s.emit("create", { name: "Lia", playerId: "p_Lia2", local: true });
    await wait(() => l.room && l.room.passplay, "local room"); await sleep(50);
    l.s.emit("addLocal", { name: "Pal" }); l.s.emit("addLocal", { name: "Sam" });
    await wait(() => l.room.players.length === 3, "local seats");
    assert.deepStrictEqual(l.room.passplay.seats, [0, 1, 2]);
    l.s.emit("start", {});
    await wait(() => l.room.phase === "handover" && l.room.turnSeat === 0, "handover to the first");
    ok("pass-and-play waits for the first shooter's Ready");
    l.s.emit("shot", { r: "swish", as: 0 }); await sleep(100); assert.strictEqual(l.room.players[0].score, 0); ok("no shots before Ready");
    l.s.emit("ready", {});
    await wait(() => l.room.phase === "play" && l.room.turnSeat === 0, "turn 0");
    await sleep(1150);
    l.s.emit("shot", { r: "swish", as: 1 }); await sleep(100); assert.strictEqual(l.room.players[1].score, 0); ok("only the seat in turn shoots");
    l.s.emit("shot", { r: "swish", as: 0 });
    await wait(() => l.room.players[0].score === 3, "turn 0 shot");
    await wait(() => l.room.phase === "handover" && l.room.turnSeat === 1, "next shooter", 15000); ok("after the bell the phone is passed to the next");
    l.s.emit("ready", {}); await wait(() => l.room.phase === "play" && l.room.turnSeat === 1, "turn 1");
    await sleep(1150); l.s.emit("shot", { r: "rim", as: 1 }); await wait(() => l.room.players[1].score === 2, "turn 1 shot");
    await wait(() => l.room.phase === "handover" && l.room.turnSeat === 2, "third", 15000);
    l.s.emit("ready", {}); await wait(() => l.room.phase === "play" && l.room.turnSeat === 2, "turn 2");
    await wait(() => l.room.status === "over", "over", 15000);
    assert.strictEqual(l.room.winner, 0); ok("after the last turn the best score wins");
    const lg = mk("Lag"); lg.s.emit("shot", { r: "swish" }); lg.s.emit("shot", "nonsense"); lg.s.emit("shot", { r: {} }); await sleep(100);
    ok("malformed input is ignored");
    console.log(n + " flow checks passed");
  } catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
  for (const c of clients) c.s.close();
  srv.kill("SIGTERM");
  fs.rmSync(data, { recursive: true, force: true });
})();
