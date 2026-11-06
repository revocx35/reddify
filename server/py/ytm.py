"""YouTube Music search for Reddify's matcher: prints JSON candidates for one query.

Usage: python3 -I ytm.py "<query>"   (the query arrives as a single argv entry, never through a shell)
Output: [{"type": "songs"|"videos", "videoId", "title", "artists": [..], "album", "duration"}]
"""
import json
import re
import sys

from ytmusicapi import YTMusic

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def main() -> int:
    if len(sys.argv) != 2 or not (0 < len(sys.argv[1]) <= 300):
        print("usage: ytm.py <query>", file=sys.stderr)
        return 2
    query = sys.argv[1]
    yt = YTMusic()
    out = []
    for kind in ("songs", "videos"):
        try:
            results = yt.search(query, filter=kind, limit=8)
        except Exception as e:  # network / parse errors: report and try the next kind
            print(f"{kind} search failed: {type(e).__name__}", file=sys.stderr)
            continue
        for r in results[:8]:
            vid = r.get("videoId") or ""
            if not VIDEO_ID.match(vid):
                continue
            out.append({
                "type": kind,
                "videoId": vid,
                "title": str(r.get("title") or "")[:300],
                "artists": [str(a.get("name") or "")[:200] for a in (r.get("artists") or []) if isinstance(a, dict)][:10],
                "album": str((r.get("album") or {}).get("name") or "")[:300] if isinstance(r.get("album"), dict) else "",
                "duration": r.get("duration_seconds") if isinstance(r.get("duration_seconds"), (int, float)) else None,
            })
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
