#!/usr/bin/env python3
"""RSS pipeline service for TIMELINE with Typesense indexing."""

import calendar
import hashlib
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from time import struct_time

import feedparser
import psycopg2
import requests
from psycopg2.extras import execute_values

DATABASE_URL = os.getenv("DATABASE_URL", "")
TYPESENSE_URL = os.getenv("TYPESENSE_URL", "http://localhost:8108").rstrip("/")
TYPESENSE_API_KEY = os.getenv("TYPESENSE_API_KEY", "")
TYPESENSE_COLLECTION = os.getenv("TYPESENSE_COLLECTION", "timeline_entries")
POLL_SECONDS = int(os.getenv("RSS_POLL_SECONDS", "600"))
FEEDS_FILE = Path(os.getenv("FEEDS_FILE", "/app/feeds.json"))
MAX_WORKERS = int(os.getenv("RSS_MAX_WORKERS", "10"))  # Max parallel feed fetches

SKIP_PATTERNS = {
    "New York Times": ["here is the latest", "here's the latest", "this is what happened on "],
    "ABC News": ["live updates:", "live: ", "watch: "],
    "BBC News": ["watch: "],
}

REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; RSSReader/1.0; +https://github.com)",
    "Accept": "application/rss+xml, application/xml, text/xml, */*",
}

GEO_HINTS = [
    {"alias": "new york city", "name": "New York City", "level": "city", "country": "United States", "lat": 40.7128, "lng": -74.0060, "country_lat": 39.5, "country_lng": -98.35},
    {"alias": "washington dc", "name": "Washington DC", "level": "city", "country": "United States", "lat": 38.9072, "lng": -77.0369, "country_lat": 39.5, "country_lng": -98.35},
    {"alias": "los angeles", "name": "Los Angeles", "level": "city", "country": "United States", "lat": 34.0522, "lng": -118.2437, "country_lat": 39.5, "country_lng": -98.35},
    {"alias": "san francisco", "name": "San Francisco", "level": "city", "country": "United States", "lat": 37.7749, "lng": -122.4194, "country_lat": 39.5, "country_lng": -98.35},
    {"alias": "london", "name": "London", "level": "city", "country": "United Kingdom", "lat": 51.5074, "lng": -0.1278, "country_lat": 54.8, "country_lng": -4.6},
    {"alias": "paris", "name": "Paris", "level": "city", "country": "France", "lat": 48.8566, "lng": 2.3522, "country_lat": 46.2, "country_lng": 2.2},
    {"alias": "berlin", "name": "Berlin", "level": "city", "country": "Germany", "lat": 52.52, "lng": 13.405, "country_lat": 51.2, "country_lng": 10.4},
    {"alias": "rome", "name": "Rome", "level": "city", "country": "Italy", "lat": 41.9028, "lng": 12.4964, "country_lat": 41.9, "country_lng": 12.5},
    {"alias": "madrid", "name": "Madrid", "level": "city", "country": "Spain", "lat": 40.4168, "lng": -3.7038, "country_lat": 40.4, "country_lng": -3.7},
    {"alias": "kyiv", "name": "Kyiv", "level": "city", "country": "Ukraine", "lat": 50.4501, "lng": 30.5234, "country_lat": 49.0, "country_lng": 31.3},
    {"alias": "moscow", "name": "Moscow", "level": "city", "country": "Russia", "lat": 55.7558, "lng": 37.6173, "country_lat": 61.5, "country_lng": 105.3},
    {"alias": "beijing", "name": "Beijing", "level": "city", "country": "China", "lat": 39.9042, "lng": 116.4074, "country_lat": 35.8, "country_lng": 104.1},
    {"alias": "shanghai", "name": "Shanghai", "level": "city", "country": "China", "lat": 31.2304, "lng": 121.4737, "country_lat": 35.8, "country_lng": 104.1},
    {"alias": "tokyo", "name": "Tokyo", "level": "city", "country": "Japan", "lat": 35.6762, "lng": 139.6503, "country_lat": 36.2, "country_lng": 138.3},
    {"alias": "seoul", "name": "Seoul", "level": "city", "country": "South Korea", "lat": 37.5665, "lng": 126.978, "country_lat": 36.5, "country_lng": 127.8},
    {"alias": "taipei", "name": "Taipei", "level": "city", "country": "Taiwan", "lat": 25.033, "lng": 121.5654, "country_lat": 23.7, "country_lng": 121.0},
    {"alias": "delhi", "name": "Delhi", "level": "city", "country": "India", "lat": 28.6139, "lng": 77.209, "country_lat": 22.9, "country_lng": 79.0},
    {"alias": "mumbai", "name": "Mumbai", "level": "city", "country": "India", "lat": 19.076, "lng": 72.8777, "country_lat": 22.9, "country_lng": 79.0},
    {"alias": "islamabad", "name": "Islamabad", "level": "city", "country": "Pakistan", "lat": 33.6844, "lng": 73.0479, "country_lat": 30.4, "country_lng": 69.3},
    {"alias": "jerusalem", "name": "Jerusalem", "level": "city", "country": "Israel", "lat": 31.7683, "lng": 35.2137, "country_lat": 31.0, "country_lng": 35.0},
    {"alias": "gaza", "name": "Gaza", "level": "city", "country": "Palestine", "lat": 31.5018, "lng": 34.4668, "country_lat": 31.9, "country_lng": 35.2},
    {"alias": "tehran", "name": "Tehran", "level": "city", "country": "Iran", "lat": 35.6892, "lng": 51.389, "country_lat": 32.4, "country_lng": 53.7},
    {"alias": "baghdad", "name": "Baghdad", "level": "city", "country": "Iraq", "lat": 33.3152, "lng": 44.3661, "country_lat": 33.2, "country_lng": 43.7},
    {"alias": "cairo", "name": "Cairo", "level": "city", "country": "Egypt", "lat": 30.0444, "lng": 31.2357, "country_lat": 26.8, "country_lng": 30.8},
    {"alias": "lagos", "name": "Lagos", "level": "city", "country": "Nigeria", "lat": 6.5244, "lng": 3.3792, "country_lat": 9.1, "country_lng": 8.7},
    {"alias": "nairobi", "name": "Nairobi", "level": "city", "country": "Kenya", "lat": -1.2921, "lng": 36.8219, "country_lat": 0.3, "country_lng": 37.9},
    {"alias": "sydney", "name": "Sydney", "level": "city", "country": "Australia", "lat": -33.8688, "lng": 151.2093, "country_lat": -25.3, "country_lng": 133.8},
    {"alias": "toronto", "name": "Toronto", "level": "city", "country": "Canada", "lat": 43.6532, "lng": -79.3832, "country_lat": 56.1, "country_lng": -106.3},
    {"alias": "mexico city", "name": "Mexico City", "level": "city", "country": "Mexico", "lat": 19.4326, "lng": -99.1332, "country_lat": 23.6, "country_lng": -102.5},
    {"alias": "brazil", "name": "Brazil", "level": "country", "country": "Brazil", "lat": -14.235, "lng": -51.9253, "country_lat": -14.235, "country_lng": -51.9253},
    {"alias": "united states", "name": "United States", "level": "country", "country": "United States", "lat": 39.5, "lng": -98.35, "country_lat": 39.5, "country_lng": -98.35},
    {"alias": "ukraine", "name": "Ukraine", "level": "country", "country": "Ukraine", "lat": 49.0, "lng": 31.3, "country_lat": 49.0, "country_lng": 31.3},
    {"alias": "russia", "name": "Russia", "level": "country", "country": "Russia", "lat": 61.5, "lng": 105.3, "country_lat": 61.5, "country_lng": 105.3},
    {"alias": "china", "name": "China", "level": "country", "country": "China", "lat": 35.8, "lng": 104.1, "country_lat": 35.8, "country_lng": 104.1},
    {"alias": "japan", "name": "Japan", "level": "country", "country": "Japan", "lat": 36.2, "lng": 138.3, "country_lat": 36.2, "country_lng": 138.3},
    {"alias": "india", "name": "India", "level": "country", "country": "India", "lat": 22.9, "lng": 79.0, "country_lat": 22.9, "country_lng": 79.0},
    {"alias": "canada", "name": "Canada", "level": "country", "country": "Canada", "lat": 56.1, "lng": -106.3, "country_lat": 56.1, "country_lng": -106.3},
    {"alias": "mexico", "name": "Mexico", "level": "country", "country": "Mexico", "lat": 23.6, "lng": -102.5, "country_lat": 23.6, "country_lng": -102.5},
    {"alias": "iran", "name": "Iran", "level": "country", "country": "Iran", "lat": 32.4, "lng": 53.7, "country_lat": 32.4, "country_lng": 53.7},
    {"alias": "iraq", "name": "Iraq", "level": "country", "country": "Iraq", "lat": 33.2, "lng": 43.7, "country_lat": 33.2, "country_lng": 43.7},
    {"alias": "israel", "name": "Israel", "level": "country", "country": "Israel", "lat": 31.0, "lng": 35.0, "country_lat": 31.0, "country_lng": 35.0},
    {"alias": "palestine", "name": "Palestine", "level": "country", "country": "Palestine", "lat": 31.9, "lng": 35.2, "country_lat": 31.9, "country_lng": 35.2},
    {"alias": "germany", "name": "Germany", "level": "country", "country": "Germany", "lat": 51.2, "lng": 10.4, "country_lat": 51.2, "country_lng": 10.4},
    {"alias": "france", "name": "France", "level": "country", "country": "France", "lat": 46.2, "lng": 2.2, "country_lat": 46.2, "country_lng": 2.2},
    {"alias": "italy", "name": "Italy", "level": "country", "country": "Italy", "lat": 41.9, "lng": 12.5, "country_lat": 41.9, "country_lng": 12.5},
    {"alias": "spain", "name": "Spain", "level": "country", "country": "Spain", "lat": 40.4, "lng": -3.7, "country_lat": 40.4, "country_lng": -3.7},
    {"alias": "united kingdom", "name": "United Kingdom", "level": "country", "country": "United Kingdom", "lat": 54.8, "lng": -4.6, "country_lat": 54.8, "country_lng": -4.6},
    {"alias": "australia", "name": "Australia", "level": "country", "country": "Australia", "lat": -25.3, "lng": 133.8, "country_lat": -25.3, "country_lng": 133.8},
    {"alias": "nigeria", "name": "Nigeria", "level": "country", "country": "Nigeria", "lat": 9.1, "lng": 8.7, "country_lat": 9.1, "country_lng": 8.7},
    {"alias": "egypt", "name": "Egypt", "level": "country", "country": "Egypt", "lat": 26.8, "lng": 30.8, "country_lat": 26.8, "country_lng": 30.8},
]

GEO_PATTERNS = [
    (re.compile(rf"\b{re.escape(geo['alias'])}\b", re.IGNORECASE), geo)
    for geo in sorted(GEO_HINTS, key=lambda x: len(x["alias"]), reverse=True)
]


def parse_date(entry):
    for key in ("published_parsed", "updated_parsed"):
        parsed = getattr(entry, key, None)
        if parsed and isinstance(parsed, struct_time):
            return datetime.fromtimestamp(calendar.timegm(parsed), tz=timezone.utc)
    return None


def in_current_year_window(pub_date):
    if not pub_date:
        return False
    now = datetime.now(timezone.utc)
    year_start = datetime(now.year, 1, 1, tzinfo=timezone.utc)
    return year_start <= pub_date <= now


def get_content(entry):
    summary = getattr(entry, "summary", None) or getattr(entry, "description", None)
    if summary:
        return summary
    content = getattr(entry, "content", None)
    if content and isinstance(content, list) and content:
        return content[0].get("value", "")
    return ""


def should_skip(source, title, content):
    if "Opinion | " in title:
        return True
    if source == "CNET" and ("Today's " in title or "Today's " in content):
        return True
    patterns = SKIP_PATTERNS.get(source, [])
    if patterns:
        combined = f"{title} {content}".lower()
        if any(pattern in combined for pattern in patterns):
            return True
    return False


def extract_location(title, content):
    blob = f"{title or ''} {content or ''}"
    for pattern, geo in GEO_PATTERNS:
        if pattern.search(blob):
            return {
                "location_name": geo["name"],
                "location_level": geo["level"],
                "location_country": geo["country"],
                "lat": geo["lat"],
                "lng": geo["lng"],
                "country_lat": geo["country_lat"],
                "country_lng": geo["country_lng"],
                "has_location": True,
            }
    return {
        "location_name": None,
        "location_level": None,
        "location_country": None,
        "lat": None,
        "lng": None,
        "country_lat": None,
        "country_lng": None,
        "has_location": False,
    }


def load_feeds():
    if not FEEDS_FILE.exists():
        raise FileNotFoundError(f"Feeds file not found: {FEEDS_FILE}")
    with FEEDS_FILE.open("r", encoding="utf-8") as stream:
        return json.load(stream).get("feeds", [])


def ensure_schema(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS entries (
              id BIGSERIAL PRIMARY KEY,
              title TEXT,
              content TEXT NOT NULL,
              source TEXT NOT NULL,
              publication_date TIMESTAMPTZ NOT NULL,
              link TEXT,
              created_at TIMESTAMPTZ DEFAULT NOW(),
              UNIQUE (source, link)
            );
            """
        )
        cur.execute("ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_name TEXT;")
        cur.execute("ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_level TEXT;")
        cur.execute("ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_country TEXT;")
        cur.execute("ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION;")
        cur.execute("ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;")
        cur.execute("ALTER TABLE entries ADD COLUMN IF NOT EXISTS country_lat DOUBLE PRECISION;")
        cur.execute("ALTER TABLE entries ADD COLUMN IF NOT EXISTS country_lng DOUBLE PRECISION;")
        cur.execute("ALTER TABLE entries ADD COLUMN IF NOT EXISTS has_location BOOLEAN DEFAULT FALSE;")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_entries_publication_date ON entries (publication_date DESC);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_entries_source ON entries (source);")
    conn.commit()


def typesense_request(method, path, payload=None, headers=None, timeout=10):
    req_headers = {"X-TYPESENSE-API-KEY": TYPESENSE_API_KEY}
    if headers:
        req_headers.update(headers)
    url = f"{TYPESENSE_URL}{path}"
    return requests.request(method, url, json=payload, headers=req_headers, timeout=timeout)


def ensure_typesense_collection():
    if not TYPESENSE_API_KEY:
        raise RuntimeError("TYPESENSE_API_KEY is required")
    while True:
        try:
            ping = requests.get(f"{TYPESENSE_URL}/health", timeout=5)
            if ping.ok:
                break
        except requests.RequestException as exc:
            print(f"Typesense not ready: {exc}")
        time.sleep(2)

    collection_path = f"/collections/{TYPESENSE_COLLECTION}"
    exists = typesense_request("GET", collection_path)
    if exists.status_code == 200:
        return

    schema = {
        "name": TYPESENSE_COLLECTION,
        "fields": [
            {"name": "title", "type": "string", "optional": True},
            {"name": "content", "type": "string", "optional": True},
            {"name": "source", "type": "string", "facet": True},
            {"name": "link", "type": "string", "optional": True},
            {"name": "publication_date", "type": "int64", "sort": True},
            {"name": "publication_date_iso", "type": "string"},
            {"name": "location_name", "type": "string", "facet": True, "optional": True},
            {"name": "location_level", "type": "string", "facet": True, "optional": True},
            {"name": "location_country", "type": "string", "facet": True, "optional": True},
            {"name": "lat", "type": "float", "optional": True},
            {"name": "lng", "type": "float", "optional": True},
            {"name": "country_lat", "type": "float", "optional": True},
            {"name": "country_lng", "type": "float", "optional": True},
            {"name": "has_location", "type": "bool", "facet": True},
        ],
        "default_sorting_field": "publication_date",
    }
    created = typesense_request("POST", "/collections", payload=schema)
    if created.status_code not in (200, 201):
        raise RuntimeError(f"Failed to create Typesense collection: {created.text}")


def story_id(source, link, title, pub_date):
    raw = f"{source}|{link or ''}|{title or ''}|{int(pub_date.timestamp())}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def build_doc(story):
    pub_date = story["publication_date"]
    return {
        "id": story["id"],
        "title": story["title"] or "",
        "content": story["content"] or "",
        "source": story["source"] or "",
        "link": story["link"] or "",
        "publication_date": int(pub_date.timestamp()),
        "publication_date_iso": pub_date.isoformat(),
        "location_name": story["location_name"],
        "location_level": story["location_level"],
        "location_country": story["location_country"],
        "lat": story["lat"],
        "lng": story["lng"],
        "country_lat": story["country_lat"],
        "country_lng": story["country_lng"],
        "has_location": bool(story["has_location"]),
    }


def upsert_typesense_documents(stories):
    if not stories:
        return
    ndjson = "\n".join(json.dumps(build_doc(s), default=str) for s in stories)
    response = requests.post(
        f"{TYPESENSE_URL}/collections/{TYPESENSE_COLLECTION}/documents/import?action=upsert",
        data=ndjson.encode("utf-8"),
        headers={
            "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY,
            "Content-Type": "text/plain",
        },
        timeout=20,
    )
    if not response.ok:
        raise RuntimeError(f"Typesense import failed: {response.status_code} {response.text}")


def backfill_typesense(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT title, content, source, publication_date, link,
                   location_name, location_level, location_country,
                   location_lat, location_lng, country_lat, country_lng, has_location
            FROM entries
            WHERE publication_date >= date_trunc('year', NOW())
            ORDER BY publication_date DESC
            """
        )
        rows = cur.fetchall()
    stories = []
    for row in rows:
        title, content, source, pub_date, link, loc_name, loc_level, loc_country, lat, lng, country_lat, country_lng, has_loc = row
        if not has_loc:
            guessed = extract_location(title, content)
            loc_name = guessed["location_name"]
            loc_level = guessed["location_level"]
            loc_country = guessed["location_country"]
            lat = guessed["lat"]
            lng = guessed["lng"]
            country_lat = guessed["country_lat"]
            country_lng = guessed["country_lng"]
            has_loc = guessed["has_location"]
        stories.append(
            {
                "id": story_id(source, link, title, pub_date),
                "title": title,
                "content": content,
                "source": source,
                "publication_date": pub_date,
                "link": link,
                "location_name": loc_name,
                "location_level": loc_level,
                "location_country": loc_country,
                "lat": lat,
                "lng": lng,
                "country_lat": country_lat,
                "country_lng": country_lng,
                "has_location": bool(has_loc),
            }
        )
    if stories:
        upsert_typesense_documents(stories)
        print(f"Backfilled {len(stories)} stories into Typesense")


def fetch_single_feed(feed):
    """Fetch and parse a single RSS feed. Returns (feed_name, entries_list, error)."""
    name = feed.get("name", "Unknown")
    url = feed.get("url")
    
    if not url:
        return (name, [], "No URL provided")
    
    try:
        parsed = feedparser.parse(url, request_headers=REQUEST_HEADERS)
    except Exception as exc:
        return (name, [], f"Fetch error: {exc}")
    
    if getattr(parsed, "bozo", False) and not parsed.entries:
        return (name, [], "Feed parse failed")
    
    entries = []
    for entry in parsed.entries:
        title = (getattr(entry, "title", None) or "").strip()
        content = get_content(entry).strip()
        
        if should_skip(name, title, content):
            continue
        
        if name == "Reuters" and title.endswith(" - Reuters"):
            title = title[:-10].strip()
        
        pub_date = parse_date(entry)
        if not in_current_year_window(pub_date):
            continue
        
        link_raw = (getattr(entry, "link", None) or "").strip()
        link = link_raw if link_raw else None
        geo = extract_location(title, content)
        
        entries.append({
            "title": title,
            "content": content,
            "source": name,
            "publication_date": pub_date,
            "link": link,
            **geo,
        })
    
    return (name, entries, None)


def fetch_once(conn):
    feeds = load_feeds()
    if not feeds:
        print("No feeds configured.")
        return

    start_time = time.time()
    insert_rows = []
    docs = []
    failed_feeds = []
    
    # Parallel fetch using ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_feed = {executor.submit(fetch_single_feed, feed): feed for feed in feeds}
        
        for future in as_completed(future_to_feed):
            feed = future_to_feed[future]
            name = feed.get("name", "Unknown")
            
            try:
                fetched_name, entries, error = future.result()
                
                if error:
                    print(f"[{name}] {error}")
                    failed_feeds.append({"feed": name, "error": error})
                    continue
                
                # Process successfully fetched entries
                for entry in entries:
                    insert_rows.append(
                        (
                            entry["title"],
                            entry["content"],
                            entry["source"],
                            entry["publication_date"],
                            entry["link"],
                            entry["location_name"],
                            entry["location_level"],
                            entry["location_country"],
                            entry["lat"],
                            entry["lng"],
                            entry["country_lat"],
                            entry["country_lng"],
                            entry["has_location"],
                        )
                    )
                    docs.append(
                        {
                            "id": story_id(entry["source"], entry["link"], entry["title"], entry["publication_date"]),
                            **entry,
                        }
                    )
                
                if entries:
                    print(f"[{name}] parsed {len(entries)} candidate entries")
                    
            except Exception as exc:
                print(f"[{name}] processing error: {exc}")
                failed_feeds.append({"feed": name, "error": str(exc)})
    
    elapsed = time.time() - start_time
    total_entries = len(insert_rows)
    
    if not insert_rows:
        print(f"No new candidate rows this cycle. ({elapsed:.1f}s)"
              f"{f' | {len(failed_feeds)} feeds failed' if failed_feeds else ''}")
        return

    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            INSERT INTO entries (
              title, content, source, publication_date, link,
              location_name, location_level, location_country, location_lat, location_lng,
              country_lat, country_lng, has_location
            )
            VALUES %s
            ON CONFLICT (source, link) DO NOTHING
            """,
            insert_rows,
            page_size=200,
        )
    conn.commit()

    upsert_typesense_documents(docs)
    status = f"Processed {total_entries} candidates from {len(feeds)} feeds in {elapsed:.1f}s"
    if failed_feeds:
        status += f" ({len(failed_feeds)} feeds failed)"
    print(status + " and synced Typesense")


def wait_for_db():
    while True:
        try:
            conn = psycopg2.connect(DATABASE_URL)
            conn.autocommit = False
            return conn
        except Exception as exc:
            print(f"Database not ready: {exc}")
            time.sleep(3)


def main():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required")
    if not TYPESENSE_API_KEY:
        raise RuntimeError("TYPESENSE_API_KEY is required")

    conn = wait_for_db()
    ensure_schema(conn)
    ensure_typesense_collection()
    backfill_typesense(conn)
    print("RSS builder started.")

    while True:
        try:
            fetch_once(conn)
        except Exception as exc:
            print(f"Cycle failed: {exc}")
            conn.rollback()
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
