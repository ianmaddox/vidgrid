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

Output: `data/video-pool.json` (committed so the site works without rebuilding on every deploy).

RSS feeds often 404 now; the build script falls back to scraping the public playlist page (no API key).

## nginx

Host config: `~/appdata/nginx/hosts/vidgrid.tiz.io` → `http://127.0.0.1:8088/`

After editing: `sudo nginx -t && sudo systemctl reload nginx`

## Deploy (legacy S3)

`deploy.sh` syncs to `s3://www.vidgrid.party`. Run `build_feeds.py` before deploy so `data/video-pool.json` is current.
