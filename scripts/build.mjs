// Fetches weather, news and market data, then renders a static site into dist/.
// Every section fails independently: a dead source shows a notice instead of breaking the build.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("config.json", root), "utf8"));
const UA = "Mozilla/5.0 (compatible; daily-briefing/1.0; +https://github.com/tzuhao84/Briefing)";

async function get(url, as = "json") {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return as === "json" ? res.json() : res.text();
}

async function settle(label, fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    console.warn(`[${label}] ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------- Weather (Open-Meteo, no key) ----------

const WMO = {
  0: ["Clear", "☀️"], 1: ["Mostly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫️"], 48: ["Freezing fog", "🌫️"],
  51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy drizzle", "🌧️"],
  56: ["Freezing drizzle", "🌧️"], 57: ["Freezing drizzle", "🌧️"],
  61: ["Light rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  66: ["Freezing rain", "🌧️"], 67: ["Freezing rain", "🌧️"],
  71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "❄️"], 77: ["Snow grains", "🌨️"],
  80: ["Showers", "🌦️"], 81: ["Showers", "🌧️"], 82: ["Violent showers", "⛈️"],
  85: ["Snow showers", "🌨️"], 86: ["Snow showers", "❄️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm, hail", "⛈️"], 99: ["Thunderstorm, hail", "⛈️"],
};
const wmo = (code) => WMO[code] ?? ["—", "🌡️"];

async function fetchWeather() {
  const w = config.weather;
  const params = new URLSearchParams({
    latitude: w.latitude,
    longitude: w.longitude,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    temperature_unit: w.units === "fahrenheit" ? "fahrenheit" : "celsius",
    wind_speed_unit: w.units === "fahrenheit" ? "mph" : "kmh",
    timezone: config.timezone,
    forecast_days: 5,
  });
  const d = await get(`https://api.open-meteo.com/v1/forecast?${params}`);
  return {
    unit: d.current_units.temperature_2m,
    windUnit: d.current_units.wind_speed_10m,
    current: d.current,
    days: d.daily.time.map((date, i) => ({
      date,
      code: d.daily.weather_code[i],
      max: d.daily.temperature_2m_max[i],
      min: d.daily.temperature_2m_min[i],
      rain: d.daily.precipitation_probability_max[i],
      sunrise: d.daily.sunrise[i],
      sunset: d.daily.sunset[i],
    })),
  };
}

// ---------- News (RSS / Atom) ----------

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

export function parseFeed(xml, limit) {
  const items = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].slice(0, limit);
  return items.map(([block]) => {
    const atomLink = block.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    return {
      title: tag(block, "title"),
      link: tag(block, "link") || atomLink || "",
      date: tag(block, "pubDate") || tag(block, "updated") || tag(block, "published"),
    };
  }).filter((i) => i.title && /^https?:\/\//.test(i.link));
}

const fetchNews = () =>
  Promise.all(config.news.feeds.map(async (feed) => ({
    name: feed.name,
    ...(await settle(`news:${feed.name}`, async () => parseFeed(await get(feed.url, "text"), config.news.itemsPerFeed))),
  })));

// ---------- Markets (Yahoo Finance chart data for stocks, CoinGecko for crypto; both keyless) ----------

async function fetchStock({ symbol, name }) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const d = await get(`https://query1.finance.yahoo.com${path}`).catch(() => get(`https://query2.finance.yahoo.com${path}`));
  const r = d.chart?.result?.[0];
  if (!r) throw new Error(`no data for ${symbol}`);
  // Last ~10 daily closes for the sparkline; the change is against the previous session's close.
  const closes = (r.indicators.quote[0].close ?? []).filter((c) => c != null).slice(-10);
  const price = r.meta.regularMarketPrice ?? closes.at(-1);
  const prev = closes.length >= 2 ? closes.at(-2) : r.meta.chartPreviousClose;
  const asOf = new Date(r.meta.regularMarketTime * 1000).toISOString().slice(0, 10);
  return { symbol, name, price, change: ((price - prev) / prev) * 100, spark: closes, asOf };
}

async function fetchCrypto() {
  const list = config.markets.crypto;
  if (!list.length) return [];
  const ids = list.map((c) => c.id).join(",");
  const d = await get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
  return list.filter((c) => d[c.id]).map((c) => ({
    symbol: c.symbol, name: c.name, price: d[c.id].usd, change: d[c.id].usd_24h_change,
  }));
}

async function fetchMarkets() {
  const stocks = await Promise.all(config.markets.stocks.map((s) => settle(`stock:${s.symbol}`, () => fetchStock(s))));
  const crypto = await settle("crypto", fetchCrypto);
  return {
    stocks: stocks.filter((s) => s.ok).map((s) => s.data),
    stocksFailed: stocks.filter((s) => !s.ok).length,
    crypto,
  };
}

// ---------- Rendering ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const tz = config.timezone;
const fmt = (d, opts) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(d);
const money = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 10 ? 4 : 2 });
const pct = (n) => `${n >= 0 ? "▲" : "▼"} ${Math.abs(n).toFixed(2)}%`;
const notice = (msg) => `<p class="notice">${esc(msg)}</p>`;
// Open-Meteo returns local times without an offset ("2026-10-26T07:12"); show them as-is.
const clock = (iso) => iso.slice(11, 16);

function sparkline(values) {
  const w = 80, h = 24, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.join(" ")}"/></svg>`;
}

function renderWeather(r) {
  if (!r.ok) return notice("Weather is unavailable right now.");
  const { current: c, days, unit, windUnit } = r.data;
  const [label, icon] = wmo(c.weather_code);
  const today = days[0];
  const forecast = days.slice(1).map((d) => {
    const [l, i] = wmo(d.code);
    const day = fmt(new Date(`${d.date}T12:00:00Z`), { weekday: "short", timeZone: "UTC" });
    return `<li><span class="day">${day}</span><span class="ico" title="${esc(l)}">${i}</span><span>${Math.round(d.max)}° / ${Math.round(d.min)}°</span></li>`;
  }).join("");
  return `
    <div class="now">
      <span class="big-ico">${icon}</span>
      <div>
        <div class="temp">${Math.round(c.temperature_2m)}${esc(unit)}</div>
        <div class="muted">${esc(label)} · feels ${Math.round(c.apparent_temperature)}°</div>
      </div>
    </div>
    <dl class="facts">
      <div><dt>High / Low</dt><dd>${Math.round(today.max)}° / ${Math.round(today.min)}°</dd></div>
      <div><dt>Rain chance</dt><dd>${today.rain ?? 0}%</dd></div>
      <div><dt>Humidity</dt><dd>${c.relative_humidity_2m}%</dd></div>
      <div><dt>Wind</dt><dd>${Math.round(c.wind_speed_10m)} ${esc(windUnit)}</dd></div>
      <div><dt>Sunrise</dt><dd>${clock(today.sunrise)}</dd></div>
      <div><dt>Sunset</dt><dd>${clock(today.sunset)}</dd></div>
    </dl>
    <ul class="forecast">${forecast}</ul>`;
}

function renderNews(feeds) {
  return feeds.map((f) => `
    <section class="feed">
      <h3>${esc(f.name)}</h3>
      ${!f.ok ? notice("Feed unavailable.") : !f.data.length ? notice("No stories.") : `<ol>${f.data.map((i) =>
        `<li><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a></li>`).join("")}</ol>`}
    </section>`).join("");
}

function quoteRow(q) {
  const dir = q.change >= 0 ? "up" : "down";
  return `<tr>
    <td><strong>${esc(q.symbol)}</strong><span class="muted">${esc(q.name)}</span></td>
    <td class="spark-cell">${q.spark ? sparkline(q.spark) : ""}</td>
    <td class="num">${money(q.price)}</td>
    <td class="num ${dir}">${Number.isFinite(q.change) ? pct(q.change) : "—"}</td>
  </tr>`;
}

function renderMarkets(m) {
  const stocks = m.stocks.length
    ? `<table><caption>Stocks · as of${m.stocks[0].asOf ? ` ${esc(m.stocks[0].asOf)}` : ""}</caption>${m.stocks.map(quoteRow).join("")}</table>`
    : "";
  const crypto = m.crypto.ok && m.crypto.data.length
    ? `<table><caption>Crypto · 24h</caption>${m.crypto.data.map(quoteRow).join("")}</table>`
    : "";
  const missing = [];
  if (m.stocksFailed) missing.push(`${m.stocksFailed} stock quote(s)`);
  if (!m.crypto.ok) missing.push("crypto prices");
  return (stocks + crypto + (missing.length ? notice(`Couldn't load ${missing.join(" and ")}.`) : "")) || notice("Market data is unavailable right now.");
}

function render({ weather, news, markets, now }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>☕</text></svg>">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
  <div>
    <p class="eyebrow">${esc(config.title)}</p>
    <h1>${fmt(now, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</h1>
  </div>
  <p class="updated muted">Updated ${fmt(now, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</p>
</header>
<main>
  <section class="card weather"><h2>Weather · ${esc(config.weather.name)}</h2>${renderWeather(weather)}</section>
  <section class="card markets"><h2>Markets</h2>${renderMarkets(markets)}</section>
  <section class="card news"><h2>Headlines</h2><div class="feeds">${renderNews(news)}</div></section>
</main>
<footer class="muted">Weather: Open-Meteo · Stocks: Yahoo Finance · Crypto: CoinGecko · News: RSS. Rebuilt automatically by GitHub Actions.</footer>
</body>
</html>
`;
}

// ---------- Main ----------

const now = new Date();
const [weather, news, markets] = await Promise.all([settle("weather", fetchWeather), fetchNews(), fetchMarkets()]);

const dist = new URL("dist/", root);
await mkdir(dist, { recursive: true });
await writeFile(new URL("index.html", dist), render({ weather, news, markets, now }));
await writeFile(new URL("data.json", dist), JSON.stringify({ generatedAt: now.toISOString(), weather, news, markets }, null, 2));
await copyFile(new URL("src/style.css", root), new URL("style.css", dist));
console.log(`Built dist/ at ${now.toISOString()}`);
