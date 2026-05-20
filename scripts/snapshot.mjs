// Daily snapshot fetcher — runs on GitHub Actions (Node 20+).
//
// Looks up each friend in friends.json by name + club (no GHIN# needed),
// fetches their current handicap index, appends today's row to data.json.
//
// Once a friend is resolved, the GHIN# is written back into friends.json so
// future runs skip the search step (faster + more reliable).
//
// Auth: see README. Requires GHIN_USER + GHIN_PASSWORD env vars (GitHub Secrets).
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
const LOGIN_URL    = `${GHIN_API_BASE}/golfer_login.json`;
const GOLFERS_URL  = `${GHIN_API_BASE}/golfers.json`;

const CLIENT_SOURCE = 'GHINcom';
const UA = 'ghin-friends-snapshot/1.0';

const FRIENDS_PATH = 'friends.json';
const DATA_PATH    = 'data.json';
const TODAY_UTC    = new Date().toISOString().slice(0, 10);

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

// ---- search / resolve -------------------------------------------------------
function splitName(s) {
  const parts = (s || '').trim().split(/\s+/);
  if (parts.length === 1) return { firstName: '', lastName: parts[0] || '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

const CLUB_NOISE = /\b(country club|golf club|the|cc|gc|gcc)\b/gi;
function clubMatches(a, b) {
  if (!a || !b) return false;
  const na = a.toLowerCase().replace(CLUB_NOISE, '').replace(/\s+/g, ' ').trim();
  const nb = b.toLowerCase().replace(CLUB_NOISE, '').replace(/\s+/g, ' ').trim();
  return !!na && !!nb && (na.includes(nb) || nb.includes(na));
}

async function searchGolfers(jwt, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  q.set('per_page', '100');
  q.set('page', '1');
  const url = `${GOLFERS_URL}?${q.toString()}`;
  const json = await getJson(url, jwt);
  return json.golfers || [];
}

async function resolveFriend(jwt, f) {
  // Always look up by name + club + (optional) state. The GHIN value stored on
  // a friend entry is the API's masked privacy string and is NOT a usable
  // lookup key — disambiguation must happen at add-time in the PWA.

  // Prefer stored first/last (set at add-time by the PWA picker). Fall back to
  // splitting `name` for legacy entries that predate the picker.
  let firstName = (f.first_name || '').trim();
  let lastName  = (f.last_name  || '').trim();
  if (!lastName) {
    const split = splitName(f.name);
    firstName = split.firstName;
    lastName  = split.lastName;
  }
  if (!lastName) throw new Error('Entry has no usable name');

  const searchText = (f.first_name && f.last_name)
    ? `${f.first_name} ${f.last_name}`
    : (f.name || lastName).trim();

  let results = await searchGolfers(jwt, {
    global_search: 'true',
    search:        searchText,
    country:       f.country || 'USA',
    status:        'Active',
  });

  // Strict last-name + first-name-prefix filter.
  const fn = firstName.toLowerCase();
  const ln = lastName.toLowerCase();
  results = results.filter(g =>
    (g.last_name || '').toLowerCase() === ln &&
    (!fn || (g.first_name || '').toLowerCase().startsWith(fn))
  );

  // If the user picked at add-time, club_id is the most reliable narrow.
  if (f.club_id != null && results.length > 1) {
    const narrowed = results.filter(g => String(g.club_id) === String(f.club_id));
    if (narrowed.length) results = narrowed;
  }

  // State is a strong narrow when stored.
  if (f.state && results.length > 1) {
    const narrowed = results.filter(g =>
      (g.state || '').toLowerCase() === f.state.toLowerCase()
    );
    if (narrowed.length) results = narrowed;
  }

  // Final narrow by club name substring.
  if (f.club && results.length > 1) {
    const narrowed = results.filter(g => clubMatches(g.club_name, f.club));
    if (narrowed.length) results = narrowed;
  }

  if (results.length === 0) {
    throw new Error(`No GHIN match for "${f.name || searchText}"${f.club ? ' at "' + f.club + '"' : ''}`);
  }
  if (results.length > 1) {
    const sample = results.slice(0, 3)
      .map(g => `${g.first_name} ${g.last_name} @ ${g.club_name || '?'} (${g.state || '?'})`)
      .join('; ');
    throw new Error(`Ambiguous: ${results.length} matches for "${f.name || searchText}". Re-add in the app to pick the right one. First few: ${sample}`);
  }
  return results[0];
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
  console.log('Authenticated. Resolving', friends.length, 'friend(s).');

  let okCount = 0, failCount = 0, friendsChanged = false;

  for (let idx = 0; idx < friends.length; idx++) {
    const f = friends[idx];
    if (!f) continue;
    try {
      const g = await resolveFriend(jwt, f);
      const ghinKey = String(g.ghin);

      // Enrich friends entry with resolved identifying fields so future runs
      // can narrow the search precisely without re-disambiguating.
      const enriched = {
        ghin:       ghinKey,
        first_name: g.first_name || f.first_name,
        last_name:  g.last_name  || f.last_name,
        name:       f.name || [g.first_name, g.last_name].filter(Boolean).join(' '),
        club:       f.club || g.club_name || '',
        club_id:    g.club_id ?? f.club_id,
        state:      g.state || f.state,
        country:    f.country || 'USA',
      };
      const before = JSON.stringify(f);
      const after  = JSON.stringify({ ...f, ...enriched });
      if (before !== after) {
        friends[idx] = { ...f, ...enriched };
        friendsChanged = true;
      }

      const fullName = [g.first_name, g.last_name].filter(Boolean).join(' ').trim() || f.name;
      const clubName = g.club_name || f.club || '';
      const hi       = toFloat(g.handicap_index ?? g.hi_value);
      const lowHi    = toFloat(g.low_hi_value ?? g.low_hi);

      if (hi === null) throw new Error('Response had no handicap_index');

      const entry = (data.golfers[ghinKey] ??= { name: fullName, club: clubName, rows: [] });
      entry.name = fullName;
      entry.club = clubName;
      if (lowHi !== null) entry.lastReportedLow12mo = lowHi;
      if (g.low_hi_date)  entry.lastReportedLowDate = g.low_hi_date;

      // First-sight backfill: seed GHIN's own low-handicap point on first run.
      if (entry.rows.length === 0 && lowHi !== null && g.low_hi_date) {
        upsertRow(entry.rows, g.low_hi_date, lowHi);
      }

      const added = upsertRow(entry.rows, TODAY_UTC, hi);
      console.log(`${added ? '+' : '~'} ${ghinKey} (${fullName}): ${hi}`);
      okCount++;
    } catch (err) {
      console.error(`! ${f.name || '(unnamed)'}: ${err.message}`);
      failCount++;
    }
  }

  data.updatedAt = new Date().toISOString();
  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');

  if (friendsChanged) {
    await writeFile(FRIENDS_PATH, JSON.stringify(friends, null, 2) + '\n');
    console.log('Enriched friends.json with resolved GHIN numbers.');
  }

  console.log(`\nDone. ${okCount} ok, ${failCount} failed.`);
  // Exit non-zero only if EVERYTHING failed AND no history exists — that
  // usually means auth or network broke, which is worth a red workflow. If
  // any friend succeeded, or we already have history to chart, individual
  // failures are logged but the workflow stays green so resolvable friends
  // keep accumulating data.
  const haveHistory = Object.keys(data.golfers || {}).length > 0;
  if (okCount === 0 && failCount > 0 && !haveHistory) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
