#!/usr/bin/env python3
"""Build data/video-pool.json (index) and per-playlist manifests under data/playlists/."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAYLISTS_PATH = ROOT / "data" / "playlists.txt"
OUTPUT_PATH = ROOT / "data" / "video-pool.json"
MANIFESTS_DIR = ROOT / "data" / "playlists"
MANIFEST_WEB_DIR = "playlists"
RSS_URL = "https://www.youtube.com/feeds/videos.xml?playlist_id={playlist_id}"
PLAYLIST_PAGE_URL = "https://www.youtube.com/playlist?list={playlist_id}"
WATCH_URL = "https://www.youtube.com/watch?v={video_id}"
USER_AGENT = "Mozilla/5.0 (compatible; vidgrid-build-feeds/1.0)"
ATOM_NS = "http://www.w3.org/2005/Atom"
YT_NS = "http://www.youtube.com/xml/schemas/2015"
PLAYLIST_ID_RE = re.compile(r"^PL[\w-]+$")
VIDEO_ID_RE = re.compile(r"(?:v=|/shorts/|youtu\.be/)([A-Za-z0-9_-]{11})")
PAGE_VIDEO_ID_RE = re.compile(r'"videoId":"([A-Za-z0-9_-]{11})"')
PAGE_TITLE_RE = re.compile(r'<meta name="title" content="([^"]+)"')
PLAYER_RESPONSE_MARKER = "ytInitialPlayerResponse"
REUSABLE_ASPECT_SOURCES = frozenset({"streaming", "oembed"})
PLAYABILITY_OK = "OK"


def log(message: str) -> None:
    print(message, flush=True)


def load_playlist_ids(path: Path) -> list[str]:
    ids: list[str] = []
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            ids.append(line)
    return ids


def fetch_url(url: str, retries: int = 3) -> bytes:
    last_exc: urllib.error.HTTPError | None = None
    for attempt in range(retries):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            last_exc = exc
            if exc.code == 429 and attempt < retries - 1:
                wait = min(60, 2 ** (attempt + 2))
                log(f"  rate limited (429), waiting {wait}s before retry ...")
                time.sleep(wait)
                continue
            raise
    if last_exc:
        raise last_exc
    raise RuntimeError("fetch_url failed without exception")


def fetch_playlist_xml(playlist_id: str) -> bytes:
    return fetch_url(RSS_URL.format(playlist_id=playlist_id))


def video_id_from_link(link: str) -> str | None:
    match = VIDEO_ID_RE.search(link)
    return match.group(1) if match else None


def parse_playlist_xml(xml_bytes: bytes, playlist_id: str) -> tuple[str, list[str]]:
    root = ET.fromstring(xml_bytes)
    title_el = root.find(f"{{{ATOM_NS}}}title")
    title = title_el.text.strip() if title_el is not None and title_el.text else playlist_id

    video_ids: list[str] = []
    for entry in root.findall(f"{{{ATOM_NS}}}entry"):
        video_id: str | None = None
        yt_id = entry.find(f"{{{YT_NS}}}videoId")
        if yt_id is not None and yt_id.text:
            video_id = yt_id.text.strip()
        if not video_id:
            link_el = entry.find(f"{{{ATOM_NS}}}link")
            href = link_el.get("href") if link_el is not None else None
            if href:
                video_id = video_id_from_link(href)
        if video_id:
            video_ids.append(video_id)

    return title, video_ids


def fetch_playlist_from_page(playlist_id: str) -> tuple[str, list[str]]:
    html = fetch_url(PLAYLIST_PAGE_URL.format(playlist_id=playlist_id)).decode(
        "utf-8", "replace"
    )
    title_match = PAGE_TITLE_RE.search(html)
    title = title_match.group(1) if title_match else playlist_id
    video_ids = list(dict.fromkeys(PAGE_VIDEO_ID_RE.findall(html)))
    return title, video_ids


def load_playlist(playlist_id: str) -> tuple[str, list[str], str]:
    """Return title, video_ids, source ('rss' or 'page')."""
    try:
        xml_bytes = fetch_playlist_xml(playlist_id)
        title, video_ids = parse_playlist_xml(xml_bytes, playlist_id)
        if video_ids:
            return title, video_ids, "rss"
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise

    title, video_ids = fetch_playlist_from_page(playlist_id)
    if not video_ids:
        raise ValueError("no videos found on playlist page")
    return title, video_ids, "page"


def parse_player_response(html: str) -> dict | None:
    idx = html.find(PLAYER_RESPONSE_MARKER)
    if idx < 0:
        return None
    brace = html.find("{", idx)
    if brace < 0:
        return None
    depth = 0
    for pos, char in enumerate(html[brace:], start=brace):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return json.loads(html[brace : pos + 1])
    return None


def stream_dimensions(player_response: dict) -> tuple[int, int] | None:
    streaming = player_response.get("streamingData") or {}
    candidates: list[tuple[int, int]] = []
    for fmt in (streaming.get("formats") or []) + (streaming.get("adaptiveFormats") or []):
        mime = fmt.get("mimeType") or ""
        if not mime.startswith("video/"):
            continue
        width = fmt.get("width")
        height = fmt.get("height")
        if width and height:
            candidates.append((int(width), int(height)))
    if not candidates:
        return None
    return max(candidates, key=lambda wh: wh[0] * wh[1])


def fetch_oembed(video_id: str) -> dict | None:
    url = (
        "https://www.youtube.com/oembed?url="
        + urllib.parse.quote(f"https://www.youtube.com/watch?v={video_id}", safe="")
        + "&format=json"
    )
    try:
        payload = json.loads(fetch_url(url))
    except (urllib.error.URLError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def apply_stream_dims(meta: dict, width: int, height: int) -> None:
    meta["width"] = width
    meta["height"] = height
    meta["aspectRatio"] = round(width / height, 6)
    meta["aspectSource"] = "streaming"


def apply_oembed_dims(meta: dict, oembed: dict) -> None:
    width = oembed.get("thumbnail_width") or oembed.get("width")
    height = oembed.get("thumbnail_height") or oembed.get("height")
    if not width or not height:
        return
    meta["width"] = int(width)
    meta["height"] = int(height)
    meta["aspectRatio"] = round(int(width) / int(height), 6)
    meta["aspectSource"] = "oembed"


def enrich_video(video_id: str) -> dict:
    meta: dict = {}

    try:
        html = fetch_url(WATCH_URL.format(video_id=video_id)).decode("utf-8", "replace")
        player_response = parse_player_response(html)
        if player_response:
            video_details = player_response.get("videoDetails") or {}
            if video_details.get("title"):
                meta["title"] = video_details["title"]
            if video_details.get("author"):
                meta["author"] = video_details["author"]
            length = video_details.get("lengthSeconds")
            if length is not None:
                meta["durationSeconds"] = int(length)

            playability = player_response.get("playabilityStatus") or {}
            meta["playability"] = playability.get("status")
            meta["embeddable"] = bool(playability.get("playableInEmbed", True))

            microformat = (
                player_response.get("microformat", {})
                .get("playerMicroformatRenderer", {})
            )
            if microformat.get("category"):
                meta["category"] = microformat["category"]

            dims = stream_dimensions(player_response)
            if dims:
                apply_stream_dims(meta, dims[0], dims[1])
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, ValueError) as exc:
        meta["fetchError"] = str(exc)

    if "aspectRatio" not in meta:
        oembed = fetch_oembed(video_id)
        if oembed:
            if not meta.get("title") and oembed.get("title"):
                meta["title"] = oembed["title"]
            if not meta.get("author") and oembed.get("author_name"):
                meta["author"] = oembed["author_name"]
            apply_oembed_dims(meta, oembed)

    if "embeddable" not in meta:
        meta["embeddable"] = True
    if "aspectRatio" not in meta:
        meta["aspectRatio"] = round(16 / 9, 6)
        meta["aspectSource"] = "default"

    return meta


def manifest_file_path(playlist_id: str) -> Path:
    return MANIFESTS_DIR / f"{playlist_id}.json"


def manifest_web_path(playlist_id: str) -> str:
    return f"{MANIFEST_WEB_DIR}/{playlist_id}.json"


def split_category_title(combined: str) -> tuple[str, str]:
    stripped = (combined or "").strip()
    if ": " in stripped:
        category, title = stripped.split(": ", 1)
        return category.strip(), title.strip()
    return "", stripped


def format_category_title(category: str, title: str) -> str:
    cat = (category or "").strip()
    tit = (title or "").strip()
    if cat and tit:
        return f"{cat}: {tit}"
    return tit or cat


def build_index_entry(playlist_id: str, label: str, video_count: int) -> dict:
    category, title = split_category_title(label)
    if not title:
        title = playlist_id
    entry: dict = {
        "id": playlist_id,
        "title": title,
        "manifest": manifest_web_path(playlist_id),
        "videoCount": video_count,
    }
    if category:
        entry["category"] = category
    return entry


def normalize_index_playlist_entry(entry: dict) -> dict:
    category = (entry.get("category") or "").strip()
    title = (entry.get("title") or "").strip()
    if category:
        return entry
    if ": " in title:
        cat, tit = split_category_title(title)
        normalized = dict(entry)
        normalized["title"] = tit or title
        if cat:
            normalized["category"] = cat
        return normalized
    return entry


def load_cached_playlist_titles(index_path: Path) -> dict[str, str]:
    titles: dict[str, str] = {}
    if index_path.is_file():
        try:
            pool = json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log(f"warning: could not read playlist titles from {index_path}: {exc}")
        else:
            for playlist in pool.get("playlists") or []:
                if not isinstance(playlist, dict):
                    continue
                playlist_id = playlist.get("id")
                if not playlist_id:
                    continue
                category = (playlist.get("category") or "").strip()
                title = (playlist.get("title") or "").strip()
                label = format_category_title(category, title)
                if not label and title:
                    label = title
                if label:
                    titles[playlist_id] = label
    if MANIFESTS_DIR.is_dir():
        for path in MANIFESTS_DIR.glob("PL*.json"):
            try:
                manifest = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            playlist_id = manifest.get("id") or path.stem
            title = (manifest.get("title") or "").strip()
            if title:
                titles[playlist_id] = title
    return titles


def resolve_playlist_title(
    playlist_id: str, fetched_title: str, cached_titles: dict[str, str]
) -> str:
    kept = cached_titles.get(playlist_id, "").strip()
    if kept:
        return kept
    stripped = fetched_title.strip()
    return stripped if stripped else playlist_id


def load_cached_videos(path: Path) -> dict[str, dict]:
    if not path.is_file():
        return {}
    try:
        pool = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"warning: could not read cache {path}: {exc}")
        return {}
    videos = pool.get("videos")
    if not isinstance(videos, dict):
        return {}
    return {vid: meta for vid, meta in videos.items() if isinstance(meta, dict)}


def load_cached_videos_from_manifests(manifests_dir: Path) -> dict[str, dict]:
    merged: dict[str, dict] = {}
    if not manifests_dir.is_dir():
        return merged
    for path in sorted(manifests_dir.glob("PL*.json")):
        merged.update(load_cached_videos(path))
    return merged


def load_all_cached_videos(index_path: Path, manifests_dir: Path) -> dict[str, dict]:
    cached = load_cached_videos_from_manifests(manifests_dir)
    legacy = load_cached_videos(index_path)
    if legacy:
        cached.update(legacy)
    return cached


def filter_playlist_video_ids(
    video_ids: list[str], videos_meta: dict[str, dict]
) -> tuple[list[str], dict[str, dict], int]:
    before = len(video_ids)
    filtered = [
        vid for vid in video_ids if is_available_for_pool(videos_meta.get(vid, {}))
    ]
    pl_videos = {vid: videos_meta[vid] for vid in filtered if vid in videos_meta}
    return filtered, pl_videos, before - len(filtered)


def write_playlist_manifest(manifest: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def is_monolithic_pool(pool: dict) -> bool:
    for playlist in pool.get("playlists") or []:
        if isinstance(playlist, dict) and playlist.get("videoIds"):
            return True
    return bool(pool.get("videos"))


def split_monolithic_pool(
    pool_path: Path,
    index_path: Path,
    manifests_dir: Path,
) -> dict:
    pool = json.loads(pool_path.read_text(encoding="utf-8"))
    if not is_monolithic_pool(pool):
        log("pool already uses manifest index (no inline videoIds); nothing to split")
        return pool

    generated_at = pool.get("generatedAt") or datetime.now(timezone.utc).isoformat()
    all_videos = pool.get("videos") or {}
    manifests_dir.mkdir(parents=True, exist_ok=True)
    index_playlists: list[dict] = []
    total_videos = 0

    for playlist in pool.get("playlists") or []:
        if not isinstance(playlist, dict):
            continue
        playlist_id = playlist.get("id")
        if not playlist_id:
            continue
        video_ids = playlist.get("videoIds") or []
        pl_videos = {vid: all_videos[vid] for vid in video_ids if vid in all_videos}
        manifest = {
            "id": playlist_id,
            "title": playlist.get("title") or playlist_id,
            "generatedAt": generated_at,
            "videoIds": video_ids,
            "videos": pl_videos,
        }
        manifest_path = manifest_file_path(playlist_id)
        write_playlist_manifest(manifest, manifest_path)
        index_playlists.append(
            build_index_entry(playlist_id, manifest["title"], len(video_ids))
        )
        total_videos += len(video_ids)
        log(f"  wrote {manifest_path.name} ({len(video_ids)} videos)")

    index = {
        "generatedAt": generated_at,
        "manifestDir": MANIFEST_WEB_DIR,
        "playlists": index_playlists,
    }
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    log(
        f"wrote index {index_path} ({len(index_playlists)} playlists, "
        f"{total_videos} videos total)"
    )
    return index


def has_cached_metadata(meta: dict) -> bool:
    """True when a manifest already has any stored metadata for this video."""
    if not meta:
        return False
    return bool(
        meta.get("title")
        or meta.get("playability") is not None
        or "embeddable" in meta
        or meta.get("aspectSource")
        or meta.get("width")
        or meta.get("fetchError")
    )


def can_reuse_metadata(video_id: str, meta: dict) -> bool:
    """Keep existing manifest metadata; only missing IDs are watch-page fetched."""
    return has_cached_metadata(meta)


def is_available_for_pool(meta: dict) -> bool:
    """Drop only when watch-page data proves the video cannot embed."""
    if not meta:
        return False
    if meta.get("embeddable") is False:
        return False
    status = meta.get("playability")
    if status is not None and status != PLAYABILITY_OK:
        return False
    return True


def log_metadata_fetch_summary(videos_meta: dict[str, dict]) -> None:
    rate_limited = sum(
        1
        for meta in videos_meta.values()
        if meta.get("fetchError") and "429" in str(meta.get("fetchError"))
    )
    if rate_limited:
        log(
            f"warning: {rate_limited} video(s) hit HTTP 429 on the watch page; "
            "kept in pool with oEmbed/default metadata (raise --metadata-delay if this persists)"
        )


def format_meta_summary(meta: dict) -> str:
    width = meta.get("width")
    height = meta.get("height")
    dims = f"{width}x{height}" if width and height else "?"
    source = meta.get("aspectSource") or "?"
    label = meta.get("title") or meta.get("id") or "?"
    return f"{dims} {source} — {label[:48]}"


def load_existing_index_playlists(index_path: Path) -> list[dict]:
    if not index_path.is_file():
        return []
    try:
        pool = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"warning: could not read index for merge {index_path}: {exc}")
        return []
    playlists = pool.get("playlists") or []
    return [entry for entry in playlists if isinstance(entry, dict) and entry.get("id")]


def merge_index_entry(fresh: dict, prior: dict | None) -> dict:
    """Keep hand-edited category/title from the index on disk."""
    merged = dict(fresh)
    if not prior:
        return normalize_index_playlist_entry(merged)
    prior_category = (prior.get("category") or "").strip()
    prior_title = (prior.get("title") or "").strip()
    if prior_category or (prior_title and ": " not in prior_title):
        if prior_category:
            merged["category"] = prior_category
        else:
            merged.pop("category", None)
        if prior_title:
            merged["title"] = prior_title
    elif prior_title:
        category, title = split_category_title(prior_title)
        merged["title"] = title or merged.get("title", "")
        if category:
            merged["category"] = category
        else:
            merged.pop("category", None)
    return normalize_index_playlist_entry(merged)


def write_pool_index(
    index_path: Path, generated_at: str, processed_playlists: list[dict]
) -> dict:
    """Merge this run's playlists into the index without dropping or renaming others."""
    prior_playlists = load_existing_index_playlists(index_path)
    prior_by_id = {entry["id"]: entry for entry in prior_playlists}
    processed_by_id = {
        entry["id"]: entry for entry in processed_playlists if entry.get("id")
    }

    merged: list[dict] = []
    seen: set[str] = set()

    for prior in prior_playlists:
        playlist_id = prior["id"]
        if playlist_id in processed_by_id:
            merged.append(
                merge_index_entry(processed_by_id[playlist_id], prior)
            )
        else:
            merged.append(normalize_index_playlist_entry(dict(prior)))
        seen.add(playlist_id)

    for fresh in processed_playlists:
        playlist_id = fresh.get("id")
        if not playlist_id or playlist_id in seen:
            continue
        merged.append(merge_index_entry(fresh, prior_by_id.get(playlist_id)))
        seen.add(playlist_id)

    index = {
        "generatedAt": generated_at,
        "manifestDir": MANIFEST_WEB_DIR,
        "playlists": merged,
    }
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    return index


def emit_playlist_manifest(
    playlist: dict,
    videos_meta: dict[str, dict],
    generated_at: str,
    filter_unavailable: bool,
    manifests_dir: Path,
) -> tuple[dict, int]:
    """Write one manifest file; return index entry and filtered-out count."""
    manifests_dir.mkdir(parents=True, exist_ok=True)
    video_ids = playlist["videoIds"]
    if filter_unavailable and videos_meta:
        video_ids, pl_videos, dropped = filter_playlist_video_ids(
            video_ids, videos_meta
        )
    else:
        dropped = 0
        pl_videos = {
            vid: videos_meta[vid] for vid in video_ids if vid in videos_meta
        }

    manifest_path = manifest_file_path(playlist["id"])
    title = playlist["title"]
    if manifest_path.is_file():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            kept_title = (existing.get("title") or "").strip()
            if kept_title:
                title = kept_title
        except (OSError, json.JSONDecodeError):
            pass

    manifest = {
        "id": playlist["id"],
        "title": title,
        "generatedAt": generated_at,
        "videoIds": video_ids,
        "videos": pl_videos,
    }
    write_playlist_manifest(manifest, manifest_path)
    log(f"  wrote {manifest_path.name} ({len(video_ids)} videos)")
    index_entry = build_index_entry(playlist["id"], title, len(video_ids))
    return index_entry, dropped


def enrich_playlist_metadata(
    playlist: dict,
    playlist_index: int,
    playlist_total: int,
    videos_meta: dict[str, dict],
    cached_videos: dict[str, dict],
    use_metadata_cache: bool,
    refresh_metadata: bool,
    metadata_delay: float,
) -> tuple[int, int]:
    """Fetch metadata for this playlist's IDs; return (cache_hits, fetch_count)."""
    video_ids = playlist["videoIds"]
    cache_count = 0
    fetch_count = 0
    pl_total = len(video_ids)

    log(f"  [{playlist_index}/{playlist_total}] metadata for {playlist['id']} ({pl_total} video(s))...")
    for video_index, video_id in enumerate(video_ids, start=1):
        prefix = f"    [{video_index}/{pl_total}] {video_id}"

        if video_id in videos_meta:
            cache_count += 1
            log(f"{prefix} reused {format_meta_summary(videos_meta[video_id])}")
            continue

        existing = cached_videos.get(video_id)
        if (
            use_metadata_cache
            and not refresh_metadata
            and existing
            and can_reuse_metadata(video_id, existing)
        ):
            videos_meta[video_id] = existing
            cache_count += 1
            log(f"{prefix} cached {format_meta_summary(existing)}")
            continue

        log(f"{prefix} fetching watch page ...")
        started = time.monotonic()
        videos_meta[video_id] = enrich_video(video_id)
        fetch_count += 1
        meta = videos_meta[video_id]
        elapsed = time.monotonic() - started
        status = "ok" if not meta.get("fetchError") else "warn"
        log(f"{prefix} {status} ({elapsed:.1f}s) {format_meta_summary(meta)}")
        if metadata_delay > 0:
            time.sleep(metadata_delay)

    return cache_count, fetch_count


def build_pool(
    playlist_ids: list[str],
    strict: bool,
    fetch_metadata: bool,
    filter_unavailable: bool,
    metadata_delay: float,
    index_path: Path,
    manifests_dir: Path,
    use_metadata_cache: bool,
    refresh_metadata: bool,
) -> dict:
    cached_titles = load_cached_playlist_titles(index_path)
    generated_at = datetime.now(timezone.utc).isoformat()
    manifests_dir.mkdir(parents=True, exist_ok=True)

    videos_meta: dict[str, dict] = {}
    cached_videos: dict[str, dict] = {}
    if fetch_metadata and use_metadata_cache and not refresh_metadata:
        cached_videos = load_all_cached_videos(index_path, manifests_dir)
        if cached_videos:
            log(f"Loaded {len(cached_videos)} cached metadata entries from manifests/index")

    if fetch_metadata:
        if refresh_metadata:
            log("Metadata mode: refresh all (--refresh-metadata)")
        elif use_metadata_cache:
            log("Metadata mode: backfill only — reuse manifest cache, fetch missing IDs")
        else:
            log("Metadata mode: fetch all (--no-metadata-cache)")

    index_playlists: list[dict] = []
    dropped_total = 0
    cache_count = 0
    fetch_count = 0
    playlist_total = len(playlist_ids)
    apply_filter = filter_unavailable and fetch_metadata

    log(f"Processing {playlist_total} playlist(s)...")
    for playlist_index, playlist_id in enumerate(playlist_ids, start=1):
        if not PLAYLIST_ID_RE.match(playlist_id):
            print(f"skip invalid playlist id: {playlist_id}", file=sys.stderr)
            if strict:
                sys.exit(1)
            continue

        log(f"  [{playlist_index}/{playlist_total}] {playlist_id} scrape ...")
        started = time.monotonic()
        try:
            title, video_ids, source = load_playlist(playlist_id)
        except (urllib.error.HTTPError, urllib.error.URLError, ET.ParseError, ValueError) as exc:
            print(f"skip {playlist_id}: {exc}", file=sys.stderr)
            if strict:
                sys.exit(1)
            continue

        elapsed = time.monotonic() - started
        log(
            f"  ok {playlist_id}: {title} ({len(video_ids)} videos, via {source}, "
            f"{elapsed:.1f}s)"
        )
        playlist = {
            "id": playlist_id,
            "title": resolve_playlist_title(playlist_id, title, cached_titles),
            "videoIds": video_ids,
        }

        if fetch_metadata:
            pl_cache, pl_fetch = enrich_playlist_metadata(
                playlist,
                playlist_index,
                playlist_total,
                videos_meta,
                cached_videos,
                use_metadata_cache,
                refresh_metadata,
                metadata_delay,
            )
            cache_count += pl_cache
            fetch_count += pl_fetch

        index_entry, dropped = emit_playlist_manifest(
            playlist,
            videos_meta,
            generated_at,
            apply_filter,
            manifests_dir,
        )
        dropped_total += dropped
        index_playlists.append(index_entry)
        write_pool_index(index_path, generated_at, index_playlists)
        log(f"  updated {index_path} ({len(index_playlists)} playlist(s) in index)")

    if fetch_metadata:
        log(
            f"Metadata done: {cache_count} reused from cache, "
            f"{fetch_count} backfill fetch(es)"
        )
        log_metadata_fetch_summary(videos_meta)

    if dropped_total:
        log(f"filtered {dropped_total} unavailable video(s) from playlists")

    total_videos = sum(entry["videoCount"] for entry in index_playlists)
    log(
        f"done {index_path} ({len(index_playlists)} playlists, {total_videos} videos)"
    )
    return write_pool_index(index_path, generated_at, index_playlists)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit with error if any playlist fails or pool is empty",
    )
    parser.add_argument(
        "--skip-metadata",
        action="store_true",
        help="Skip per-video watch-page metadata (faster, no videos map)",
    )
    parser.add_argument(
        "--keep-unavailable",
        action="store_true",
        help="Keep non-embeddable, deleted, or unplayable videos in playlists",
    )
    parser.add_argument(
        "--metadata-delay",
        type=float,
        default=0.5,
        help="Seconds between watch-page requests (default 0.5; use 1.0+ for large pools)",
    )
    parser.add_argument(
        "--playlists",
        type=Path,
        default=PLAYLISTS_PATH,
        help="Path to playlist ID list",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT_PATH,
        help="Output JSON path",
    )
    parser.add_argument(
        "--no-metadata-cache",
        action="store_true",
        help="Always re-fetch watch-page metadata (ignore existing output file)",
    )
    parser.add_argument(
        "--refresh-metadata",
        action="store_true",
        help="Re-fetch watch-page metadata for every video (default: backfill missing only)",
    )
    parser.add_argument(
        "--migrate-index",
        action="store_true",
        help='Split "Category: Title" index entries into category + title fields (no network)',
    )
    parser.add_argument(
        "--split-existing",
        action="store_true",
        help="Split a monolithic video-pool.json into index + manifests (no network)",
    )
    parser.add_argument(
        "--manifests-dir",
        type=Path,
        default=MANIFESTS_DIR,
        help="Directory for per-playlist manifest JSON files",
    )
    args = parser.parse_args()

    if not args.playlists.is_file():
        print(f"missing {args.playlists}", file=sys.stderr)
        sys.exit(1)

    playlist_ids = load_playlist_ids(args.playlists)
    if not playlist_ids:
        print("no playlist IDs in file", file=sys.stderr)
        sys.exit(1)

    if args.keep_unavailable and args.skip_metadata:
        log("note: --keep-unavailable with --skip-metadata leaves playlist scrape unfiltered")

    if args.migrate_index:
        if not args.output.is_file():
            print(f"missing {args.output}", file=sys.stderr)
            sys.exit(1)
        log("vidgrid migrate_index starting")
        pool = json.loads(args.output.read_text(encoding="utf-8"))
        playlists = [
            normalize_index_playlist_entry(dict(entry))
            for entry in pool.get("playlists") or []
            if isinstance(entry, dict) and entry.get("id")
        ]
        pool["playlists"] = playlists
        args.output.write_text(json.dumps(pool, indent=2) + "\n", encoding="utf-8")
        log(f"migrated {len(playlists)} playlist(s) in {args.output}")
        return

    if args.split_existing:
        if not args.output.is_file():
            print(f"missing {args.output}", file=sys.stderr)
            sys.exit(1)
        log("vidgrid split_existing starting")
        split_monolithic_pool(args.output, args.output, args.manifests_dir)
        return

    log("vidgrid build_feeds starting")
    pool = build_pool(
        playlist_ids,
        args.strict,
        fetch_metadata=not args.skip_metadata,
        filter_unavailable=not args.keep_unavailable,
        metadata_delay=args.metadata_delay,
        index_path=args.output,
        manifests_dir=args.manifests_dir,
        use_metadata_cache=not args.no_metadata_cache,
        refresh_metadata=args.refresh_metadata,
    )
    total_videos = sum(pl.get("videoCount", 0) for pl in pool["playlists"])
    if total_videos == 0:
        print("video pool is empty", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
