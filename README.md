# GHIN Friends — a PWA for tracking friends' golf handicaps

A Progressive Web App that:

- Lists your friends and their current GHIN handicap index
- Charts the trailing 12-month change for everyone on a single graph
- Installs to your iPhone home screen
- Refreshes itself daily — even when the app is closed — via a GitHub Action

## Architecture in one picture

```
  GitHub Actions cron (daily 14:00 UTC)
            │
            ▼
  scripts/snapshot.mjs    ──▶  fetches each friend's GHIN profile
            │                  appends today's row to data.json
            ▼                  commits the change back to main
  data.json (in this repo)
            │
            ▼  served by GitHub Pages
  index.html on your iPhone  ──▶  fetches data.json, draws the chart
```

The PWA itself is a viewer. The repo is the database. The Action does the work.

---

## The files

| File | What it does |
|---|---|
| `index.html` | The PWA itself — single-file shell, embedded CSS + JS, renders the chart. |
| `manifest.json` | Tells iOS this is an installable app. |
| `icon-180.png` | The home-screen icon. |
| `friends.json` | The list of friends you're tracking. You edit this. |
| `data.json` | The accumulated handicap history. The Action writes this. |
| `scripts/snapshot.mjs` | The Node script that runs daily on GitHub's servers. |
| `.github/workflows/snapshot.yml` | The cron schedule + workflow that runs the script. |

---

## Setup — one-time, ~20 minutes

You'll do these in order:

1. [Push to GitHub & enable Pages + Actions](#step-1-push-to-github) (~10 min)
2. [Add your GHIN credentials as GitHub Secrets](#step-2-add-github-secrets) (~3 min)
3. [Add a friend & verify the cron works](#step-3-verify-end-to-end) (~5 min)
4. [Install on your iPhone](#step-4-install-on-iphone) (~2 min)

> **Why secrets?** GHIN's API requires a logged-in user. The daily script authenticates as you (your email/GHIN# + password) to pull each friend's handicap. Storing the credentials as **GitHub Actions Secrets** keeps them encrypted — they're never visible in the repo, in logs, or in the PWA. They only exist as environment variables inside the running workflow.

### Step 1: Push to GitHub

1. **Install GitHub Desktop** from [desktop.github.com](https://desktop.github.com). Sign in.
2. **File → New Repository** → name `ghin-friends`, local path somewhere like `Documents\GitHub\`, check "Initialize with README" → **Create Repository**.
3. **Copy these files** into the new repo folder (everything inside `iphone-app/` — `index.html`, `manifest.json`, `icon-180.png`, `friends.json`, `data.json`, the `scripts/` folder, the `.github/` folder).
4. **Edit `index.html`** — find this line near the top of the `<script>` block:
   ```js
   const GITHUB_REPO = 'your-username/ghin-friends';
   ```
   Replace `your-username` with your actual GitHub username.
5. **In GitHub Desktop**, you'll see all files listed. Type a commit summary ("First version") → **Commit to main**.
6. Click **Publish repository** at the top. **Uncheck "Keep this code private"** (free Pages and Actions require public). → **Publish**.
7. **Repository menu → View on GitHub**.
8. On github.com, click **Settings**:
   - **Pages** (left sidebar): set Source = "Deploy from a branch", Branch = `main`, Folder = `/ (root)` → Save.
   - **Actions → General** (left sidebar): scroll to **Workflow permissions**, choose **"Read and write permissions"** → Save. *Without this, the daily cron can't commit `data.json` back to the repo.*
9. Wait 1–2 minutes. Refresh the Pages settings page — a green box will show your URL: `https://<your-username>.github.io/ghin-friends/`. Copy it.

### Step 2: Add GitHub Secrets

The daily script logs into GHIN as you. Set your credentials so the workflow can read them — they're encrypted and never visible to anyone, including you, after you save them.

1. On github.com, repo → **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret**. Name: `GHIN_USER`, Value: your GHIN account email (or your GHIN number). Click **Add secret**.
3. Click **New repository secret** again. Name: `GHIN_PASSWORD`, Value: your GHIN password. Click **Add secret**.

Both names must match exactly — the workflow YAML refers to `secrets.GHIN_USER` and `secrets.GHIN_PASSWORD`.

> **Test locally first if you want.** Open PowerShell in the repo folder and run:
> ```powershell
> $env:GHIN_USER='you@example.com'; $env:GHIN_PASSWORD='your-password'
> node scripts/snapshot.mjs
> ```
> (You'll need Node installed locally for this — not required if you're skipping the local test.)

### Step 3: Verify end-to-end

1. **Add yourself as a friend**. Open `https://github.com/<you>/ghin-friends/edit/main/friends.json` in a browser. Replace the `[]` with:
   ```json
   [
     { "ghin": "YOUR_GHIN_NUMBER", "name": "Your Name", "club": "Your Club" }
   ]
   ```
   Click the green **Commit changes** button.

2. **Trigger the cron manually**. On github.com, **Actions** tab → "Daily GHIN Snapshot" → **Run workflow** button (right side) → **Run workflow**.

3. **Watch the run**. After ~30 seconds it should turn green. Click into the run → expand "Run snapshot script" — you should see lines like:
   ```
   Authenticating to GHIN...
   Authenticated. Fetching 1 golfer(s).
   + 1234567 (Your Name): 12.3
   ```

4. **Confirm data.json was updated**. Back on the repo home page, click `data.json` — it should now contain your entry with today's date.

5. **Open the Pages URL** in your laptop's browser. You should see your card with your handicap index and the chart card below.

Common failure modes:
- **"GHIN login response did not contain golfer_user.golfer_user_token"** → wrong email or password in the GitHub secrets. Re-enter both `GHIN_USER` and `GHIN_PASSWORD`.
- **"Permission denied to github-actions[bot]"** on the commit step → you missed the **Workflow permissions → Read and write** setting in Step 1.8. Fix it and re-run.
- **"No golfer returned for GHIN 1234567"** → the GHIN number doesn't exist or isn't reachable from your account. Double-check the number.

### Step 4: Install on iPhone

1. Open the Pages URL in **Safari** on your iPhone (must be Safari — Chrome on iOS doesn't install correctly).
2. Tap the **Share** button (square with up-arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Confirm the name → **Add**.
5. Find the green "G" icon on your home screen. Tap it. The app should open in full screen (no Safari URL bar).

You're done. Every day at 14:00 UTC, the cron will snapshot your friends' handicaps. Next time you open the app, fresh data shows up.

---

## Daily life

**First time you tap "+ Add" on your phone**: the app walks you through creating a GitHub Personal Access Token (~2 minutes). Once it's saved, adding and removing friends is fully in-app.

**Adding a friend (after the one-time PAT setup).**
1. In the GHIN mobile app, tap **Find Golfer** → search → note the **GHIN number**.
2. In the PWA, tap **+ Add** → enter GHIN#, name, club → tap **Add** (queues for next daily run) or **Add & run now** (commits to `friends.json` and triggers a snapshot immediately).

**Removing a friend.** Tap **Manage** at the bottom of the list → tap the **×** on a card → confirm. Their past data is preserved in `data.json`, so re-adding them later restores their chart line.

**Refresh on demand.** The **↻** button in the header triggers the snapshot workflow without adding anyone — useful when you want fresh data right now instead of waiting for tomorrow.

**Removing a friend.** Open `friends.json` on GitHub, delete the entry, commit. (The `data.json` history is preserved — re-adding them later restores their chart line.)

**Forcing an immediate refresh.** Actions tab → "Daily GHIN Snapshot" → **Run workflow**.

**Updates aren't showing on my phone?** iOS aggressively caches PWA assets. Long-press the home-screen icon → **Remove from Home Screen**, then re-add it from Safari.

---

## Known limitations

- **Chart starts sparse.** Daily snapshots accrue starting from day 1. The first 30 days will look like dots, not lines. After a few months you'll see real trends.
- **Cron is best-effort.** GitHub Actions can run minutes (occasionally hours) late under heavy load. Acceptable for a daily snapshot.
- **GHIN can break this any time.** If USGA changes their auth flow or response shape, the script needs updating. The auth flow in `scripts/snapshot.mjs` mirrors what the GHIN mobile app does; if their app keeps working but the script doesn't, the constants near the top of `snapshot.mjs` (Firebase app ID, Google API key) may need refreshing — these come from the [n8io/ghin npm wrapper](https://github.com/n8io/ghin), which tracks GHIN's mobile app's behavior.
- **Public repo only.** Free GitHub Pages + Actions require the repo to be public. Friend names and club affiliations will be visible to anyone who finds the repo. No scores or personal info are exposed — but be aware.
- **USGA's TOS.** Scraping is technically discouraged. Risk is low for once-a-day personal use across a handful of friends, but it exists.

## Future ideas

- Service worker for offline shell + cache versioning (solves the iOS update-stickiness problem)
- In-app friend search by name (would require entering GHIN credentials in the browser — security tradeoff)
- Per-friend detail view: recent scores, slope/rating distribution
- Export to CSV
