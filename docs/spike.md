# Phase 0 spike: Belgium on PostGIS (2026-11-22)

Goal: check that a Photon dump can be imported into PostGIS and answer autocomplete and reverse
geocoding fast enough on a small server, before building GeoPol.

**Verdict: go.**

## Data

`photon-dump-belgium-1.0-latest.jsonl.zst` from download1.graphhopper.com (454.5 MB, data of 2026-11-15).

- 5,034,726 lines, 12.6 GB uncompressed JSON; 5.12 M places
- 4.27 M house numbers (4.09 M are building polygons: only their centroid is kept)
- Administrative areas come **with their polygons** (country, state, county, city, district): no separate
  boundary import is needed for "which city is this point in"
- Streets come as LineStrings: reverse finds the nearest street line, not the nearest street centroid
- Names and address parts in many languages (`name:fr`, `city:nl`…), importance, bbox, OSM tags

## Import

Single-threaded Node (zstd → JSON.parse → COPY), two COPY streams (features, addresses), indexes after.

| Step | Time |
|---|---|
| Rows (parse + COPY) | ~7 min (Node-bound: Postgres at ~17% CPU) |
| Indexes + ANALYZE | ~1.3 min |
| **Total** | **475 s** |

Result: 993,767 features (named things) and 4,127,693 addresses (house numbers without a name).

## Size: 2.5 GB in total

| Relation | Size |
|---|---|
| addresses | 1,660 MB |
| features | 825 MB |
| addresses_centroid (GiST) | 163 MB |
| addresses_street | 129 MB |
| features_name_trgm | 45 MB |
| features_centroid | 39 MB |
| features_search (GIN) | 35 MB |
| features_geom (GiST) | 25 MB |

## Query times (local, warm cache)

Autocomplete, after the two-tier search (important places first, capped long tail) and ranking fixes:

| Query | ms | Top result |
|---|---|---|
| `b` | 33 | Belgium, Brussels |
| `br` | 117 | Brussels, Bruges |
| `brux` | 20 | Brussels |
| `anvers` | 2 | Antwerpen (city) |
| `antwerpen centr` | 22 | Antwerpen-Centraal |
| `rue de la loi` | 6 | Rue de la Loi, Brussels |
| `rue de la loi 16` | 7 | Rue de la Loi 16, Brussels |
| `avenue louise 54` | 5 | Avenue Louise 54 |
| `grand place` | 9 | Grand-Place, Brussels |
| `gare liege` | 9 | Liège-Guillemins |
| `rue` / `rue de` | 40 / 57 | (any street) |
| `bruxels` (typo) | 38 | Brussels |
| `atomiun` (typo) | 4 | Atomium |

Before the two-tier search, `b`, `br`, `rue` and `rue de` took 2–3.5 s (every match scored).

Reverse (nearest house number, nearest street line, areas containing the point): **3–7 ms**, e.g.
Grand-Place → "Grand-Place 29 (29 m) · Grand-Place street (0 m) · Pentagone < Bruxelles < … < Belgium".

## Estimates for fr, de, uk + be

Scaling from Belgium by dump size (compressed): France 7.5 GB, Germany 9.6 GB, British Isles 1.0 GB.

- Database: ~100 GB (France ~40, Germany ~50, UK ~5, Belgium 2.5) on a 1 TB disk
- Import single-threaded: ~5 h for all four. Parsing on several cores (worker threads) should cut it to ~1 h
- RAM: Postgres with 2–4 GB of shared buffers is plenty; the app itself is small

## To do from what we learned

- Parse on worker threads (import is Node-bound)
- Import into a staging table and swap (no downtime, keep the old data if it fails)
- Re-check `br`-like two-letter queries on France + Germany (the first tier grows with the data);
  if needed, a small precomputed prefix table for 1–3 letters
- Output names in the requested language (`names.fr`…) instead of the bilingual default names
  ("Rue de la Loi - Wetstraat")
