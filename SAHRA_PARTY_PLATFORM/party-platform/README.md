# سَهرة — Online Party Games

An Arabic-first, RTL multiplayer party-game web app starter with a dark/lime visual identity, accounts, private invite rooms, Socket.IO live synchronization, a persistent SQLite database, and server-side match rewards.

## Included in this build

- Account registration/login, bcrypt password hashing, JWT session, logout.
- Unique usernames, profile stats, levels, XP, competitive rating/ranks, leaderboard and match history API.
- Private invite rooms with short codes, direct links, lobby/player list, ready status, host transfer on disconnect, live room chat, reconnect-by-link, and capacity controls.
- Playable server-driven game flows: Tic-Tac-Toe, Auction Questions, Mad Gab/phrase guessing, and Codenames with captain-only hidden word colors.
- Match/reward transactions persisted in SQLite with a uniqueness constraint preventing duplicate rewards for the same match/user.
- Responsive Arabic RTL interface, mobile layout, and game-selection flow.

## Important scope notes

This is a working starter/MVP, not yet a fully audited production launch. The following parts of the original specification are not implemented or need further work before a public competitive launch:

- Password reset/email verification, guest-only accounts, friends/presence, achievements, seasonal competitions, admin dashboard and moderation workflow.
- Codenames needs additional formal rule tests and edge-case review; auction and Mad Gab are simplified party-game rules and need richer curated question/phrase packs, configurable timers, and more robust round progression.
- Room state currently lives in server memory. User profiles and match/reward records persist in SQLite, but an app restart clears active rooms. Use a persistent database plus shared state/adapter (e.g. PostgreSQL/Redis) before horizontal scaling.
- No automated two-device internet acceptance test has been performed from this environment. Do not advertise it as production-verified until you run the checklist below.
- The default development JWT secret is intentionally insecure. Set a strong `JWT_SECRET` before exposing the service publicly.

## Run locally

Requires Node.js 20 or newer.

```bash
cp .env.example .env
# Edit .env and set JWT_SECRET to a long random value
npm install
npm start
```

Open `http://localhost:3000` in two different browser profiles to test separate accounts. Use the same public deployment URL for friends outside your network; localhost links are only accessible on your own device.

## Deploy to Render (single instance)

1. Create a private GitHub repository and upload these project files.
2. In Render, create a **Web Service** connected to the repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables:
   - `NODE_ENV=production`
   - `JWT_SECRET=` a long random secret (at least 32 random bytes)
   - `PUBLIC_URL=https://YOUR-SERVICE.onrender.com`
   - `DATABASE_FILE=/var/data/party.sqlite`
6. Attach a persistent disk mounted at `/var/data` (at least 1 GB) so SQLite data survives redeploys/restarts.
7. Deploy, then open `https://YOUR-SERVICE.onrender.com/api/health`. It should return `{ "ok": true, ... }`.
8. Register two accounts in separate browsers, create a room, copy the HTTPS invite link, and open it from a separate device/network.

Do not run multiple web-service instances with this in-memory room state. For multi-instance scale, move room state to Redis or another shared authoritative game service and use a compatible Socket.IO adapter.

## Smoke-test checklist

- [ ] `/api/health` responds successfully over HTTPS.
- [ ] Two different accounts can register and sign in.
- [ ] Host creates a room; invite URL and room code copy correctly.
- [ ] A second browser/device can join the same lobby.
- [ ] Chat and ready state update in both clients.
- [ ] Host starts each game and actions synchronize.
- [ ] A completed match updates XP/rating/stats once in the database.
- [ ] Refresh/reopen an invite URL and verify room reconnect behavior while the server process remains running.
- [ ] Verify invalid room IDs, full rooms, non-host start attempts and out-of-turn moves are rejected.
- [ ] Verify an invited friend on a different internet connection can reach the deployed service.

## Security notes

- Passwords are hashed using bcrypt.
- API and auth endpoints are rate-limited.
- Game moves, turns and rewards are validated on the server.
- Never commit `.env`, production secrets, or the SQLite database into a public repository.
- Have the game logic and security reviewed before a high-traffic public release.
