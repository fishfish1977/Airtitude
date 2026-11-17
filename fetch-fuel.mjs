// Builds data/fuelsg.json (Singapore posted pump prices) once a day.
// Sources: each fuel brand's own public price page. Nothing here hides what it is:
//  - it identifies itself with an honest User-Agent,
//  - it reads robots.txt and skips a page that disallows it,
//  - it makes at most one page request per brand per run.
// A brand that cannot be read keeps its last good price and is marked stale.
// data/fuel-manual.json lets a person correct any brand by hand (newer asOf wins).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const UA = 'AirtitudeBot/1.0 (+https://fishfish1977.github.io/Airtitude/; daily pump-price check)';
const RETAILERS = ['Esso', 'Shell', 'SPC', 'Caltex', 'Sinopec'];
const GRADES = ['92', '95', '98', 'Premium', 'Diesel'];

// Page addresses are best guesses until the first run shows which ones parse (see the Action log).
// Add or correct addresses here; the job tries them in order.
const SOURCES = {
  Shell: ['https://www.shell.com.sg/fuels-oils-and-coolants/shell-fuels/shell-station-price-board.html'],
  Esso: ['https://www.esso.com.sg/en-sg/pump-prices'],
  Caltex: ['https://www.caltex.com/sg/motorists/products-and-services/fuel-prices.html'],
  SPC: ['https://www.spc.com.sg/pump-prices'],
  Sinopec: ['https://www.sinopecsg.com/fuel-prices'],
};

// Words each brand uses for a grade. First match per grade wins; the price must follow within 120 characters.
const GRADE_WORDS = {
  '92': [/\b(?:92|RON\s*92)\b/i],
  '95': [/\b(?:95|RON\s*95)\b/i],
  '98': [/\b(?:98|RON\s*98)\b/i],
  'Premium': [/V-?Power/i, /Platinum/i, /Synergy\s*Supreme\+?/i, /Ultimate/i, /Premium/i],
  'Diesel': [/Diesel/i],
};

function textOf(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\$\s+/g, '$').replace(/\s+/g, ' ');
}

export function parsePage(html) {
  const t = textOf(html);
  const out = {};
  for (const g of GRADES) {
    for (const re of GRADE_WORDS[g]) {
      const m = re.exec(t);
      if (!m) continue;
      const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 120);
      const p = tail.match(/\$?\s*(\d\.\d{2,3})\b/);
      if (p) { const v = parseFloat(p[1]); if (v >= 1.5 && v <= 8) { out[g] = Math.round(v * 100) / 100; break; } }
    }
  }
  return Object.keys(out).length >= 2 ? out : null;   // need at least two grades to trust a page
}

async function allowedByRobots(url) {
  try {
    const u = new URL(url);
    const r = await fetch(u.origin + '/robots.txt', { headers: { 'User-Agent': UA } });
    if (!r.ok) return true;
    const lines = (await r.text()).split('\n').map(l => l.split('#')[0].trim());
    let applies = false, disallow = [];
    for (const l of lines) {
      const [k, ...rest] = l.split(':'); const v = rest.join(':').trim();
      if (/^user-agent$/i.test(k)) applies = v === '*' || /airtitudebot/i.test(v);
      else if (applies && /^disallow$/i.test(k) && v) disallow.push(v);
    }
    return !disallow.some(d => u.pathname.startsWith(d));
  } catch { return true; }
}

async function viaFetch(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}
async function viaBrowser(url) {
  // Renders a public page whose prices are filled in by JavaScript. Same honest user agent.
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  try {
    const pg = await b.newPage({ userAgent: UA, locale: 'en-SG' });
    await pg.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    return await pg.content();
  } finally { await b.close(); }
}

async function readBrand(name, useBrowser) {
  for (const url of SOURCES[name] || []) {
    if (!(await allowedByRobots(url))) { console.log(name, url, 'skipped: robots.txt disallows'); continue; }
    for (const how of useBrowser ? ['fetch', 'browser'] : ['fetch']) {
      try {
        const html = how === 'fetch' ? await viaFetch(url) : await viaBrowser(url);
        const p = parsePage(html);
        console.log(name, how, url, p ? 'parsed ' + JSON.stringify(p) : 'no prices found');
        if (p) return { prices: p, url };
      } catch (e) { console.log(name, how, url, 'error', e.message); }
    }
  }
  return null;
}

if (process.argv[1] && process.argv[1].endsWith('fetch-fuel.mjs')) {
  const useBrowser = process.argv.includes('--browser');
  const file = 'data/fuelsg.json';
  const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { retailers: RETAILERS, prices: {}, brands: {} };
  const manual = existsSync('data/fuel-manual.json') ? JSON.parse(readFileSync('data/fuel-manual.json', 'utf8')) : {};
  const today = new Date().toISOString().slice(0, 10);
  const brands = old.brands || {};
  const prices = JSON.parse(JSON.stringify(old.prices || {}));

  for (let i = 0; i < RETAILERS.length; i++) {
    const name = RETAILERS[i];
    const got = await readBrand(name, useBrowser);
    const man = manual[name];
    if (got) {
      for (const g of GRADES) {
        const v = got.prices[g];
        const prev = prices[g]?.[i];
        // reject a jump of more than 40 cents in one day as a probable parsing error
        if (v != null && (prev == null || Math.abs(v - prev) <= 0.40)) { prices[g] = prices[g] || [null, null, null, null, null]; prices[g][i] = v; }
        else if (v != null) console.log(name, g, 'ignored suspicious jump', prev, '->', v);
      }
      brands[name] = { asOf: today, status: 'live', source: got.url };
    } else if (!brands[name]) brands[name] = { asOf: old.asOf || null, status: 'seed', source: null };
    else if (brands[name].status === 'live') brands[name].status = 'stale';
    if (man && man.asOf && (!brands[name].asOf || man.asOf >= brands[name].asOf) && man.prices) {
      for (const g of GRADES) if (g in man.prices) { prices[g] = prices[g] || [null, null, null, null, null]; prices[g][i] = man.prices[g]; }
      brands[name] = { asOf: man.asOf, status: 'manual', source: man.source || 'verified by hand' };
    }
  }
  const asOfs = Object.values(brands).map(b => b.asOf).filter(Boolean).sort();
  const out = { retailers: RETAILERS, prices, brands, asOf: asOfs[0] || today, checked: new Date().toISOString(), live: Object.values(brands).some(b => b.status === 'live' || b.status === 'manual'), source: 'brand websites' };
  writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  console.log('written', JSON.stringify(brands));
}
