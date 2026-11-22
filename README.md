# Flick Hoops Rooms (self-hosted)

The room server for **Flick Hoops** (slug `hoops`, dev port 3130, path `/hoops`): two to four players flick a ball at a moving hoop, all at once, each on their own phone.
Express and Socket.IO, rooms behind a 6-letter code (letters only), quick play and ranked (OpenSkill, `quickmatch.js`), bots Easy / Normal / Hard, the cartoon reactions, chat,
voice signalling, push, Plus. No ads.

## How it plays

The phone plays the ball (the app's `HoopsSim`, a deterministic ball and hoop; the hoop's path starts from `room.seed`). The server keeps the clock and the scores:
`rules.js` counts each reported shot: **swish 3** (through the net, touching nothing), **rim-in 2**, and after three makes in a row the **fire ball**: each make is worth one more
until a miss. Rounds are 30, 45 (default) or 60 s; level at the bell is a 10 s sudden-death round for the tied players only (up to three; then whoever scored first wins).
It refuses what a person could not do: results under 0.3 s apart, or in the first second, from a seat that is not shooting, or more than 2.2 s after the bell.

Pass-and-play (`create {local: true}` + `addLocal {name}`, passplay.js): one phone, the players take their 45 s turns in seat order, `handover` between turns until the phone sends `ready`;
shots are `shot {r, as: seat}`. Never rated.

## The wire

Client to server: `create`, `join`, `settings {seconds: 30|45|60, court: orbit|candy|bath}` (the last two are Plus), `addBot {level}`, `removeBot`, `start`, `shot {r: "swish"|"rim"|"miss"}`,
`ready` (pass-and-play), `ping {c}` (answered `pong {c, s}`), `rematch`, `leave`, `chat`, `voice`, `react`, `quick` / `quickCancel`, `pushToken`, `presence`;
with `TEST_HOOKS=1` also `testSet {scores, streaks, endInMs}`.

Server to client: `state {room, mySeat}` on every change (every counted shot too). `room.phase`: `lobby`, `countdown` (3 s), `play`, `handover` (pass-and-play), `over`.
`room.clockMs` is the play time left as of `serverNow`; `room.phaseEndsAt` the bell (or the countdown's end); `room.seed`; `room.golden`; `room.turnSeat`; `room.winners`;
`players[i].{score, streak, fire, shots, makes, swishes, shooting}`.

## Run it

```bash
PORT=3130 node server.js
BASE_PATH=/hoops PORT=3000 node server.js
npm test
```

Env: `COUNTDOWN_MS`, `SUDDEN_MS`, `MS_PER_SECOND` (tests shorten a round), `SIM_SPEED`, `TEST_HOOKS`.
