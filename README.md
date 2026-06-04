# VidGrid

A wall of simultaneous YouTube embeds — random videos from curated playlists.

## Setup

```bash
conda activate grid_trader
cd /home/ian/code/vidgrid

# Edit playlist IDs (PL… from ?list= in the YouTube URL)
vim data/playlists.txt

python scripts/build_feeds.py
python serve.py
```

Open http://127.0.0.1:8088/ on the server, or https://vidgrid.tiz.io/ (nginx proxies to port 8088; `lan_auth` applies).

```bash
./scripts/smoke_test.sh
```

## Playlists

Add one playlist ID per line in `data/playlists.txt`, then rebuild:

```bash
python scripts/build_feeds.py
```

Output:

- `data/video-pool.json` — **index** only (`manifestDir`, `playlists[]` with `id`, `title`,
  `manifest`, `videoCount`)
- `data/playlists/<PL_ID>.json` — per-playlist manifest (`videoIds`, `videos` metadata map)

Committed so the site works without rebuilding on every deploy. The wall loads the index first,
then fetches **one** manifest for the active playlist (or when you switch themes).

**Custom titles:** Edit `title` in the index or manifest. Rebuilds keep your title when it is
non-blank; only empty titles are refreshed from YouTube.

To split an existing monolithic `video-pool.json` without re-scraping YouTube:

```bash
python scripts/build_feeds.py --split-existing
```

The build script fetches each video's **watch page** and records metadata in each manifest's
`videos` map:

| Field | Source | Use |
|-------|--------|-----|
| `width`, `height`, `aspectRatio` | `streamingData` formats (best resolution) | Cover-fit sizing in the wall |
| `aspectSource` | `streaming`, `oembed`, or `default` | How aspect was derived |
| `title`, `author`, `durationSeconds` | `videoDetails` | Info / debugging |
| `embeddable`, `playability` | `playabilityStatus` | Skip blocked embeds at runtime |
| `category` | microformat | Optional context |

If streaming dimensions are missing, **oEmbed** thumbnail size is used (can differ from video). Fallback is 16:9.

```bash
# Faster rebuild without metadata (IDs only)
python scripts/build_feeds.py --skip-metadata

# Backfill: reuse every videos{} entry in data/playlists/, fetch only missing IDs
python scripts/build_feeds.py --metadata-delay 1.0

# Re-fetch watch-page metadata for every video (ignore cache)
python scripts/build_feeds.py --refresh-metadata

# Keep deleted / non-embeddable / unplayable entries in playlists
python scripts/build_feeds.py --keep-unavailable
```

**Default metadata behavior is backfill-only.** Any video already in a manifest’s `videos`
map is kept as-is (including partial oEmbed/429 entries). Only IDs with no cached metadata
are watch-page fetched. Avoid `--refresh-metadata` and `--no-metadata-cache` unless you
want to re-pull everything.

By default the builder **filters unavailable videos** from each playlist when the
watch page reports `embeddable=false` or `playability` not `OK`. A watch-page HTTP 429
(rate limit) does **not** remove videos — oEmbed title/size is kept and the wall filters
at runtime. For ~2000 videos use a slower delay, e.g.
`python scripts/build_feeds.py --metadata-delay 1.0`.

RSS feeds often 404 now; playlist IDs are also scraped from the public playlist page (no API key).

## nginx

Host config: `~/appdata/nginx/hosts/vidgrid.tiz.io` → `http://127.0.0.1:8088/`

After editing: `sudo nginx -t && sudo systemctl reload nginx`

## Deploy (legacy S3)

`deploy.sh` syncs to `s3://www.vidgrid.party`. Run `build_feeds.py` before deploy so `data/video-pool.json` is current.
