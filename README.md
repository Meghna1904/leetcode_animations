# leetcode_animations

A personal DSA hub with a browsable question-pattern list, solve tracking, spaced-repetition reviews, and a collection of interactive HTML animations.

## Run locally

```sh
npm install
npm run dev
```

## Build for deployment

```sh
npm run build
```

The production site is generated in `dist/`. On Vercel, use `npm run build` as the build command and `dist` as the output directory if they are not detected automatically.

Solved status, review schedules, and saved animations are cached in browser storage and synced to Neon under a username account. Sign in with the same account on each device to access that account’s data. Passwords are stored as salted scrypt hashes, and sessions use a signed, HTTP-only cookie.

**There is no password recovery method.** If a user forgets their password, they cannot access that account’s cloud data.

## Enable cloud sync on Vercel

Add these environment variables to the Vercel project:

- `DATABASE_URL`: the Neon PostgreSQL connection string. Keep it server-side; it is used only by the Vercel API functions. `PGUSER` and `PGPASSWORD` alone are not enough; the app also needs a database host and name, so set the full `DATABASE_URL`.
- `SYNC_SESSION_SECRET`: a random secret of at least 32 characters, used to sign secure login cookies.

Redeploy after adding the variables. Open **Sync** in DSA Hub and create a username and password. Usernames are 3–32 letters, numbers, or underscores; passwords must be at least 10 characters. Use the same account on each device. Local browser data is merged into that account on first sign-in. Cloud sync runs through Vercel API functions; the simple `npm run dev` static server remains local-only.
