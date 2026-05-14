// Daily snapshot fetcher — runs on GitHub Actions (Node 20+).
//
// GHIN's lookup requires a logged-in user. This script:
//   1. Gets a Firebase installation token (anonymous, public Google API).
//   2. Logs in to GHIN with the user's email + password to get a JWT.
//   3. For each friend in friends.json, fetches the golfer record by GHIN#.
//   4. Appends today's handicap index to data.json.
//
// Auth flow reverse-engineered from the unofficial n8io/ghin npm wrapper
// (https://github.com/n8io/ghin), which mirrors what the GHIN mobile app does.
//
// =============================================================================
// CREDENTIALS
// =============================================================================
// Set these as GitHub Actions secrets — NEVER paste them into this file:
//
//   GHIN_USER     your GHIN account email OR your GHIN number
//   GHIN_PASSWORD your GHIN account password
//
// To set them: on github.com, go to repo → Settings → Secrets and variables
// → Actions → New repository secret. Add both. The workflow YAML pipes them
// into this script as environment variables.
//
// For local testing, set them in your shell before running:
//   PowerShell:  $env:GHIN_USER='you@example.com'; $env:GHIN_PASSWORD='...'
//   bash:        GHIN_USER=you@example.com GHIN_PASSWORD=... node scripts/snapshot.mjs
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises';

// ---- GHIN auth constants (mirror the mobile app's static values) ------------
const FIREBASE_URL =
  'https://firebaseinstallations.googleapis.com/v1/projects/ghin-mobile-app/installations';
const GOOGLE_API_KEY = 'AIzaSyBxgTOAWxiud0HuaE5tN-5NTlzFnrtyz-I';
const FIREBASE_BODY = {
  appId: '1:884417644529:web:47fb315bc6c70242f72650',
  authVersion: 'FIS_v2',
  fid: 'fg6JfS0U01YmrelthLX9Iz',
  sdkVersion: 'w:0.5.7',
};

const GHIN_API_BASE = 'https://api2.ghin.com/api/v1';
const LOGIN_URL  = `${GHIN_API_BASE}/golfer_login.json`;
const GOLFERS_URL = `${GHIN_API_BASE}/golfers.json`; // search by ghin=<n>

const CLIENT_SOURCE = 'GHINcom';
const UA = 'ghin-friends-snapshot/1.0';

const FRIENDS_PATH = 'friends.json';
const DATA_PATH    = 'data.json';
const TODAY_UTC    = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// ---- helpers ----------------------------------------------------------------
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

function toFloat(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace('+', ''));
  return Number.isFinite(n) ? n : null;
}

async function postJson(url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${url} → ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function getJson(url, accessToken) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'source': CLIENT_SOURCE,
      'User-Agent': UA,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---- auth -------------------------------------------------------------------
async function getFirebaseToken() {
  const res = await postJson(FIREBASE_URL, FIREBASE_BODY, { 'x-goog-api-key': GOOGLE_API_KEY });
  const token = res?.authToken?.token;
  if (!token) throw new Error('Firebase response did not contain authToken.token');
  return token;
}

async function loginGhin(firebaseToken, user, password) {
  const res = await postJson(LOGIN_URL, {
    token: firebaseToken,
    user: { email_or_ghin: user, password },
  });
  const jwt = res?.golfer_user?.golfer_user_token;
  if (!jwt) throw new Error('GHIN login response did not contain golfer_user.golfer_user_token');
  return jwt;
}

// ---- fetch one golfer -------------------------------------------------------
async function fetchGolfer(jwt, ghin) {
  // /golfers.json?ghin=<n>&from_ghin=true returns the matching golfer record
  // including handicap_index, low_hi_value, low_hi_date, club_name, etc.
  const url = `${GOLFERS_URL}?ghin=${encodeURIComponent(ghin)}&from_ghin=true&per_page=1&page=1`;
  const json = await getJson(url, jwt);
  const g = json.golfers?.[0];
  if (!g) throw new Error(`No golfer returned for GHIN ${ghin}`);
  return {
    handicapIndex: toFloat(g.handicap_index ?? g.hi_value),
    lowHi:         toFloat(g.low_hi_value ?? g.low_hi),
    lowHiDate:     g.low_hi_date || null, // YYYY-MM-DD or null
    firstName:     g.first_name || '',
    lastName:      g.last_name  || '',
    clubName:      g.club_name  || '',
  };
}

// ---- data merging -----------------------------------------------------------
function upsertRow(rows, d, i) {
  const existing = rows.find(r => r.d === d);
  if (existing) { existing.i = i; return false; }
  rows.push({ d, i });
  rows.sort((a, b) => a.d.localeCompare(b.d));
  return true;
}

// ---- main -------------------------------------------------------------------
async function main() {
  const user = process.env.GHIN_USER;
  const pass = process.env.GHIN_PASSWORD;
  if (!user || !pass) {
    throw new Error('GHIN_USER and GHIN_PASSWORD env vars are required. See README §"GitHub Secrets".');
  }

  const friends = await loadJson(FRIENDS_PATH, []);
  const data    = await loadJson(DATA_PATH,    { schemaVersion: 1, golfers: {} });
  data.golfers ??= {};

  if (!Array.isArray(friends) || friends.length === 0) {
    console.log('friends.json is empty — nothing to snapshot.');
    data.updatedAt = new Date().toISOString();
    await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
    return;
  }

  console.log('Authenticating to GHIN...');
  const firebaseToken = await getFirebaseToken();
  const jwt = await loginGhin(firebaseToken, user, pass);
  console.log('Authenticated. Fetching', friends.length, 'golfer(s).');

  let okCount = 0;
  let failCount = 0;

  for (const f of friends) {
    if (!f?.ghin) { console.warn('Skipping friend without ghin:', f); continue; }
    try {
      const r = await fetchGolfer(jwt, f.ghin);
      if (r.handicapIndex === null) throw new Error('Response had no handicap_index');

      const fullName = [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || f.name;
      const g = (data.golfers[f.ghin] ??= { name: fullName, club: r.clubName || f.club || '', rows: [] });
      g.name = fullName;
      g.club = r.clubName || f.club || g.club;
      if (r.lowHi !== null) g.lastReportedLow12mo = r.lowHi;
      if (r.lowHiDate) g.lastReportedLowDate = r.lowHiDate;

      // Seed one historical point on first sight: GHIN's own "low handicap"
      // value at its dated low. We only insert it if rows is empty, so we
      // don't pollute existing data on subsequent runs.
      if (g.rows.length === 0 && r.lowHi !== null && r.lowHiDate) {
        upsertRow(g.rows, r.lowHiDate, r.lowHi);
      }

      const added = upsertRow(g.rows, TODAY_UTC, r.handicapIndex);
      console.log(`${added ? '+' : '~'} ${f.ghin} (${fullName}): ${r.handicapIndex}`);
      okCount++;
    } catch (err) {
      console.error(`! ${f.ghin} (${f.name || ''}): ${err.message}`);
      failCount++;
    }
  }

  data.updatedAt = new Date().toISOString();
  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nDone. ${okCount} ok, ${failCount} failed.`);

  if (okCount === 0 && failCount > 0) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
