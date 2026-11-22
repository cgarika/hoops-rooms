/* Flick Hoops Rooms: self-hosted flick-the-ball basketball for two to four (GameNest's `hoops`, dev port 3130).

   Same shape as the other GameNest game servers: rooms behind a 6-letter code, bots fill seats. What is different is that everyone shoots at
   the same time (or, in pass-and-play, one after another on one phone) and the PHONE plays the ball: the server keeps the clock and the scores,
   counts each reported shot with rules.js (swish 3, rim-in 2, a fire ball after three makes in a row), and refuses what a person could not do
   (shots too close together, after the bell, from a seat that is not shooting). README.md has the wire. */

const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const Rules = require("./rules");
const Reactions = require("./reactions");   // the cartoon stickers (2026-10-15)
const Voice = require("./voice");   // voice chat in private rooms, EOS (2026-11-18; the file every server shares)
const Played = require("./friendsplayed");   // Friends: "last played with" when a game ends (2026-11-19; the file every server shares)
const Quick = require("./quickmatch");   // quick play and ranked (2026-10-24)
const PassPlay = require("./passplay");   // several players on one phone (2026-11-18)
const Plus = require("./plus");   // GameNest Plus: the room's flag and each player's look (2026-10-16)
const Gear = require("./gear");   // gear: the one table and its effects (gear step 5, 2026-11-21)
const Moderation = require("./moderation");   // what players type, kept friendly (2026-10-18)

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const PING = {};
if (Number(process.env.PING_INTERVAL_MS) > 0) PING.pingInterval = Number(process.env.PING_INTERVAL_MS);
if (Number(process.env.PING_TIMEOUT_MS) > 0) PING.pingTimeout = Number(process.env.PING_TIMEOUT_MS);
const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true }, ...PING });

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const TEST_HOOKS = process.env.TEST_HOOKS === "1";
/* The clocks, in ms. SIM_SPEED > 1 runs the clocks faster than real time (tests only). */
const SIM_SPEED = Math.max(0.1, Number(process.env.SIM_SPEED || 1));
const COUNTDOWN_MS = Math.max(50, Number(process.env.COUNTDOWN_MS || 3000));   // 3, 2, 1 before the bell
const SUDDEN_MS = Math.max(200, Number(process.env.SUDDEN_MS || 10000));       // a tie-break round: the tied players only
const MS_PER_SECOND = Math.max(1, Number(process.env.MS_PER_SECOND || 1000));  // a round's seconds, in ms (tests shorten it)
const MAX_SUDDEN = 3;
const ROOM_IDLE_MS = 2 * 3600e3;
const NAME_GRAPHEMES = 18;             // one cap on every GameNest server, in whole characters
const CAPS = [];
const SECONDS = [30, 45, 60];
const COURTS = ["orbit", "candy", "bath"];   // the Orbital Toy Station is everyone's; the Candy Counter and the Bathtub Splash League are GameNest Plus's
const LEVELS = Rules.LEVELS;

const BOT_NAMES = { easy: "Pebble", normal: "Comet", hard: "Nova" };
const AVATARS = ["\u{1F60E}", "\u{1F913}", "\u{1F451}", "\u{1F42F}", "\u{1F43C}", "\u{1F98A}"];
const CODE_ALPHABET = "ABCDEFGHJKMNPRTWXYZ";

const rooms = new Map();
app.get("/internal/roster/:code", Plus.rosterHandler((code) => rooms.get(code)));   // who is at a table, for the wallet's Treat the room (404 without GN_INTERNAL_SECRET)
/* GameNest Plus: a player says on create and join that they own Plus; a room
   whose host owns it is a Plus room, and every client shows its extras.
   The client's word is taken for now (checking Apple's receipt is a later step). */
function stampPlus(code, socket, said) {
  const room = rooms.get(code);
  const p = room && socket && socket.data && room.players.find((q) => q.id === socket.data.playerId);
  if (p) { Plus.stampFor(p, said, socket); Plus.dedupe(room, p); }
}
const roomSockets = new Map();

const newId = () => crypto.randomBytes(8).toString("hex");
function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }

/* A payload is an object or nothing. `42["create",null]` used to throw inside the
   handler and take the whole process, and every room in it, down. */
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});

/* ---------- text ---------- */

/* A string, whatever arrives: a string, a number or a boolean as itself, anything else (an object with a hostile
   toString, an array) as nothing. String() on `{toString: 1}` throws. */
const text = (s) => (typeof s === "string" ? s : typeof s === "number" || typeof s === "boolean" ? String(s) : "");

const SEGMENTER = typeof Intl === "object" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/* At most `max` whole characters (grapheme clusters: an emoji with its skin tone, a flag,
   a letter and its accents) in at most `units` UTF-16 units, never cutting one in half. */
function graphemes(s, max, units) {
  s = text(s);
  if (s.length > 4 * units) s = s.slice(0, 4 * units);    // bounds the work on a 100 KB name
  let out = "", n = 0;
  const parts = SEGMENTER ? Array.from(SEGMENTER.segment(s), (x) => x.segment) : Array.from(s);
  for (const g of parts) {
    if (n >= max || out.length + g.length > units) break;
    out += g; n++;
  }
  return out;
}
const strip = (s) => text(s).replace(/[<>&"'`\u0000-\u001f\u007f]/g, "").trim();
const cleanName = (s) => { const c = graphemes(strip(s), NAME_GRAPHEMES, 96).trim(); return c ? Moderation.name(c) : c; };   // a bad name is "Player"
const cleanAvatar = (s) => graphemes(strip(s), 1, 16);
const cleanId = (s) => (typeof s === "string" && s.length > 0 && s.length <= 128 ? s : null);
const cleanCaps = (c) => (Array.isArray(c) ? CAPS.filter((k) => c.includes(k)) : []);

/* A refusal: today's words for today's app, and a code a newer one can switch on without
   reading English. The code rides as a second argument, which an app that reads only the
   first never sees. Codes: not_found, started, full, name, nobody. */
function refuse(socket, op, code, message) { socket.emit("err", message, { code, op }); }

/* ---------- chat, voice and push ----------

   Copied from the other room servers rather than reinvented, because a client that already
   speaks them must not find another that is subtly different. */

const CHAT_KEEP = 60;
const CHAT_COOLDOWN_MS = 800;
const STICKERS = ["lol","cry","fire","dice","snail","devil","pray","skull","party","angry","pinch","run"];
const cleanChat = (n) => graphemes(text(n).replace(/[<>&"'`]/g, "").trim(), 140, 140);

const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TITLE = "Flick Hoops";

function pushTo(p, body, data, collapse) {
  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
  // only someone who cannot see the screen
  if (!(p.away || !p.connected)) return;
  const now = Date.now();
  if (p._lastPush && now - p._lastPush < 4000) return;
  p._lastPush = now;
  fetch(PUSH_URL + "/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }),
  }).catch(() => {});
}



/* ---------- room shape ---------- */

function newRoom(code, host) {
  return {
    v: 1, code, host, status: "lobby",
    gearOn: true,                  // the host's gear switch (private rooms); quick and ranked rooms always play with gear
    players: [],
    opts: { seconds: 45, court: "orbit" },     // the host's choices
    phase: "lobby",                // lobby, countdown, play, handover (pass-and-play: waiting for the next shooter's Ready), over
    phaseEndsAt: null,             // server ms: the countdown's end, or the bell
    playMs: 0,                     // this round's length
    graceUntil: 0,                 // after the bell: balls already in the air still count until this
    seed: 1,                       // the hoop's path (the phone derives it from this: the same for every player, a new one each round)
    round: 0,
    sudden: 0,                     // sudden-death rounds played so far
    active: null,                  // the seats shooting now (everyone, or only the tied in sudden death); in pass-and-play, the one in turn
    queue: [],                     // pass-and-play: the seats still to take their turn
    turnSeat: -1,
    golden: false,
    winner: null, winners: [],
    log: "Share the code with your friends.",
    chat: [],
    touched: Date.now(),
  };
}

/* ---------- gear (gear.js, gear step 5) ---------- */
/* A seat's gear does its work when the room's gear switch is on and a person plays the seat. A bot's gear (and a person a bot plays for) is only the score it shows: it plays the base game. */
const gearOf = (room, p) => (room.gearOn !== false && p && !p.bot && !p.botControlled && !p.left && p.gear ? Gear.hoopsEffects(p.gear.stats) : null);
const gearView = (room, p) => (p && p.gear ? { score: p.gear.score, items: Object.fromEntries(Object.entries(p.gear.slots).map(([k, v]) => [k, v.item])), levels: Object.fromEntries(Object.entries(p.gear.slots).map(([k, v]) => [k, v.level])), stats: room.gearOn !== false ? p.gear.stats : { arc: 0, time: 0, streak: 0 } } : null);
/* The bots' gear fits the humans' band: the mean of the humans' gear scores, and none when no human sent any (old apps: everyone at the base). */
function botGearFor(room) {
  const hs = room.players.filter((p) => !p.bot);
  if (!hs.length || !hs.some((p) => p.gear)) return null;
  return Gear.botGear("hoops", Math.round(hs.reduce((n, p) => n + Gear.scoreFor(p.gear, "hoops"), 0) / hs.length));
}
function gearBots(room) { for (const p of room.players) if (p.bot) p.gear = botGearFor(room); }

/* The longest extra shot time a seat shooting now has from its shoes (ms): the round is not settled before it. */
function maxExtraMs(room) { let m = 0; for (const s of room.active || []) { const fx = gearOf(room, room.players[s]); if (fx && fx.extraMs > m) m = fx.extraMs; } return m; }

function publicRoom(room) {
  const now = Date.now();
  return {
    code: room.code, status: room.status,
    players: room.players.map((p) => ({
      name: p.name, avatar: p.avatar, ...Plus.seat(p), bot: !!p.bot, ...(p.bot ? { level: p.level } : {}), gear: gearView(room, p),
      left: p.left, connected: p.connected, local: !!p.local,
      score: p.score | 0, streak: p.streak | 0, fire: !!p.fire, shots: p.shots | 0, makes: p.makes | 0, swishes: p.swishes | 0,
      shooting: !!(room.active && room.active.includes(room.players.indexOf(p))),
    })),
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    gearOn: room.gearOn !== false,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    opts: { seconds: room.opts.seconds, court: room.opts.court },
    phase: room.phase, phaseEndsAt: room.phaseEndsAt,
    playMs: room.playMs, seed: room.seed, round: room.round, golden: room.golden, turnSeat: room.turnSeat,
    clockMs: clockLeft(room),      // play time left, as of serverNow (it runs down only in the play phase)
    winner: room.winner, winners: room.winners,
    log: room.log, chat: room.chat, voice: room.voice ? Array.from(room.voice) : [],
    serverNow: now,
    v: room.v,
    ...Reactions.view(room),
    ...Quick.view(room),
    ...Voice.view(room),   // voice chat (2026-11-18): gnVoice { on, peers }
    ...Played.view(room, "hoops"),   // Friends (2026-11-19): reports a finished game once; adds no field
    ...PassPlay.view(room),   // pass-and-play: which seats this phone plays
  };
}

function sendState(code) {
  const room = rooms.get(code), sockets = roomSockets.get(code);
  if (!room || !sockets) return;
  const pub = publicRoom(room);
  for (const s of sockets) {
    const mySeat = room.players.findIndex((p) => p.id === s.data.playerId);
    s.emit("state", { room: Object.assign({}, pub), mySeat });
  }
}
function bump(room) { room.v++; room.touched = Date.now(); sendState(room.code); }

/* ---------- play ---------- */

const setPhase = (room, phase, ms) => { room.phase = phase; room.phaseEndsAt = ms == null ? null : Date.now() + ms / SIM_SPEED; };
function clockLeft(room) {
  if (room.phase === "play" && room.phaseEndsAt) return Math.max(0, Math.round((room.phaseEndsAt - Date.now()) * SIM_SPEED));
  return room.phase === "countdown" || room.phase === "handover" ? room.playMs : 0;
}
const isPass = (room) => PassPlay.isLocal(room);
const shooters = (room) => room.players.map((p, i) => (p.left ? -1 : i)).filter((i) => i >= 0);

function resetScores(room) {
  for (const p of room.players) { p.score = 0; p.streak = 0; p.fire = false; p.shots = 0; p.makes = 0; p.swishes = 0; p.lastShotAt = 0; p.lastScoreAt = 0; p.lastScoreRound = -1; p.roundShots = 0; p.graceShots = 0; }
}

function startMatch(room) {
  room.status = "playing";
  room.round = (room.round || 0) + 1;
  room.sudden = 0; room.golden = false; room.winner = null; room.winners = [];
  room.seed = (crypto.randomInt(1, 2 ** 31)) >>> 0;
  resetScores(room);
  room.rand = Rules.rng(room.seed ^ 0x9E3779B9);
  room.log = `Get ready! ${room.opts.seconds} seconds, everyone shoots.`;
  const all = shooters(room);
  room.turnReady = false; room.contenders = null;
  if (isPass(room)) { room.queue = all.slice(1); beginRound(room, [all[0]], room.opts.seconds * MS_PER_SECOND); }
  else { room.queue = []; beginRound(room, all, room.opts.seconds * MS_PER_SECOND); }
}

/* One round for the seats in `seats` (online: all at once; pass-and-play: this is called per turn with one seat). */
function beginRound(room, seats, ms) {
  room.active = seats.slice();
  room.playMs = ms;
  room.roundId = (room.roundId || 0) + 1;
  room.graceUntil = 0;
  const now = Date.now();
  for (const p of room.players) { p.streak = p.streak | 0; p.nextBotAt = 0; }
  if (isPass(room) && !room.turnReady) {
    room.turnSeat = seats[0];
    room.log = `Pass the phone to ${room.players[seats[0]].name}.`;
    return setPhase(room, "handover", null);
  }
  room.turnReady = false;
  room.turnSeat = isPass(room) ? seats[0] : -1;
  for (const s of seats) { room.players[s].streak = 0; room.players[s].fire = false; }
  setPhase(room, "countdown", COUNTDOWN_MS);
  void now;
}

function beginPlay(room) {
  setPhase(room, "play", room.playMs);
  room.log = room.golden ? "Sudden death!" : "Shoot!";
  const now = Date.now();
  room.roundStartedAt = now;
  for (const s of room.active) {
    const p = room.players[s];
    if (!p) continue;
    p.roundShots = 0; p.graceShots = 0;
    p.lastShotAt = now + Rules.FIRST_SHOT_MS / SIM_SPEED - Rules.MIN_GAP_MS / SIM_SPEED;   // a ball takes a second to get there: no result in the first moments
    if (p.bot) p.nextBotAt = now + Rules.botGap(p.level, room.rand) / SIM_SPEED;
  }
  bump(room);
}

function bestSeats(room, among) {
  let top = -1, out = [];
  for (const s of among) { const sc = room.players[s].score; if (sc > top) { top = sc; out = [s]; } else if (sc === top) out.push(s); }
  return out;
}

function finishMatch(room, winners, log) {
  room.status = "over";
  room.phase = "over"; room.phaseEndsAt = null; room.active = null; room.turnSeat = -1;
  room.winners = winners; room.winner = winners.length ? winners[0] : null;
  room.log = log;
  winners.forEach((w) => Reactions.event(room, w, "win", bump, 0));
  room.players.forEach((p, i) => { if (!winners.includes(i) && !p.left) Reactions.event(room, i, "bad", bump, 0); });
}

/* The bell: the round's last balls count for GRACE_MS, then the round is settled. */
function endRound(room) {
  const all = shooters(room);
  if (isPass(room)) room.queue = room.queue.filter((i) => room.players[i] && !room.players[i].left);
  if (isPass(room) && room.queue.length) {
    const seat = room.queue.shift();
    room.turnReady = false;
    return beginRound(room, [seat], room.golden ? SUDDEN_MS : room.opts.seconds * MS_PER_SECOND), bump(room);
  }
  let pool = room.golden && room.contenders ? room.contenders.filter((i) => room.players[i] && !room.players[i].left) : all;
  if (!pool.length) pool = all;
  if (!pool.length) { forgetRoom(room); return; }
  const tied = bestSeats(room, pool);
  if (tied.length > 1 && room.sudden < MAX_SUDDEN) {
    room.golden = true; room.sudden++; room.contenders = tied.slice();
    room.log = `Level at ${room.players[tied[0]].score}. Sudden death!`;
    if (isPass(room)) { room.queue = tied.slice(1); room.turnReady = false; beginRound(room, [tied[0]], SUDDEN_MS); }
    else { beginRound(room, tied, SUDDEN_MS); }
    return bump(room);
  }
  let winners = tied;
  if (winners.length > 1) {   // still level after the tie-breaks: the one who got there first
    const key = (i) => (room.players[i].lastScoreRound === room.roundId ? room.players[i].lastScoreAt : Infinity);   // time into the last round, so a later turn of a pass-and-play game is not at a disadvantage
    winners = [winners.slice().sort((a, b) => key(a) - key(b) || a - b)[0]];
  }
  const w = winners[0];
  finishMatch(room, winners, `${room.players[w].name} wins with ${room.players[w].score}!`);
  bump(room);
}

/* A reported shot, from a seat. Returns the reason it was refused, or "". */
function takeShot(room, seat, result, now) {
  const p = room.players[seat];
  if (!p || p.left) return "seat";
  if (room.status !== "playing" || room.phase !== "play") return "phase";
  if (!Rules.RESULTS.includes(result)) return "result";
  if (!room.active || !room.active.includes(seat)) return "seat";
  if (isPass(room) && seat !== room.turnSeat) return "turn";
  const fx = gearOf(room, p), extra = (fx ? fx.extraMs : 0) / SIM_SPEED;      // the shoes: this seat's clock runs a little past the bell
  if (now > room.phaseEndsAt + extra + Rules.GRACE_MS / SIM_SPEED) return "late";
  if (p.lastShotAt && now - p.lastShotAt < Rules.MIN_GAP_MS / SIM_SPEED) return "fast";
  if (p.roundShots >= Math.ceil(room.playMs / (Rules.MIN_GAP_MS * SIM_SPEED)) + 3) return "many";
  if (now > room.phaseEndsAt + extra && ++p.graceShots > 2) return "late";   // after the bell only the balls already in the air: two at most
  const r = Rules.score(result, p.streak | 0);
  if (r.pts > 0) r.pts += Gear.streakBonus(fx, p.streak | 0);      // the wristband: a little more on a basket in a streak
  p.shots++; p.roundShots++; p.lastShotAt = now;
  p.streak = r.streak; p.fire = r.streak >= Rules.FIRE_AFTER;
  if (r.pts > 0) { p.score += r.pts; p.makes++; if (result === "swish") p.swishes++; p.lastScoreAt = now - (room.roundStartedAt || now); p.lastScoreRound = room.roundId; }
  return "";
}

/* The room clock, every 50 ms: the countdown and the bell, the bots' shots. */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status !== "playing") continue;
    if (room.phase === "countdown" && now >= room.phaseEndsAt) { beginPlay(room); continue; }
    if (room.phase !== "play") continue;
    if (now >= room.phaseEndsAt) {
      if (!room.graceUntil) { room.graceUntil = room.phaseEndsAt + (maxExtraMs(room) + Rules.GRACE_MS) / SIM_SPEED; bump(room); }
      if (now >= room.graceUntil) endRound(room);
      continue;
    }
    for (const s of room.active || []) {
      const p = room.players[s];
      if (!p || !p.bot || !p.nextBotAt || now < p.nextBotAt) continue;
      const result = Rules.botShot(p.level, room.rand);
      p.nextBotAt = now + Rules.botGap(p.level, room.rand) / SIM_SPEED;
      if (takeShot(room, s, result, now) === "") bump(room);
    }
  }
}, 50);

function addBotTo(room, level) {
  if (room.players.length >= MAX_PLAYERS) return null;
  level = LEVELS.includes(level) ? level : "normal";
  const used = room.players.map((q) => q.name);
  const name = !used.includes(BOT_NAMES[level]) ? BOT_NAMES[level] : "Bot" + (room.players.length + 1);
  const p = { id: "bot_" + newId(), name, avatar: "\u{1F916}", bot: true, level, left: false, connected: true, gear: botGearFor(room) };
  room.players.push(p);
  return p;
}


/* ---------- sockets ---------- */

function attach(socket, code, playerId) {
  const was = socket.data.roomCode;
  /* (a pass-and-play room's own phone seating one of its local people: the same socket, still in the room) */
  if (was && (was !== code || socket.data.playerId !== playerId) && !(was === code && PassPlay.isLocal(rooms.get(code)))) dropFromRoom(socket);
  socket.data.playerId = playerId;
  socket.data.roomCode = code;
  if (!roomSockets.has(code)) roomSockets.set(code, new Set());
  roomSockets.get(code).add(socket);
}
function detach(socket) {
  const code = socket.data.roomCode;
  const set = roomSockets.get(code);
  if (set) { set.delete(socket); if (!set.size) roomSockets.delete(code); }
  socket.data.roomCode = null;
}
function heldElsewhere(room, id) {
  const set = roomSockets.get(room.code);
  if (set) for (const s of set) if (s.data.playerId === id) return true;
  return false;
}
function dropFromRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  const p = room ? room.players.find((q) => q.id === socket.data.playerId) : null;
  detach(socket);
  if (!room || !p || heldElsewhere(room, p.id)) return;
  p.connected = false;
  bump(room);
}

function forgetRoom(room) { rooms.delete(room.code); }

PassPlay.init({ app, base: BASE, rooms, broadcast: sendState, max: MAX_PLAYERS, drop: (c) => { const r = rooms.get(c); if (r) forgetRoom(r); } });
Quick.init({ game: 'hoops', model: 'openskill', seats: 4, codeKey: 'roomCode', app, io, rooms, base: BASE, broadcast: sendState,
  /* Quick and ranked play match within gear-score bands (gear.js BAND): an open room takes a player whose gear score is within it of the host's. Nothing on screen says so. */
  accept: (room, payload) => { const host = room.players.find((p) => p.id === room.host); return Gear.bandOk(Gear.scoreFor(host && host.gear, "hoops"), Gear.scoreFor(Gear.clean("hoops", payload.gear), "hoops")); } });
io.on("connection", (socket) => {
  Plus.guardSocket(socket);
  PassPlay.hook(socket);   // before Quick.hook: the seats a phone plays
  Quick.hook(socket); Quick.connection(socket); PassPlay.connection(socket);
  const currentRoom = () => rooms.get(socket.data.roomCode);
  Voice.wire({ on: (ev, fn) => socket.on(ev, (payload) => fn(obj(payload))), room: currentRoom, me: () => socket.data.playerId, bump, emit: (ev, d) => socket.emit(ev, d) });   // voice chat in private rooms (2026-11-18)
  Reactions.wire({ on: (ev, fn) => socket.on(ev, (payload) => fn(obj(payload))), room: currentRoom, me: () => socket.data.playerId,
    isHost: (r) => r.host === socket.data.playerId, bump });
  const me = () => { const r = currentRoom(); return r ? r.players.find((p) => p.id === socket.data.playerId) : null; };

  socket.on("create", (payload) => {
    const { name: rawName, playerId, avatar, caps, plus, look, crew, gear } = obj(payload);
    const name = cleanName(rawName);
    if (!name) return refuse(socket, "create", "name", "Pick a name first.");
    let code = genCode(); let guard = 0;
    while (rooms.has(code) && guard++ < 10) code = genCode();
    code = Plus.crewCode({ plus, crew }, rooms, () => code);
    const id = cleanId(playerId) || newId();
    const room = newRoom(code, id);
    room.players.push({ id, name, avatar: cleanAvatar(avatar) || AVATARS[0], left: false, connected: true, caps: cleanCaps(caps), gear: Gear.clean("hoops", gear) });
    rooms.set(code, room);
    attach(socket, code, id);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: id });
    bump(room);
  });

  socket.on("join", (payload) => {
    const { code: rawCode, name, playerId, avatar, caps, plus, look, gear } = obj(payload);
    const code = text(rawCode).trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return refuse(socket, "join", "not_found", "No room with that code.");
    const known = cleanId(playerId);
    let p = known ? room.players.find((q) => q.id === known) : null;
    if (p) {
      p.connected = true; p.left = false;
      p.caps = cleanCaps(caps);
      if (gear !== undefined && room.status === "lobby") p.gear = Gear.clean("hoops", gear);   // gear changes between matches, never in one
      const n = cleanName(name);
      if (n) p.name = n;
    } else {
      if (room.status !== "lobby") return refuse(socket, "join", "started", "That match already started.");
      if (room.players.length >= MAX_PLAYERS) return refuse(socket, "join", "full", `Room is full (${MAX_PLAYERS}).`);
      const n = cleanName(name);
      if (!n) return refuse(socket, "join", "name", "Pick a name first.");
      const id = known || newId();
      p = { id, name: n, avatar: cleanAvatar(avatar) || AVATARS[room.players.length % AVATARS.length], left: false, connected: true, caps: cleanCaps(caps), gear: Gear.clean("hoops", gear) };
      room.players.push(p);
      room.log = `${n} joined.`;
    }
    attach(socket, code, p.id);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: p.id });
    bump(room);
  });

  /* The host's choices, in the lobby or between rounds: { seconds: 30|45|60, court: "orbit"|"candy"|"bath" }. */
  socket.on("settings", (payload) => {
    const { seconds, court, gear } = obj(payload);
    const room = currentRoom();
    if (!room || room.status === "playing" || room.host !== socket.data.playerId) return;
    /* The host's gear switch (private rooms only; a quick or ranked room is matched by gear score and has none). */
    if (typeof gear === "boolean") { if (!room.quick && gear !== (room.gearOn !== false)) { room.gearOn = gear; room.log = gear ? "Gear is on." : "Gear is off: everyone plays at the base."; bump(room); } return; }
    let changed = false;
    if (SECONDS.includes(seconds) && seconds !== room.opts.seconds) { room.opts.seconds = seconds; changed = true; }
    /* The Candy Counter and the Bathtub Splash League are GameNest Plus's: a host who owns Plus picks them, anyone else keeps the Orbital Toy Station. */
    const hostP = room.players.find((q) => q.id === room.host);
    if (COURTS.includes(court) && court !== room.opts.court && (court === "orbit" || (hostP && hostP.plus))) { room.opts.court = court; changed = true; }
    if (changed) { room.log = `${room.opts.seconds} seconds a round.`; bump(room); }
  });

  /* A player's gear changed while they sat in the lobby (they upgraded or bought something on the gear page): { hball: { item, level }, hshoes, band }. Clamped as on join. */
  socket.on("gear", (payload) => {
    const room = currentRoom(), self = me();
    if (!room || !self || room.status !== "lobby" || self.bot) return;
    self.gear = Gear.clean("hoops", obj(payload));
    room.log = `${self.name} changed their gear.`;
    bump(room);
  });

  socket.on("addBot", (payload) => {
    const { level } = obj(payload);
    const room = currentRoom();
    if (!room || room.status === "playing" || room.host !== socket.data.playerId) return;
    if (room.players.length >= MAX_PLAYERS) return refuse(socket, "addBot", "full", "Room is full.");
    const b = addBotTo(room, level);
    if (!b) return;
    room.log = `${b.name} (${b.level} bot) joined.`;
    bump(room);
  });

  socket.on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].bot) { room.log = `${room.players[i].name} left.`; room.players.splice(i, 1); break; }
    }
    bump(room);
  });

  socket.on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < MIN_PLAYERS) return refuse(socket, "start", "nobody", "Nobody to play against.");
    startMatch(room);
    bump(room);
  });

  /* A shot's end, reported by the phone that played the ball: { r: "swish"|"rim"|"miss" }; in a pass-and-play room { as } is the seat (passplay.js
     runs this as that seat). The server counts it (rules.js) and refuses what cannot be: too soon after the last, after the bell, a seat that is not shooting. */
  socket.on("shot", (payload) => {
    const { r } = obj(payload);
    const room = currentRoom(), self = me();
    if (!room || !self) return;
    const seat = room.players.indexOf(self);
    if (seat < 0 || room.players[seat].bot) return;
    if (takeShot(room, seat, text(r), Date.now()) === "") bump(room);
  });

  /* Pass-and-play: the next shooter has the phone and taps Ready; their countdown starts. */
  socket.on("ready", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "handover" || !isPass(room) || room.local.owner !== socket.data.playerId) return;
    const t = room.players[room.turnSeat];
    if (!t || t.left) { room.queue = room.queue.filter((i) => room.players[i] && !room.players[i].left); return endRound(room), undefined; }
    room.turnReady = true;
    beginRound(room, [room.turnSeat], room.playMs);
    bump(room);
  });

  /* Clock sync for the app: { c } back with the server's time. */
  socket.on("ping", (payload) => { const { c } = obj(payload); socket.emit("pong", { c: Number.isFinite(c) ? c : 0, s: Date.now() }); });

  socket.on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    room.players = room.players.filter((q) => !q.left);
    if (room.players.length < MIN_PLAYERS) return refuse(socket, "rematch", "nobody", "Nobody to play against.");
    if (!room.players.some((q) => q.id === room.host)) room.host = room.players.find((q) => !q.bot).id;
    startMatch(room);
    room.log = `Rematch! ${room.log}`;
    bump(room);
  });

  function handleLeave() {
    const room = currentRoom(), p = me();
    detach(socket);
    if (!room || !p) return;
    room.log = `${p.name} left.`;
    if (room.status === "lobby") {
      room.players = room.players.filter((q) => q !== p);
      if (room.host === p.id) { const h = room.players.find((q) => !q.bot); if (h) room.host = h.id; }
    } else {
      p.left = true; p.connected = false;
      if (room.host === p.id) { const h = room.players.find((q) => !q.bot && !q.left && !q.local); if (h) room.host = h.id; }
      if (room.status === "playing") {
        const alive = room.players.map((q, i) => (q.left ? -1 : i)).filter((i) => i >= 0);
        if (alive.length < 2 && !isPass(room)) { const w = alive[0]; if (w != null) finishMatch(room, [w], `${room.players[w].name} wins: everyone else left.`); }
        else if (room.active) room.active = room.active.filter((i) => !room.players[i].left);
        if (room.queue) room.queue = room.queue.filter((i) => room.players[i] && !room.players[i].left);
        if (room.contenders) room.contenders = room.contenders.filter((i) => room.players[i] && !room.players[i].left);
      }
    }
    if (room.players.every((q) => q.left || q.bot || q.local)) { forgetRoom(room); return; }
    bump(room);
  }

  socket.on("pushToken", (payload) => {
    const { token } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token;
  });

  socket.on("presence", (payload) => {
    const { away } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p) p.away = !!away;
  });

  socket.on("chat", (payload) => {
    let { text, sticker } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (!p) return;
    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < CHAT_COOLDOWN_MS) return;

    let msg = null;
    if (sticker) {
      if (!STICKERS.includes(sticker)) return;
      msg = { k: "s", s: sticker };
    } else {
      text = cleanChat(text);
      if (!text) return;
      msg = { k: "t", x: text };
    }
    socket.data.lastChat = now;
    const finish = () => {
      const room = rooms.get(code), p = room && room.players.find((q) => q.id === pid);   // gone while it was read
      if (!p) return;
      msg.n = p.name; msg.c = p.color; msg.a = p.avatar; msg.t = now;
      room.chat.push(msg);
      // a sticker is not worth waking someone for; words are
      if (msg.k === "t") {
        for (const q of room.players) {
          if (q !== p) pushTo(q, p.name + ": " + msg.x, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
        }
      }
      if (room.chat.length > CHAT_KEEP) room.chat.shift();
      room.touched = Date.now();
      bump(room);
    };
    const code = room.code, pid = p.id;
    if (msg.k === "t") Moderation.chat(msg.x).then((shown) => { msg.x = shown; finish(); }); else finish();
  });

  /* Voice is peer to peer; the server only carries the handshake, never audio.
     The 20k ceiling is what stops a signal being used as a data channel. */
  socket.on("voice", (payload) => {
    const { kind, to, data } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0) return;

    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat);
      else room.voice.delete(seat);
      room.touched = Date.now();
      bump(room);
      return;
    }

    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0;
      try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      const sockets = roomSockets.get(room.code);
      if (!sockets) return;
      for (const s of sockets) {
        const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
        if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  /* Tests only (TEST_HOOKS=1): put the round where a test needs it. { scores: [a, b, ...], streaks: [..], playMs }. */
  if (TEST_HOOKS) socket.on("testSet", (payload) => {
    const o = obj(payload);
    const room = currentRoom();
    if (!room || !me()) return;
    if (Array.isArray(o.scores)) o.scores.slice(0, room.players.length).forEach((s, i) => { if (Number.isInteger(s) && s >= 0) room.players[i].score = s; });
    if (Array.isArray(o.streaks)) o.streaks.slice(0, room.players.length).forEach((s, i) => { if (Number.isInteger(s) && s >= 0) { room.players[i].streak = s; room.players[i].fire = s >= Rules.FIRE_AFTER; } });
    if (Number.isFinite(o.endInMs) && room.phase === "play") room.phaseEndsAt = Date.now() + o.endInMs;
    bump(room);
  });

  socket.on("leave", handleLeave);
  socket.on("disconnect", () => dropFromRoom(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) forgetRoom(room);
  }
}, 60000).unref();

server.listen(PORT, () => console.log(`Flick Hoops Rooms running on port ${PORT}${BASE ? " under " + BASE : ""}`));

module.exports = { app, server, io };
