#!/usr/bin/env python3
"""Build data/video-pool.json from YouTube playlist RSS feeds."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAYLISTS_PATH = ROOT / "data" / "playlists.txt"
OUTPUT_PATH = ROOT / "data" / "video-pool.json"
RSS_URL = "https://www.youtube.com/feeds/videos.xml?playlist_id={playlist_id}"
PLAYLIST_PAGE_URL = "https://www.youtube.com/playlist?list={playlist_id}"
USER_AGENT = "Mozilla/5.0 (compatible; vidgrid-build-feeds/1.0)"
ATOM_NS = "http://www.w3.org/2005/Atom"
YT_NS = "http://www.youtube.com/xml/schemas/2015"
PLAYLIST_ID_RE = re.compile(r"^PL[\w-]+$")
VIDEO_ID_RE = re.compile(r"(?:v=|/shorts/|youtu\.be/)([A-Za-z0-9_-]{11})")
PAGE_VIDEO_ID_RE = re.compile(r'"videoId":"([A-Za-z0-9_-]{11})"')
PAGE_TITLE_RE = re.compile(r'<meta name="title" content="([^"]+)"')


def load_playlist_ids(path: Path) -> list[str]:
    ids: list[str] = []
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            ids.append(line)
    return ids


def fetch_url(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


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


def build_pool(playlist_ids: list[str], strict: bool) -> dict:
    playlists_out: list[dict] = []
    all_ids: list[str] = []
    seen: set[str] = set()

    for playlist_id in playlist_ids:
        if not PLAYLIST_ID_RE.match(playlist_id):
            print(f"skip invalid playlist id: {playlist_id}", file=sys.stderr)
            if strict:
                sys.exit(1)
            continue

        try:
            title, video_ids, source = load_playlist(playlist_id)
        except (urllib.error.HTTPError, urllib.error.URLError, ET.ParseError, ValueError) as exc:
            print(f"skip {playlist_id}: {exc}", file=sys.stderr)
            if strict:
                sys.exit(1)
            continue

        print(f"ok {playlist_id}: {title} ({len(video_ids)} videos, via {source})")
        playlists_out.append(
            {"id": playlist_id, "title": title, "videoIds": video_ids}
        )
        for vid in video_ids:
            if vid not in seen:
                seen.add(vid)
                all_ids.append(vid)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "playlists": playlists_out,
        "videoIds": all_ids,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit with error if any playlist fails or pool is empty",
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
    args = parser.parse_args()

    if not args.playlists.is_file():
        print(f"missing {args.playlists}", file=sys.stderr)
        sys.exit(1)

    playlist_ids = load_playlist_ids(args.playlists)
    if not playlist_ids:
        print("no playlist IDs in file", file=sys.stderr)
        sys.exit(1)

    pool = build_pool(playlist_ids, args.strict)
    if not pool["videoIds"]:
        print("video pool is empty", file=sys.stderr)
        sys.exit(1)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(pool, indent=2) + "\n")
    print(f"wrote {args.output} ({len(pool['videoIds'])} unique videos)")


if __name__ == "__main__":
    main()
