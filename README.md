# ClassFit NYC

A tool for NYC students, parents, and school administrators to understand and
address public school overcrowding under NYC's class size mandate.

**Mandate caps used throughout:** 20 students (K-3), 23 (grades 4-8), 25 (high school).

## Stack

- **Next.js 15** (App Router, TypeScript) — one full-stack app, API routes + React UI
- **SQLite** via `better-sqlite3` — normalized schema, zero-config single file at `data/classfit.db`
- **Leaflet** / `react-leaflet` — citywide map, no API key required
- **Tailwind CSS v4** — styling

## Quick start

```bash
npm install
npm run fetch:real   # pull real data from the NYC Open Data API
npm run load:data    # load it into SQLite
npm run dev          # http://localhost:3000
```

Offline or want a tiny demo dataset instead? `npm run setup:data` generates and
loads mock data using the identical schema.

## Feature map

| # | Feature | Where |
|---|---|---|
| 1 | School search + citywide map, color-coded by compliance gap | `/` — [components/HomeExplorer.tsx](components/HomeExplorer.tsx), [components/SchoolMap.tsx](components/SchoolMap.tsx) |
| 2 | School detail page: class size vs. cap, building utilization, plain-language status, space-deficit flag | `/school/[dbn]` — [app/school/[dbn]/page.tsx](app/school/[dbn]/page.tsx) |
| 3 | *(removed — the physical-capacity check and space toolkit answer this directly)* | — |
| 4 | Room-repurposing solver (greedy heuristic, ranked suggestions) | Space toolkit "Repurpose a room" tab — [lib/solver.ts](lib/solver.ts) |
| 5 | Nearby-school capacity finder | [lib/queries.ts](lib/queries.ts) `findNearbyCapacityOptions` |
| 6 | Longer-term solutions: nearby-school redistribution + new construction | Detail page, under the toolkit — [components/LongerTermSolutions.tsx](components/LongerTermSolutions.tsx) |
| 7 | Space toolkit: split a room, repurpose a room, extend the day, teachers needed | Detail page — [components/SpaceToolkit.tsx](components/SpaceToolkit.tsx); logic in [lib/roomSplit.ts](lib/roomSplit.ts), [lib/solver.ts](lib/solver.ts), [lib/schedule.ts](lib/schedule.ts), [lib/teachers.ts](lib/teachers.ts) |
| 8 | Candidate sites for a new building | "New construction" section — [lib/queries.ts](lib/queries.ts) `findSiteCandidates` |
| 8b | Funded SCA capacity projects — this school's own expansion, plus in-flight projects within 3 miles | "New construction" section — [lib/queries.ts](lib/queries.ts) `findCapacityProjects` |
| 9 | Administrator guide (exemptions, staffing, restructuring, capital) | `/admin-guide` — [app/admin-guide/page.tsx](app/admin-guide/page.tsx) |

## Data model

Normalized SQLite schema (see [scripts/load-data.ts](scripts/load-data.ts)):

- **schools** — `dbn` (PK), name, borough, district, school_type, lat, lng, building_id
- **class_size_records** — dbn (FK), grade_band (`K-3` / `4-8` / `9-12`), num_classes, num_students, avg_class_size, target_cap
- **building_utilization** — building_id (PK), capacity, enrollment, utilization_pct, co_located, num_schools_in_building
- **space_deficit_schools** — dbn (FK) — NYCPS's own confirmed space-deficit list
- **room_inventory** — building_id (FK), room_type (Classroom/Kindergarten/Special Education/Science Lab/Computer Lab/Art/Music/Dance-Theatre/Library/Gym/Cafeteria/Auditorium/Multi-Purpose/Vacant), room_count, typical_capacity, **sqft** (median measured area) — used by the fast-track solver and the building-utilization summary
- **room_capacity_detail** *(optional)* — building_id (FK), room_type, **sqft**, room_count — the same rooms as `room_inventory` but **not collapsed to a median**: one row per distinct measured area, so a building's 16 "classrooms" spanning 154–704 sqft stay 11 rows instead of becoming one. Rooms of one type in one building vary widely (~60% of buildings), and both the HS physical-capacity check and the room-splitting tool need to know which *individual* rooms are big enough. Covers every room type; each consumer filters to the slice it should count.
- **parcels** *(optional)* — parcel_id (PK), description, district, lat, lng, lot_sqft, borough, **bbl**, ownership — city-owned land powering the candidate-site finder. `description` is COLP's address string and is **unreliable**: often a bare street name with no house number, and null for ~3%. `bbl` (Borough-Block-Lot) is present on 100% of rows and is the authoritative way to identify a lot.
- **capacity_projects** *(optional)* — project_id (PK), name, **project_type** (`expansion` / `new_school`), dbn, matched_school_name, seats, anticipated_opening, address, borough, district, lat, lng, bbl — the SCA's in-flight capacity program. Deliberately **not** foreign-keyed to `schools`: `dbn` is null on every new-school build (they have no school yet). `district` is TEXT because the source mixes citywide pseudo-districts (`78M`, `78Q`) with numeric ones, and `lat`/`lng` are nullable because two rows publish no coordinates.

## Real NYC Open Data

The app now ships with **real data ingested from the NYC Open Data (Socrata) API**.

```bash
npm run fetch:real   # pulls live from NYC Open Data into data/raw/
npm run load:data    # loads data/raw/*.csv into SQLite
```

`npm run setup:data` still regenerates the small **mock** dataset instead, which
is useful for offline demos. The two share the same CSV contract, so the loader
and the whole app are identical either way.

Optionally set `NYC_APP_TOKEN` (a free Socrata app token) to raise rate limits.

### Datasets used

| Dataset | Socrata ID | Used for |
|---|---|---|
| 2019-20 School Locations | `wg9x-4ke6` | DBN, name, lat/long, district, building code, school type |
| 2021-22 Average Class Size by School | `sgr7-hhwp` | K-3 and 4-8 class size (**K-8 only**) |
| 2018-19 Average Class Size School MSHS | `puec-8mer` | 9-12 class size (HS Core rows only) |
| Enrollment Capacity & Utilization ("Blue Book") | `gkd7-3vk7` | building capacity, enrollment, utilization, co-location |
| DOE Building Space Usage | `wavz-fkw8` | **per-room measured length/width/area + room function** — the source of room square footage, cafeteria size, and vacant rooms |
| City Owned and Leased Property (COLP) | `fn4k-qyk2` | real city-owned vacant parcels for the candidate-site finder |
| Capacity Projects in Process Site Locations (SCA) | `dtmw-avzj` | funded, scheduled seat additions — school expansions and new buildings, with opening years |

Current ingest: **1,490 schools, 2,341 class size records, 1,141 buildings,
10,221 room-inventory rows, 3,132 city-owned parcels, 18 SCA capacity
projects** — 100% of schools matched to Blue Book utilization data, and 99% of
buildings matched to measured room data (1,047 with a cafeteria, 301 vacant
rooms found).

#### Capacity projects: expansions vs. new schools

`dtmw-avzj` is small (18 projects, 8,205 seats, opening 2026–2028) but it is the
only source in the app describing capacity that is actually **funded and
scheduled**, as opposed to the speculative COLP parcels next to it in the UI.
It has two kinds of row, distinguished only by how the project is named:

- **Expansions** (9 projects, 3,445 seats) — `P.S. 206 ADDITION`,
  `JOHN BOWNE HS ANNEX`. Seats bolted onto a school that already exists, so they
  relieve *that school's* overcrowding directly.
- **New schools** (9 projects, 4,760 seats) — `P.S. @ 46-10 70 STREET`,
  `P.S. @ PARCEL C`. New buildings named for their address because no school has
  been sited in them yet. They relieve the surrounding area, not one school.

The school page keeps those strictly separate — a "+487 seats" headline means
something very different to a principal depending on whether the seats land in
their building or in a new school half a mile away.

**Matching expansions to a DBN** ([scripts/fetch-capacity-projects.ts](scripts/fetch-capacity-projects.ts)):
the source carries no DBN, only a project name, a district, and usually
coordinates — so matching is name + proximity, and deliberately conservative
(same borough, within 1 mile, ranked by school-number match → compatible school
level → distance). The level check is load-bearing: `JOHN BOWNE HS ANNEX` sits
almost equidistant between *John Bowne High School* and *P.S. 020 John Bowne*.
Two rows publish **no coordinates**, and proximity is exactly what disambiguates
them (`HARBOR HIGH SCHOOL ATHLETIC COMPLEX` scores identically against *Harbor
Heights* and *Urban Assembly New York Harbor School* on name alone); those are
resolved by a small, hand-verified override table rather than by loosening the
matcher for every other row. All 9 expansions currently resolve. Any that
doesn't is reported loudly at fetch time and written with an empty DBN — it
still appears as an area project, it just isn't attributed to a school.

The projects file can be refreshed on its own with `npm run fetch:projects`
(it reads back `data/raw/school_locations.csv`, so a full `fetch:real` must have
run at least once).

### Real data caveats

These are surfaced in the UI, not just documented here.

- **The class size data predates the mandate.** The newest school-level figures
  on Open Data are 2021-22 (K-8) and 2018-19 (HS). The mandate phases in from
  2022-23, so compliance gaps shown are historical baselines, not current
  enforcement status. Each record carries its `source_year`, displayed on the
  school page.
- **High school counts are course sections, not headcount.** HS class size is
  reported per core course section, so a student taking five core courses
  appears five times. The *average* is valid (seats ÷ sections); the totals are
  not enrollment. The UI relabels these as "core sections" / "student course
  seats". The teacher calculator uses them as-is and correctly: course seats
  divided by the cap is exactly the number of sections that have to run.
- **Self-contained special education classes are excluded** (program types
  `SC 12:1`, `SC 8:1:1`, …). Their caps come from IEP/state SPED regulation,
  not the class size law, so averaging them in would distort compliance.
  2,336 such rows were filtered.
- **A few source records are implausible.** 3 band records aggregate above 40
  students/class — e.g. `sgr7-hhwp` reports 71 ICT students in "1 class" at
  24Q560. These are flagged `data_quality = 'suspect'`, excluded from map
  colouring and rankings, and shown with a warning on the school page.
- **Room square footage is real; room *capacity* is derived.** `wavz-fkw8`
  publishes measured length/width/area per room, so the splitting tool runs on
  actual dimensions. No NYC dataset publishes a room's seat count, so capacity
  is computed from area and labelled as derived everywhere it appears:
  instructional rooms at 20 sqft/pupil, kindergarten at 35, cafeterias at 15
  sqft/person (NYC Building Code Table 1004.5, assembly seating at tables and
  chairs). A code occupant load is a legal ceiling, not installed furniture —
  a real cafeteria seats fewer — so every derived figure stays user-editable.
- **Specialty rooms get no derived capacity at all.** Science/computer labs, art
  and music rooms are constrained by benches and equipment, not floor area, so
  dividing by 20 sqft/pupil would invent a 98-seat computer lab. Those are left
  blank.
- **Room area is per building, not per school.** Co-located schools share one
  building's room list, so a building's rooms are not all available to any one
  school in it.
- **The room data is a stacked snapshot table.** `wavz-fkw8` holds ~9 dated
  snapshots; the loader queries `max(data_as_of)` at runtime rather than pinning
  a date, so it won't silently go stale.
- **The NYCPS confirmed space-deficit list is PDF-only.** It appears in the
  annual Class Size Reduction Plan, not as a dataset, so
  `space_deficit_schools.csv` is emitted empty and the deficit banner simply
  doesn't render. See "What still needs you" below.
- **COLP publishes no lot area**, so candidate sites show real city-owned
  vacant parcels without a buildable-seat estimate.
- **SCA seat counts and opening years move.** `dtmw-avzj` is the authority's own
  in-flight pipeline, and figures shift as projects pass through design,
  procurement, and construction. The UI presents them as anticipated, not
  committed. It also compares a project's seats only against the *building's*
  Blue Book overcrowding — the like-for-like figure, since both are building
  capacity — and never against a class-size gap, which new seats don't by
  themselves fix.
- **Expansion→school links are inferred, not published.** See "Capacity
  projects" above: the source has no DBN. The match is conservative and
  currently resolves all 9 expansions, but it is an inference and the UI says so.

### What still needs manual work

These sources are PDFs or web pages, not APIs. Drop them in and re-run
`npm run load:data`:

1. **NYCPS Class Size Reduction Plan** (annual PDF) — the confirmed
   space-deficit school list. Fill `data/raw/space_deficit_schools.csv`
   (`DBN,Confirmed Space Deficit`).
2. **SCA Five-Year Capital Plan** — the *funded but not yet in process* pipeline.
   Projects already in process now come from `dtmw-avzj` (see above); the
   five-year plan PDF covers proposed seats further out, which no API exposes.
3. **Installed cafeteria seat counts** — the app derives seating from measured
   area at the building-code occupant load, which overstates real furniture. An
   actual seat count per building would tighten the lunch calculator.
4. **Newer class size data**, if NYCPS publishes a post-mandate school-level
   report — this is the single biggest accuracy upgrade available.

## Design notes

- **Compliance gap** = `avg_class_size - target_cap` for a school's worst
  grade band, floored at 0. Drives map marker color and search-list sorting.
  Tiers: within cap (green) → slightly over (yellow, ≤2) → overcrowded
  (orange, ≤5) → severely overcrowded (red, >5). See [lib/compliance.ts](lib/compliance.ts).
- **HS physical-capacity check** overrides the compliance gap for single-band
  9-12 schools: NYC's HS class-size data reports course *sections*, not
  rooms, so a school can show a severely-over-cap average purely because it
  schedules too few, too-big sections while its actual classrooms sit
  mostly empty (real example: Satellite Academy HS reports a 36.3 average
  but has 255 real students and 16 classrooms — comfortably enough space).
  The check sums each classroom's own capacity (measured floor area ÷ 20
  sqft/pupil, capped at the mandate cap — real buildings mix room sizes
  within one type, so this is done per room, not room-count × average) and
  compares it to real Blue Book enrollment. If the rooms can hold everyone
  under cap, the school is reclassified compliant — a scheduling problem,
  not a space one — and the map/list are driven by that instead. If not,
  the real shortfall (excess students / additional classrooms needed)
  drives severity, on a scale that can run well past the old avg-based one
  for large genuinely overcrowded schools (Fort Hamilton HS: 4,317
  students, 66 classrooms, real shortfall ≈113 classrooms). Deliberately
  narrow scope: only single-band 9-12 schools (K-8 headcount is already
  real; multi-band schools share a room pool across caps with no reliable
  way to split), and only where both real enrollment and real per-room
  area exist — see `computeHsPhysicalCapacity` in
  [lib/queries.ts](lib/queries.ts).
- **Fast-track solver** (feature 4) is explicitly a **greedy heuristic, not
  an optimizer**: it walks room types in a fixed least-disruptive-first
  order (Library/Art/Music → Cafeteria via lunch staggering → Science
  Lab/Gym) and greedily assigns them against the shortfall. It won't always
  find the minimum-disruption combination — it finds a fast, explainable one.
- **Nearby-school finder** (feature 5) only matches schools of the same
  `school_type` (so a high school's overcrowding isn't "solved" by an
  elementary school with room), within 3 miles, under 90% building
  utilization. Each destination reports **how many students it could actually
  take**: `cap × classes − students` per band at that band's own cap (20 /
  23 / 25 — a flat 25 would claim elementary seats the mandate forbids),
  then bounded by the building's Blue Book capacity, since section headroom
  says nothing about whether the building holds the children. For 9-12 that
  subtraction yields spare *course seats*, not students — a student consumes
  several at once — so it is divided by that school's own courses-per-student,
  derived as `course seats ÷ real Blue Book enrollment` rather than assumed.
  Schools with no headroom are dropped entirely. Results are explicitly
  labeled "technically feasible," not a recommendation — commute costs are
  real for families. See `computeSpareSeats` in [lib/queries.ts](lib/queries.ts).
- **Candidate-site addresses are unreliable, by source.** COLP records many
  parcels as a bare street name ("GREENE AVENUE") and ~3% with no address at
  all, so every parcel is shown with its **BBL** and its **coordinates**
  alongside deep links to Google Maps and ZoLa. The UI says plainly that the
  address may be incomplete rather than presenting a street name as if it
  were a location.
- **Room splitting** exists because a room hosts only ONE section, so it
  seats no more than the mandate cap however large it is: a 1,300 sqft room
  with a physical capacity of 65 still seats 25 in a high school, and the
  other 40 seats are dead floor area the mandate (correctly) won't let one
  teacher take. Divide it and each piece runs its own section. Pieces are
  **20 students each** (the smallest room worth building, and the K-3 cap),
  so a room yields `floor(physicalCapacity / 20)` pieces and needs at least
  2 to qualify — a 65-capacity room becomes 3 rooms of 20, i.e. 60 seats
  where there were 25. Capacity comes from **measured per-room floor area**
  at 20 sqft/pupil (35 for kindergarten) via `room_capacity_detail`, not the
  building median, since which *individual* rooms are big enough is the
  whole question. Selectable per room group, with a running total in seats
  and classroom-equivalents. See [lib/roomSplit.ts](lib/roomSplit.ts).
- **Oversized-room guard.** The source carries records like a 14,801 sqft
  "Science Lab" and a 5,852 sqft "Classroom" — a whole floor or wing booked
  against one room number, not a room anyone could wall in half. Left in, a
  single such row would claim hundreds of seats and swamp every real result.
  Rooms over **2,000 sqft** (roughly the top 1% of splittable types; the
  median room is 650) are excluded from splitting and surfaced in the UI
  rather than dropped silently.
- **Extended-day cohorts** model staggered start times: if the building runs
  more periods (P) than a student's schedule fills (L), cohorts share the
  same rooms across a longer day. That allows `k = P − L + 1` cohorts, and
  the binding constraint is the middle of the day, when all of them are on
  site at once — a window of `2L − P` periods (≤ 0 means the earliest cohort
  leaves before the latest arrives, so peak load never reaches full
  enrollment and the building fits by construction). Classroom capacity is
  **real per-room instructional seats**, not `rooms × cap` — rooms vary too
  much for that — and it picks up any splits selected in the first tab.
  **A student eats lunch once**, so the cafeteria never holds more than one
  period's share: demand is `N / overlap` per conflict period, and what the
  room actually takes off the classrooms is `min(Caf, N / overlap)`, not
  `Caf`. Crediting the full cafeteria would treat it as permanent overflow
  space every student occupies all day — with 8 conflict periods only an
  eighth of the school is at lunch at any moment. When `Caf` is the smaller
  term the cafeteria is saturated: full every period and still unable to feed
  everyone in the window, which the UI says explicitly. Gym and auditorium
  are excluded from the room count; the cafeteria is sized at the Building
  Code's 15 sqft/person assembly load. A peak-load check, not a bell-schedule
  generator. See [lib/schedule.ts](lib/schedule.ts).
- **Teacher need** converts a compliance gap into sections first
  (`ceil(students / cap) − current sections`), then into people. Not
  one-to-one: a teacher covers several sections a day, so the section count
  is divided by an adjustable **sections-per-teacher** figure defaulting to 5
  (the UFT high school programmed day is 5 teaching periods plus a
  professional period and a prep). The dollar figure is one flat
  $100,000 constant for order of magnitude only — real cost depends on step
  and differentials, and benefits add roughly another 35–45% on top of base.
  NYCPS's own citywide estimate of 10,000–12,000 additional teachers is shown
  as a scale check. See [lib/teachers.ts](lib/teachers.ts).
- **Candidate sites** are explicitly labeled illustrative starting points,
  not siting recommendations. Real NYC school siting runs through the SCA
  capital plan, Real Estate Services acquisition, a 45-day public comment
  period, and Community Board / CEC hearings.
- **Administrator guide** is compiled from public NYCPS, NYSED, UFT, SCA and
  news sources, with per-section source links, and carries a "verify before
  acting" banner. Note the compliance timeline changed materially in June
  2026 (full compliance moved from Sept 2028 to Sept 2030) — this content
  needs periodic re-checking.
- No auth, no user accounts, single session, desktop-only — per hackathon
  scope.
