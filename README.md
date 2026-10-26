# Briefing

A personal daily dashboard: weather, market prices, and news headlines on one page.

Live site: https://tzuhao84.github.io/Briefing/

## How it works

`scripts/build.mjs` (Node 22, no dependencies) fetches data from keyless public sources and renders a static page into `dist/`:

| Section  | Source |
|----------|--------|
| Weather  | [Open-Meteo](https://open-meteo.com/) |
| Stocks   | [Stooq](https://stooq.com/) daily closes |
| Crypto   | [CoinGecko](https://www.coingecko.com/) |
| News     | RSS feeds (BBC, Hacker News by default) |

The GitHub Actions workflow in `.github/workflows/pages.yml` rebuilds the site and deploys it to GitHub Pages on every push to `main`, every 3 hours, and on demand (**Actions → Build and deploy briefing → Run workflow**). If a source fails, only that section shows a notice.

## Customize

Edit `config.json`:

- `timezone`: IANA zone for the date and update time (e.g. `Asia/Taipei`)
- `weather`: city name, `latitude`, `longitude`, and `units` (`celsius` or `fahrenheit`)
- `news.feeds`: any RSS or Atom feed URLs
- `markets.stocks`: US tickers; `markets.crypto`: CoinGecko coin IDs

## Run locally

```sh
node scripts/build.mjs
open dist/index.html
```

## One-time setup

In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.
