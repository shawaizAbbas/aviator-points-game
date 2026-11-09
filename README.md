# Sky Crash — Aviator-Style Fun Points Game ✈️⭐

A multiplayer Aviator-style crash game played with **fun points only** (no real money
anywhere). One server runs the flights for everybody at the same time: the plane takes
off, the multiplier climbs, and players must cash out before it flies away.

- **Players** open the game link, pick their name, place bets with their points, and
  cash out during the flight.
- **The admin (boss)** opens `/admin`, unlocks it with a PIN, and is the only one who
  can create players, add points, remove points, and delete players.
- The server decides the crash point for every round (server-authoritative), so all
  phones see the same flight.
- Players and balances are saved in a `data.json` file on the server — no database.

---

## Deploy on Render (step by step)

1. **Put this folder in a GitHub repo** (or use Render's "Public Git repository" /
   deploy from your repo). The repo must contain `package.json`, `server.js`, and the
   `public/` folder at its root.

2. Go to the [Render Dashboard](https://dashboard.render.com) → **New +** →
   **Web Service**.

3. Connect your GitHub account and pick the repo with this game.

4. Fill in the service settings:
   - **Name:** anything you like, e.g. `sky-crash`
   - **Runtime / Environment:** `Node`
   - **Build Command:**
     ```
     npm install
     ```
   - **Start Command:**
     ```
     npm start
     ```
   - **Instance Type:** Free is fine for fun with friends.

5. **Set the admin PIN** — still on the create page (or later under
   **Environment**), add an environment variable:
   - Key: `ADMIN_PIN`
   - Value: your secret PIN, e.g. `7788` — **do not leave the default `1234`!**
     (If `ADMIN_PIN` is not set, the admin panel PIN defaults to `1234`.)

6. Click **Create Web Service**. Render installs dependencies and starts the game.
   When the deploy says **Live**, your game is at:
   ```
   https://<your-service-name>.onrender.com
   ```

7. **Share the link** with your friends — that's the play page.
   Your boss panel is at:
   ```
   https://<your-service-name>.onrender.com/admin
   ```

## How to run the game night

1. Open `/admin`, enter your PIN.
2. Create a player for each friend (give them starting points, e.g. 1000).
3. Friends open the game link on their phones and pick their name.
4. During each ~6-second betting window they place a bet; while the plane flies
   they hit **CASH OUT** to win bet × multiplier. If the plane flies away first,
   the bet is lost.
5. Anyone running low? Top them up from the admin panel (+100 / +500 / +1000 or any
   custom amount). You can also remove points or delete players.

## Good to know (free tier)

- **The free Render tier sleeps** after ~15 minutes without visitors. The first
  person to open the link after a nap waits ~30–60 seconds for it to wake up.
  That's normal.
- **Points data lives in `data.json`** on the service's disk. On the free tier the
  disk is temporary: **redeploying the service (or some restarts) can reset
  `data.json`**, wiping players and balances. For a fun game this is acceptable —
  just re-create the players from the admin panel. Don't store anything precious
  in it.
- Everyone must be polite to the boss. The boss controls the points. 😎

## Run it locally (optional)

```bash
npm install
ADMIN_PIN=1234 npm start
# play:  http://localhost:3000
# admin: http://localhost:3000/admin
```

Requires Node.js 18 or newer.
