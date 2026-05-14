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
  // Fastest path: if ghin is already known, look up directly.
  if (f.ghin) {
    const results = await searchGolfers(jwt, { ghin: f.ghin, from_ghin: 'true' });
    if (!results.length) throw new Error(`No golfer for GHIN ${f.ghin}`);
    return results[0];
  }

  const { firstName, lastName } = splitName(f.name);
  if (!lastName) throw new Error('Entry has no usable name');

  // Search by first + last name. global_search=true is required by GHIN for
  // non-GHIN-number searches. Country defaults to USA (only US is on GHIN).
  let results = await searchGolfers(jwt, {
    global_search: 'true',
    first_name:    firstName,
    last_name:     lastName,
    country:       f.country || 'USA',
    status:        'Active',
  });

  // If user typed a nickname (e.g. "Kev" vs "Kevin"), the API may miss.
  // Retry without first_name and locally filter by first-name-startsWith.
  if (results.length === 0 && firstName) {
    const broad = await searchGolfers(jwt, {
      global_search: 'true',
      last_name:     lastName,
      country:       f.country || 'USA',
      status:        'Active',
    });
    const fn = firstName.toLowerCase();
    results = broad.filter(g => (g.first_name || '').toLowerCase().startsWith(fn));
  }

  // Narrow by club name. With no state filter, club is our main disambiguator.
  if (f.club && results.length > 1) {
    const narrowed = results.filter(g => clubMatches(g.club_name, f.club));
    if (narrowed.length) results = narrowed;
  }

  if (results.length === 0) {
    throw new Error(`No GHIN match for "${f.name}"${f.club ? ' at "' + f.club + '"' : ''}`);
  }
  if (results.length > 1) {
    const sample = results.slice(0, 3)
      .map(g => `${g.first_name} ${g.last_name} @ ${g.club_name || '?'} (GHIN ${g.ghin})`)
      .join('; ');
    throw new Error(`Ambiguous: ${results.length} matches for "${f.name}". Refine club name. First few: ${sample}`);
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

      // Enrich friends entry with resolved ghin so future runs skip search.
      if (!f.ghin) {
        friends[idx] = { ghin: ghinKey, ...f };
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
  if (okCount === 0 && failCount > 0) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
