# Chor-Police Backend

Real-time multiplayer backend for the classic Bengali party game **Chor–Dakat** (thief and bandit), built with [NestJS](https://docs.nestjs.com) and [Socket.IO](https://socket.io). Players join a room with a 6-digit code, secretly draw paper slips to receive roles, and the Police tries to identify the thief (Chor) or bandit (Dakat) the Babu has targeted.

## How the game works

- **Rooms & lobby:** The host creates a room and shares the 6-digit code. Players join in real time, see the player list, and chat before a match starts.
- **Picking:** Each round, every player picks one of the shuffled paper slips. Each slip has a permanent identity icon (🐴 🍬 🎈 🍕 ⚓ 🌵 🌮 🧸) so everyone sees the same icon per slip. Players who don't pick in time get slips auto-assigned.
- **Role reveal:** Slips assign the roles below. Chor and Dakat are publicly masked as `CHOR_OR_DAKAT`; only they (and each other) know who is who.
- **Target selection:** The Babu picks which role the Police should hunt: Chor or Dakat.
- **Guessing:** The Police picks one suspect player. If the suspect's role matches the Babu's target, the catch is successful.
- **Scoring:** Everyone earns their role's base points each round; the Police earns nothing on a wrong guess, and the caught target earns nothing on a correct catch.
- **Match end:** The game ends when a player reaches `targetScore` (e.g. 3000) or after `maxRounds` rounds. The host can authorize players to start the next round, or end the match early and return everyone to the lobby.

### Roles & base points (per round)

| Role | English | Points |
| --- | --- | --- |
| RAJA | Babu | 1000 |
| POLICE | Police | 800 (0 on a wrong guess) |
| CHOR | Thief | 500 |
| DAKAT | Bandit | 400 |
| JHARUDAR | Sweeper | 200 |
| CLEANER | Cleaner | 200 |
| PAGOL | Madman | 50 |
| CHAGOL | Goat | 100 |

Role distribution scales with the player count (**4–8 players required**):

| Players | Roles dealt |
| --- | --- |
| 4 | Babu, Police, Chor, Dakat |
| 5 | + Jharudar |
| 6 | + Cleaner |
| 7 | + Pagol |
| 8 | + Chagol |

## Features

- Socket.IO gateways for rooms, game, and chat with namespace-style event naming (`room:*`, `game:*`, `chat:*`)
- Room lifecycle: create, join, leave, auto-close when empty
- Disconnect handling and reconnect via `reconnectToken`, including in-game state and private-role resync
- Live room/player updates, aborting a game when a player leaves mid-match
- Host-controlled match settings (`targetScore`, `maxRounds`) and next-round flow
- In-room chat (max 200 characters) and a fixed set of reactions (😂 🕵️ 🤫 😱 👑 🔥 👀 👍)
- All state kept in memory; no database required

## Tech stack

- [NestJS 12](https://docs.nestjs.com) (Express)
- Socket.IO via `@nestjs/platform-socket.io`
- TypeScript (ESM), Vitest for tests, OxLint for linting

## Getting started

```bash
npm install
```

### Configure (optional)

Create a `.env` in the project root — it is loaded automatically:

```env
PORT=3000
BASE_URL=http://localhost:3000
```

### Run

```bash
# development (watch mode)
npm run start:dev

# production
npm run build
npm run start:prod
```

The server listens on `PORT` (default `3000`).

## Scripts

| Script | Description |
| --- | --- |
| `npm run build` | Compile the project (`nest build`) |
| `npm run start:dev` | Start in watch mode |
| `npm run start:prod` | Run the compiled output (`dist/main.js`) |
| `npm run test` | Run unit tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:cov` | Run tests with coverage |
| `npm run test:e2e` | Run e2e tests |
| `npm run lint` | Lint with OxLint |
| `npm run format` | Format with Prettier |

## Socket.IO API

All communication happens over WebSocket using the events below. Payloads are validated server-side and errors are reported back on `room:error`, `game:error`, or `chat:error`.

### Rooms (`rooms.gateway.ts`)

| Client → server | Server → client | Notes |
| --- | --- | --- |
| `room:create` `{ playerName }` | `room:created` | Creates a new room; returns `reconnectToken` |
| `room:join` `{ roomCode, playerName }` | `room:joined`, `room:updated` | |
| `room:reconnect` `{ roomCode, reconnectToken }` | `room:reconnected`, `room:updated` | |
| `room:leave` | `room:left`, `room:updated`, `room:closed` | Host leaving closes the room |
| — (disconnect) | `room:updated` | Player marked disconnected |

### Game (`game.gateway.ts`)

| Client → server | Server → client | Notes |
| --- | --- | --- |
| `game:start` `{ settings? }` | `game:started` | Host only; 4–8 players, all connected |
| `game:pick-paper` `{ paperId }` | `game:state-updated`, then `game:roles-revealed` + private `game:my-role` | When all have picked |
| `game:select-target` `{ targetRole }` | `game:target-selected` | Babu only; CHOR or DAKAT |
| `game:select-suspect` `{ selectedPlayerId }` | `game:police-selecting` | Police hover/preview while guessing |
| `game:guess-player` `{ selectedPlayerId }` | `game:round-result` or `game:match-ended` | Police only |
| `game:allow-next-round` `{ playerId }` | `game:next-round-permission` | Host authorizes a player |
| `game:next-round` | `game:started` | Host or authorized player |
| `game:finish` | `game:match-ended` | End the match early |
| `game:back-to-lobby` | `game:back-to-lobby` | Host only, after game over |
| — (reconnect) | `game:started`, `game:state-updated`, `game:my-role` | State resync on rejoin |

### Chat (`chat.gateway.ts`)

| Client → server | Server → client | Notes |
| --- | --- | --- |
| `chat:send-message` `{ message }` | `chat:message` | Trimmed; max 200 chars |
| `chat:send-reaction` `{ reaction }` | `chat:reaction` | Emoji from the allowed set |

## Project structure

```
src/
├── main.ts                    # Bootstrap; loads .env, listens on PORT
├── app.module.ts              # Root module
└── modules/
    ├── rooms/                 # Room lifecycle, join/reconnect, public state
    ├── game/                  # Game state machine, roles, scoring, game gateway
    ├── chat/                  # In-room chat and reactions
    └── players/               # Player plumbing shared across gateways
```

Key files:

- `src/modules/game/game.service.ts` — rounds, role dealing, scoring, match-end rules
- `src/modules/game/scoring.ts` — per-role base points
- `src/modules/rooms/rooms.service.ts` — in-memory room registry and reconnect tokens

## Testing

```bash
# unit tests
npm run test

# e2e tests
npm run test:e2e

# coverage
npm run test:cov
```

## Deployment

This is a stateful WebSocket server (all room/game state lives in memory), so a single instance is expected. Any Node host works — e.g. deploy with the NestJS CLI:

```bash
npm install -g @nestjs/mau
mau deploy
```

Remember to set `PORT` and (if behind a proxy) `BASE_URL`, and relax the `origin: '*'` CORS settings in the gateway files (`rooms.gateway.ts`, `game.gateway.ts`, `chat.gateway.ts`) before going to production.

## License

UNLICENSED — private project.
