# Catholic Prayers — GitHub Pages

This project is a plain HTML/CSS/JavaScript Catholic prayer website.

## License

Copyright (C) 2026 Adrian Arroyo

This project is licensed under the GNU General Public License v3.0 or later. See the [LICENSE](LICENSE) file for the full text.

## Faithful Departed Novena
The page `novena/faithful-departed.html` is based on the photographed booklet supplied by the site owner. It includes:
- Opening prayer for the departed soul
- Five Sorrowful Mysteries
- Apostle's Creed
- Our Father / Hail Mary / Glory Be section
- Litany of the Faithful Departed
- Intercessions and Lamb of God responses
- Three “Let Us Pray” prayers
- Closing responses
- A nine-day progress tracker and deceased-name field saved in the browser

The booklet presents one prayer sequence rather than separate prayers for each day, so the website repeats the complete sequence across nine days rather than inventing different daily texts.

Open `index.html` to run the site. No build step is required for GitHub Pages.

## Uploading to GitHub

Upload the contents of this folder while preserving the hidden `.github` directory. The workflow must be located at `.github/workflows/update-daily-content.yml`; a `workflows/update-daily-content.yml` file at the repository root will not be recognized by GitHub Actions.

## Live daily content (client-side)

`index.html`, `gospel.html`, and `videos.html` load `daily-content.js`, a client-side module that refreshes the day's verse, Gospel reading, reflection, and Full Tank video on every page load. Results are cached in `localStorage` by visitor region and visitor-local ISO date, so a reload on the same day is instant without allowing content from another region to leak into the page.

Live sources used by `daily-content.js`:

- `https://bible-api.com/{passage}?translation=kjv` — public-domain King James text for the verse and Gospel. The reference for the day comes from `data/daily-gospel.json` and `data/daily-verse.json`, so the same liturgical reference is rendered each day.
- `https://www.youtube.com/feeds/videos.xml?playlist_id=PLA_KgzimUIuXyOcP5WtOYLwdCogSXYdgz` — YouTube playlist RSS feed. The module picks the most recent video whose `<published>` is within the last 36 hours, so a video uploaded late yesterday still counts as today's.
- `reflect.md` — parsed for the `## Month D, YYYY` section that matches today.

When the live sources are unreachable, the module falls back to the static `data/*.json` files, then to a placeholder string, so the page always renders something.

## Date-specific Full Tank videos
The Videos page reads from the YouTube playlist RSS feed live (see above). The legacy pipeline below is kept as a backup; running it requires a remote git repository with the workflow secrets configured.

```sh
VIDEO_DATE=2026-08-23 python3 scripts/update_videos.py
```

With the optional `YOUTUBE_API_KEY`, the legacy updater also checks each playlist item's actual YouTube upload timestamp and stores top-level comments published on that upload date. Keep the API key out of the repository.

The workflow `.github/workflows/update-daily-content.yml` runs this refresh daily at 00:15 UTC and can also be started manually. The updater uses UTC for its source date, while `daily-content.js` uses the visitor's browser time zone for the displayed day and cache boundary. Add the YouTube key as the repository secret `YOUTUBE_API_KEY` so the scheduled video update can run. With no remote repository or with GitHub Actions disabled, the workflow is dormant and the browser uses the most recent generated records.


## Daily Gospel image
The Daily Gospel card uses a public-domain/CC0 artwork from Wikimedia Commons (Metropolitan Museum of Art) depicting Christ teaching the disciples.


### Daily Gospel full text
The Vatican News page is used to identify the day's liturgical Gospel reference (this is the value stored in `data/daily-gospel.json` and refreshed by the legacy `update_daily_content.py` script). The complete reading displayed on `gospel.html` is fetched live in the public-domain King James Version through bible-api.com, rather than copying the copyrighted lectionary wording from Vatican News.

## Location-aware daily content
The homepage, Gospel, and Videos pages load `data/location-content.json` through `location-content.js`. The site only uses a coarse region: an aggregation endpoint is preferred, then the configured IP-country endpoint identifies a broad country, and finally the browser's language/time zone is used as a local fallback. The browser time zone is captured once per page load and is used as the shared daily boundary for every content field. No precise location is requested or stored by the site.

To connect an aggregation service, set `aggregationEndpoint` in `data/location-content.json` or define `window.PRAYER_LOCATION_ENDPOINT` before loading `location-content.js`. The endpoint should return JSON shaped like:

```json
{
	"region": "us"
}
```

The region must match a key in `regions`. Each region block in `regions` may override any daily field with `verse`, `reflection`, `gospel`, or `video`. The merge precedence (highest first) is:

1. The per-region block in `data/location-content.json`.
2. The configured `aggregationEndpoint` (its response is merged on top of the region block by `PrayerLocationContent.merge`).
3. The live API fetch.
4. The static `data/*.json` fallback.

Supported per-field shape:

- `verse: { date, reference, text, translation }`
- `reflection: { date, text, source }`
- `gospel: { date, reference, text, translation }`
- `video: { date, id, title }`

Regional overrides without a matching `date` are ignored, which keeps placeholder content from replacing the current daily records.

The endpoint should aggregate coarse location server-side and return only the selected region and content; it should not expose visitor identifiers. The current per-region blocks in `data/location-content.json` are placeholders that mirror the global daily content; replace them with regionally-appropriate text from a Catholic content team.

## Reflection source

`reflect.md` contains 365 entries from the Didache 2026 booklet, one per day from January 1 through December 31, 2026. The client reads it on every page load and parses the `## Month D, YYYY` section for today. After December 31, 2026 the file will go silent; replace or extend it before then.
