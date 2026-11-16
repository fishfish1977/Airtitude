// Reads Singapore pump prices from motorist.sg/petrol-prices and writes fuelsg.json.
// Runs on GitHub Actions every few hours. Tries a plain request first, then a real headless browser.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const URLS = ['https://motorist.sg/petrol-prices', 'https://www.motorist.sg/petrol-prices'];
const NAMES = ['Esso', 'Shell', 'SPC', 'Caltex', 'Sinopec'];
const HEAD = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-SG,en;q=0.9',
};

export function parse(html) {
  const hi = Math.max(0, html.indexOf('Compare Pump Prices'));
  const order = [];
  for (const m of html.slice(hi, hi + 9000).matchAll(/esso|shell|spc|caltex|sinopec/gi)) {
    const n = NAMES.find(x => x.toLowerCase() === m[0].toLowerCase());
    if (!order.includes(n)) order.push(n);
    if (order.length === 5) break;
  }
  const retailers = order.length === 5 ? order : NAMES;
  const text = html.slice(hi)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/[–—]/g, '-')
    .replace(/\$\s+/g, '$').replace(/\s+/g, ' ');
  const prices = {};
  for (const g of ['92', '95', '98', 'Premium', 'Diesel']) {
    const m = text.match(new RegExp('(?:^|\\s)' + g + '\\s+((?:(?:\\$\\d+\\.\\d{2}|-)\\s+){5})'));
    if (m) prices[g] = m[1].trim().split(/\s+/).map(v => v === '-' ? null : parseFloat(v.replace('$', '')));
  }
  return Object.keys(prices).length >= 3 ? { retailers, prices } : null;
}

async function viaFetch() {
  for (const u of URLS) {
    try {
      const r = await fetch(u, { headers: HEAD, redirect: 'follow' });
      const t = await r.text();
      const p = r.ok ? parse(t) : null;
      console.log('fetch', u, r.status, t.length, p ? 'parsed' : 'no table');
      if (p) return p;
    } catch (e) { console.log('fetch error', u, e.message); }
  }
  return null;
}

async function viaBrowser() {
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.launch();
    const pg = await b.newPage({ userAgent: HEAD['User-Agent'], locale: 'en-SG' });
    await pg.goto(URLS[0], { waitUntil: 'networkidle', timeout: 45000 });
    const html = await pg.content();
    await b.close();
    const p = parse(html);
    console.log('browser', html.length, p ? 'parsed' : 'no table');
    return p;
  } catch (e) { console.log('browser error', e.message); return null; }
}

if (process.argv[1] && process.argv[1].endsWith('fetch-fuel.mjs')) {
  const p = (await viaFetch()) || (await viaBrowser());
  if (!p) { console.log('No prices read; leaving fuelsg.json unchanged.'); process.exit(0); }
  const old = existsSync('fuelsg.json') ? JSON.parse(readFileSync('fuelsg.json', 'utf8')) : {};
  const changed = JSON.stringify(old.prices) !== JSON.stringify(p.prices);
  const out = { ...p, asOf: new Date().toISOString().slice(0, 10), checked: new Date().toISOString(), live: true, source: 'motorist.sg' };
  writeFileSync('fuelsg.json', JSON.stringify(out, null, 1) + '\n');
  console.log(changed ? 'prices changed' : 'prices unchanged', JSON.stringify(p.prices));
}
