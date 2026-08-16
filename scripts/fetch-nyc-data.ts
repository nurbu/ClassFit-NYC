/**
 * Fetches REAL NYC Open Data (Socrata API) and writes it into data/raw/ using
 * the same CSV contract that scripts/load-data.ts already consumes.
 *
 * Run with: npm run fetch:real   (then: npm run load:data)
 *
 * Datasets used (all public, no key required; set NYC_APP_TOKEN to raise rate limits):
 *
 *   wg9x-4ke6  2019-2020 School Locations
 *              -> DBN, name, lat/long, district, building code, school type
 *   sgr7-hhwp  2021-2022 Average Class Size by School  (K-8 ONLY)
 *              -> grades K..8 average class size / class counts
 *   puec-8mer  2018-2019 Average Class Size School MSHS (HS Core rows only)
 *              -> grades 9-12 average class size
 *   gkd7-3vk7  Enrollment Capacity And Utilization Reports ("Blue Book", data as of 2023-01)
 *              -> building capacity/enrollment/utilization, co-location,
 *                 cluster (specialty) room counts
 *   dtmw-avzj  Capacity Projects in Process Site Locations (SCA)
 *              -> in-flight additions/annexes and new school buildings, with
 *                 seat counts and anticipated opening years. Fetched and
 *                 matched to schools by scripts/fetch-capacity-projects.ts.
 *   wavz-fkw8  DOE Building Space Usage (latest snapshot; ~117k rooms)
 *              -> per-ROOM length/width/area + room function, keyed by bldg_id.
 *                 This is the real source of room square footage and of
 *                 cafeteria size. Multiple dated snapshots exist; only the
 *                 newest is used.
 *
 * KNOWN LIMITATIONS -- see README "Real data caveats":
 *   - Newest school-level class size on Open Data is 2021-22 (K-8) and
 *     2018-19 (HS). Both PREDATE the class size mandate's phase-in, so the
 *     compliance gaps shown are historical, not current-year enforcement.
 *   - Self-contained special-education classes (program_type "SC ...") are
 *     EXCLUDED: their caps come from IEP/state SPED regulation, not the
 *     class size law, so averaging them in would distort compliance.
 *   - "MS Core" rows in puec-8mer are skipped to avoid double-counting
 *     grades 6-8, which sgr7-hhwp already covers.
 *   - Room square footage is REAL (wavz-fkw8 publishes measured length/width/
 *     area per room). Room *capacity* is not published anywhere, so it is
 *     DERIVED from area and labelled as such in the UI:
 *       instructional rooms -> area / 20 sqft-per-pupil (NYC building-code /
 *         DOE planning minimum; the same constant lib/roomSplit.ts uses)
 *       cafeterias          -> area / 15 sqft-per-person (NYC Building Code
 *         Table 1004.5 occupant load, "assembly, unconcentrated -- tables and
 *         chairs"). This is a code occupant load, i.e. an upper bound on
 *         seating, not a count of installed seats. NYCPS publishes no seat
 *         count; this is the closest defensible figure and stays editable.
 *   - The NYCPS confirmed space-deficit list is published only in the annual
 *     Class Size Reduction Plan PDF, not as a dataset, so
 *     space_deficit_schools.csv is emitted empty (header only).
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { writeCapacityProjects } from "./fetch-capacity-projects";

const RAW_DIR = join(process.cwd(), "data", "raw");
const SOCRATA = "https://data.cityofnewyork.us/resource";
const APP_TOKEN = process.env.NYC_APP_TOKEN;

const DATASETS = {
  locations: "wg9x-4ke6",
  classSizeK8: "sgr7-hhwp",
  classSizeMSHS: "puec-8mer",
  blueBook: "gkd7-3vk7",
  cityProperty: "fn4k-qyk2",
  roomSpace: "wavz-fkw8",
} as const;

const BOROUGH_BY_CODE: Record<string, string> = {
  "1": "Manhattan",
  "2": "Bronx",
  "3": "Brooklyn",
  "4": "Queens",
  "5": "Staten Island",
};

type Row = Record<string, string>;

/** Page through a Socrata dataset until exhausted. */
async function fetchDataset(id: string, select?: string, where?: string): Promise<Row[]> {
  const pageSize = 50000;
  const out: Row[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({ $limit: String(pageSize), $offset: String(offset) });
    if (select) params.set("$select", select);
    if (where) params.set("$where", where);
    const res = await fetch(`${SOCRATA}/${id}.json?${params}`, {
      headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {},
    });
    if (!res.ok) {
      throw new Error(`Socrata ${id} failed: ${res.status} ${res.statusText}\n${await res.text()}`);
    }
    const page = (await res.json()) as Row[];
    out.push(...page);
    process.stdout.write(`\r  ${id}: ${out.length} rows`);
    if (page.length < pageSize) break;
  }
  process.stdout.write("\n");
  return out;
}

/**
 * wavz-fkw8 keeps ~9 dated snapshots stacked in one table. Ask the API which
 * is newest rather than hardcoding a date that will silently go stale.
 */
async function latestSnapshot(id: string, field: string): Promise<string> {
  const res = await fetch(`${SOCRATA}/${id}.json?$select=max(${field})+as+latest`, {
    headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {},
  });
  if (!res.ok) throw new Error(`Socrata ${id} snapshot probe failed: ${res.status}`);
  const [row] = (await res.json()) as { latest: string }[];
  if (!row?.latest) throw new Error(`Socrata ${id}: no ${field} values`);
  return row.latest;
}

const pad2 = (d: string) => String(d).trim().padStart(2, "0");

/** DBN = 2-digit geographic district + location code (e.g. 15 + K001 -> 15K001). */
const toDbn = (district: string, locationCode: string) => pad2(district) + locationCode.trim().toUpperCase();

const BOROUGH_BY_LETTER: Record<string, string> = {
  M: "Manhattan",
  X: "Bronx",
  K: "Brooklyn",
  Q: "Queens",
  R: "Staten Island",
};

/** Collapse DOE's location categories onto the app's school_type values. */
function toSchoolType(category: string): string {
  const c = (category || "").toLowerCase();
  if (c.includes("k-8")) return "K8";
  if (c.includes("k-12")) return "K12";
  if (c.includes("elementary")) return "ES";
  if (c.includes("early childhood")) return "EC";
  if (c.includes("junior high") || c.includes("middle")) return "MS";
  if (c.includes("secondary") || c.includes("high school")) return "HS";
  return "OTHER";
}

/** Mandate caps: 20 (K-3), 23 (4-8), 25 (9-12). */
const CAPS: Record<string, number> = { "K-3": 20, "4-8": 23, "9-12": 25 };

/**
 * wavz-fkw8 uses 112 room functions. Collapse the ones that represent usable
 * teaching or convertible space onto the app's room_type vocabulary; anything
 * unlisted (offices, storage, bathrooms, kitchens, corridors) is dropped --
 * it is not space a school could turn into a classroom.
 *
 * "Vacant" is kept deliberately: those are rooms already standing empty, the
 * cheapest possible source of capacity, so the solver should see them first.
 */
const ROOM_FUNCTION_MAP: Record<string, string> = {
  "REGULAR CLASSROOM": "Classroom",
  "REGULAR CLASSROOM - MS GRADES": "Classroom",
  "REGULAR CLASSROOM - HS GRADES": "Classroom",
  "FIRST GRADE": "Classroom",
  "SECOND GRADE": "Classroom",
  "THIRD GRADE": "Classroom",
  "FOURTH GRADE": "Classroom",
  "FIFTH GRADE": "Classroom",
  "SIXTH GRADE": "Classroom",
  "SEVENTH GRADE": "Classroom",
  "EIGHTH GRADE": "Classroom",
  "ICT - ELEMENTARY SCHOOL GRADES": "Classroom",
  "ICT - MIDDLE SCHOOL GRADES": "Classroom",
  "ICT - HIGH SCHOOL GRADES": "Classroom",
  CTT: "Classroom",
  "MULTI-PURPOSE CLASSROOM": "Classroom",
  "SCIENCE CLASSROOM FOR PS": "Classroom",
  // Kept apart: kindergarten rooms carry a 35 sqft/pupil standard, not 20.
  KINDERGARTEN: "Kindergarten",
  "PRE-K FULL DAY": "Kindergarten",
  // Kept apart: statutory SPED ratios, not the class size mandate's caps.
  "D75 SPED CLASSROOM": "Special Education",
  "NON-D75 SPED CLASSROOM": "Special Education",
  "SCIENCE LAB": "Science Lab",
  "SCIENCE DEMO ROOM": "Science Lab",
  "COMPUTER LAB": "Computer Lab",
  "ART ROOM": "Art",
  "MUSIC ROOM": "Music",
  "DANCE ROOM": "Dance/Theatre",
  "THEATRE ARTS/DRAMA": "Dance/Theatre",
  LIBRARY: "Library",
  "MEDIA CENTER": "Library",
  GYMNASIUM: "Gym",
  "AUXILIARY EXERCISE ROOM": "Gym",
  "STUDENT CAFETERIA": "Cafeteria",
  AUDITORIUM: "Auditorium",
  "MULTI-PURPOSE ROOM": "Multi-Purpose",
  "MULTI-PURPOSE NON CLASSROOM": "Multi-Purpose",
  VACANT: "Vacant",
};

/** NYC building-code / DOE planning minimum floor area per pupil. */
const SQFT_PER_PUPIL = 20;
const SQFT_PER_PUPIL_KINDERGARTEN = 35;
/**
 * NYC Building Code Table 1004.5, "assembly without fixed seating --
 * unconcentrated (tables and chairs)": 15 net sqft per occupant. An occupant
 * load is a legal ceiling, not an installed-seat count, so the UI presents the
 * result as a derived upper bound and lets the user override it.
 */
const SQFT_PER_CAFETERIA_SEAT = 15;

/** Median is used instead of mean so one oversized room can't skew a building. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Derived per-room capacity, or "" when area does not govern capacity.
 *
 * Only general instructional rooms get an area-derived number: for those, floor
 * area really is the binding constraint. Specialty rooms (science/computer labs,
 * art, music) are excluded on purpose -- their capacity is set by benches,
 * workstations and equipment, not by square footage, so dividing by 20 produces
 * nonsense (a 1,960 sqft computer lab is not a 98-seat room).
 */
function derivedCapacity(roomType: string, medianSqft: number): number | "" {
  if (roomType === "Cafeteria") return Math.floor(medianSqft / SQFT_PER_CAFETERIA_SEAT);
  if (roomType === "Kindergarten") return Math.floor(medianSqft / SQFT_PER_PUPIL_KINDERGARTEN);
  const areaGoverned = ["Classroom", "Special Education", "Vacant"];
  return areaGoverned.includes(roomType) ? Math.floor(medianSqft / SQFT_PER_PUPIL) : "";
}

/**
 * Above this, a band average is treated as a source-data reporting artifact
 * rather than a real class size. NYC's largest contractual cap is 34 (high
 * school), so a 40+ average implies students were attributed to too few
 * sections -- e.g. sgr7-hhwp reports 71 ICT students in "1 class" at 24Q560.
 * Such records are kept but flagged, not silently dropped.
 */
const IMPLAUSIBLE_AVG_CLASS_SIZE = 40;

/** Map a raw grade_level value onto a mandate grade band, or null to skip. */
function toGradeBand(gradeLevel: string): "K-3" | "4-8" | null {
  const g = gradeLevel.trim().toUpperCase();
  if (g === "K") return "K-3";
  const n = Number(g);
  if (!Number.isNaN(n)) {
    if (n >= 1 && n <= 3) return "K-3";
    if (n >= 4 && n <= 8) return "4-8";
  }
  return null; // "K-8 SC" and anything unexpected
}

/**
 * Self-contained special-education classes have statutory caps set by IEP /
 * state SPED regulation (12:1, 8:1:1, ...), not by the class size law.
 */
const isMandateProgram = (programType: string) => !/^SC\b/i.test((programType || "").trim());

function csvEscape(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const lines = [header.join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  writeFileSync(join(RAW_DIR, filename), lines.join("\n") + "\n");
  console.log(`  wrote ${filename} (${rows.length} rows)`);
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  console.log("Fetching NYC Open Data…");

  const roomSnapshot = await latestSnapshot(DATASETS.roomSpace, "data_as_of");
  console.log(`  room space snapshot:        ${roomSnapshot.slice(0, 10)}`);

  const [locations, csK8, csMSHS, blueBook, cityProperty, roomSpace] = await Promise.all([
    fetchDataset(DATASETS.locations),
    fetchDataset(DATASETS.classSizeK8),
    fetchDataset(DATASETS.classSizeMSHS),
    fetchDataset(DATASETS.blueBook),
    fetchDataset(
      DATASETS.cityProperty,
      "borough,address,parcel_name,agency,use_type,excatdesc,latitude,longitude,bbl"
    ),
    fetchDataset(
      DATASETS.roomSpace,
      "bldg_id,room_function,area",
      `data_as_of='${roomSnapshot}'`
    ),
  ]);

  // ---------- schools ----------
  // Keep one row per DBN, preferring entries that carry coordinates.
  const schoolByDbn = new Map<string, Row>();
  for (const l of locations) {
    const district = l.geographical_district_code;
    const code = l.location_code;
    if (!district || !code || !l.latitude || !l.longitude) continue;
    const dbn = toDbn(district, code);
    if (!schoolByDbn.has(dbn)) schoolByDbn.set(dbn, l);
  }

  // ---------- class size ----------
  // Aggregate to (dbn, band): weighted average = total students / total classes.
  interface BandAgg {
    students: number;
    classes: number;
    sourceYear: string;
  }
  const bandAgg = new Map<string, BandAgg>();
  const addBand = (dbn: string, band: string, students: number, classes: number, sourceYear: string) => {
    if (!Number.isFinite(students) || !Number.isFinite(classes) || classes <= 0) return;
    const key = `${dbn}|${band}`;
    const prev = bandAgg.get(key) ?? { students: 0, classes: 0, sourceYear };
    prev.students += students;
    prev.classes += classes;
    bandAgg.set(key, prev);
  };

  let skippedSpecialEd = 0;
  for (const r of csK8) {
    if (!isMandateProgram(r.program_type)) {
      skippedSpecialEd++;
      continue;
    }
    const band = toGradeBand(r.grade_level);
    if (!band || !r.dbn) continue;
    addBand(r.dbn, band, Number(r.number_of_students), Number(r.number_of_classes), "2021-22");
  }

  // HS Core only -- "MS Core" would double-count grades 6-8 from the K-8 file.
  let hsRows = 0;
  for (const r of csMSHS) {
    if ((r.grade_level || "").trim().toUpperCase() !== "HS CORE") continue;
    if (!isMandateProgram(r.program_type)) {
      skippedSpecialEd++;
      continue;
    }
    if (!r.dbn) continue;
    hsRows++;
    addBand(r.dbn, "9-12", Number(r.number_of_students), Number(r.number_of_classes), "2018-19");
  }

  // ---------- Blue Book ----------
  // Building-level facts, plus per-organization rows used for co-location counts.
  interface BuildingAgg {
    capacity: number;
    enrollment: number;
    orgs: Set<string>;
  }
  const buildings = new Map<string, BuildingAgg>();
  // Blue Book reports enrollment per ORGANIZATION (school), separate from the
  // building total -- this is the real, per-school headcount, distinct from
  // building_utilization.enrollment which is shared across every co-located
  // school. Some org rows are non-school entities (e.g. "XUFT"); those simply
  // won't match a real DBN below and are harmlessly ignored.
  const orgEnrollByDbn = new Map<string, number>();

  for (const r of blueBook) {
    const bldg = (r.bldg_id || "").trim();
    if (!bldg) continue;
    const agg = buildings.get(bldg) ?? { capacity: 0, enrollment: 0, orgs: new Set<string>() };
    // Building-level capacity/enrollment repeat across that building's rows.
    const cap = Number(r.target_bldg_cap);
    const enr = Number(r.bldg_enroll);
    if (Number.isFinite(cap) && cap > 0) agg.capacity = cap;
    if (Number.isFinite(enr) && enr > 0) agg.enrollment = enr;
    // Count only real school organizations (they report their own enrollment).
    if (r.org_id && r.org_enroll) agg.orgs.add(r.org_id.trim());
    buildings.set(bldg, agg);

    if (r.org_id && r.geo_dist) {
      const orgEnr = Number(r.org_enroll);
      if (Number.isFinite(orgEnr) && orgEnr > 0) {
        orgEnrollByDbn.set(toDbn(r.geo_dist, r.org_id), orgEnr);
      }
    }
  }

  // ---------- emit school_locations.csv ----------
  // Only keep schools we actually have class size data for -- otherwise the
  // map fills with points that have nothing to show.
  const dbnsWithClassSize = new Set([...bandAgg.keys()].map((k) => k.split("|")[0]));
  const emittedSchools: { dbn: string; buildingId: string }[] = [];
  const schoolRows: (string | number)[][] = [];

  for (const [dbn, l] of schoolByDbn) {
    if (!dbnsWithClassSize.has(dbn)) continue;
    const buildingId = (l.primary_building_code || "").trim();
    const boroughLetter = dbn.charAt(2);
    schoolRows.push([
      dbn,
      l.location_name || dbn,
      BOROUGH_BY_LETTER[boroughLetter] ?? "Unknown",
      Number(l.geographical_district_code),
      toSchoolType(l.location_category_description),
      Number(l.latitude),
      Number(l.longitude),
      buildingId,
      orgEnrollByDbn.get(dbn) ?? "",
    ]);
    emittedSchools.push({ dbn, buildingId });
  }

  writeCsv(
    "school_locations.csv",
    ["DBN", "School Name", "Borough", "District", "School Type", "Latitude", "Longitude", "Building ID", "Enrollment"],
    schoolRows
  );

  // ---------- emit class_size.csv ----------
  const emittedDbns = new Set(emittedSchools.map((s) => s.dbn));
  const classSizeRows: (string | number)[][] = [];
  let suspectRecords = 0;

  for (const [key, agg] of bandAgg) {
    const [dbn, band] = key.split("|");
    if (!emittedDbns.has(dbn)) continue;
    const avg = agg.students / agg.classes;
    const suspect = avg > IMPLAUSIBLE_AVG_CLASS_SIZE;
    if (suspect) suspectRecords++;
    classSizeRows.push([
      dbn,
      band,
      agg.classes,
      agg.students,
      Math.round(avg * 10) / 10,
      CAPS[band],
      agg.sourceYear,
      suspect ? "suspect" : "ok",
    ]);
  }

  writeCsv(
    "class_size.csv",
    [
      "DBN",
      "Grade Band",
      "Number Of Classes",
      "Number Of Students",
      "Average Class Size",
      "Target Cap",
      "Source Year",
      "Data Quality",
    ],
    classSizeRows
  );

  // ---------- emit building_utilization.csv ----------
  const usedBuildings = new Set(emittedSchools.map((s) => s.buildingId).filter(Boolean));
  const buildingRows: (string | number)[][] = [];
  for (const [bldg, agg] of buildings) {
    if (!usedBuildings.has(bldg)) continue;
    if (agg.capacity <= 0) continue;
    const numSchools = Math.max(1, agg.orgs.size);
    buildingRows.push([bldg, agg.capacity, agg.enrollment, numSchools > 1 ? "Y" : "N", numSchools]);
  }
  writeCsv(
    "building_utilization.csv",
    ["Building ID", "Capacity", "Enrollment", "Co-Located", "Num Schools In Building"],
    buildingRows
  );

  // ---------- emit room_inventory.csv ----------
  // Real measured rooms from wavz-fkw8: one row per (building, room type) with
  // an actual room count and the MEDIAN measured area of those rooms. Capacity
  // is derived from area (see derivedCapacity) because no seat count exists in
  // any published NYC dataset.
  // Keyed off the rows actually written to building_utilization.csv, not off
  // the schools table: room_inventory has a FK to that table, and a handful of
  // school building codes never appear in the Blue Book.
  const neededBuildings = new Set(buildingRows.map((r) => String(r[0])));
  const areasByBuildingType = new Map<string, Map<string, number[]>>();
  let roomsSkippedNoArea = 0;

  for (const r of roomSpace) {
    const bldg = (r.bldg_id || "").trim();
    if (!bldg || !neededBuildings.has(bldg)) continue;
    const roomType = ROOM_FUNCTION_MAP[(r.room_function || "").trim().toUpperCase()];
    if (!roomType) continue;
    const area = Number(r.area);
    // A handful of rows carry 0/blank area, and a few are clearly bad
    // measurements; keep the room out of the median rather than distort it.
    if (!Number.isFinite(area) || area <= 0) {
      roomsSkippedNoArea++;
      continue;
    }
    let byType = areasByBuildingType.get(bldg);
    if (!byType) areasByBuildingType.set(bldg, (byType = new Map()));
    (byType.get(roomType) ?? byType.set(roomType, []).get(roomType)!).push(area);
  }

  const roomRows: (string | number)[][] = [];
  for (const [buildingId, byType] of areasByBuildingType) {
    for (const [roomType, areas] of byType) {
      const med = median(areas);
      roomRows.push([buildingId, roomType, areas.length, derivedCapacity(roomType, med), med]);
    }
  }
  roomRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));

  writeCsv(
    "room_inventory.csv",
    ["Building ID", "Room Type", "Room Count", "Typical Capacity", "Square Footage"],
    roomRows
  );

  // ---------- emit room_capacity_detail.csv ----------
  // room_inventory.csv above collapses every room of a type down to ONE row
  // using the MEDIAN sqft -- fine for display, but wrong for a feasibility
  // check: individual classrooms in the same building can range from a
  // 7-seat room to a 35-seat room (real example: Satellite Academy HS, 154 to
  // 704 sqft across 16 "classrooms"), and about 60% of buildings have that
  // kind of spread. This file keeps every room's real sqft (grouped only by
  // identical sqft, to stay compact) so a capacity check can sum
  // min(cap, capacity_i) per room instead of room_count * median_capacity.
  //
  // Emitted for EVERY mapped room type, not just general instructional space.
  // Two different consumers need different slices of it:
  //   - computeHsPhysicalCapacity (lib/queries.ts) counts only general
  //     instructional rooms, and filters this file down itself.
  //   - the room-splitting tool (lib/roomSplit.ts) needs specialty rooms --
  //     an oversized science lab or computer lab is exactly the kind of room
  //     worth dividing -- and needs each room's own area, since the median in
  //     room_inventory.csv hides which individual rooms are big enough.
  const detailRows: (string | number)[][] = [];
  for (const [buildingId, byType] of areasByBuildingType) {
    for (const [roomType, areas] of byType) {
      const bySqft = new Map<number, number>();
      for (const a of areas) bySqft.set(a, (bySqft.get(a) ?? 0) + 1);
      for (const [sqft, count] of bySqft) {
        detailRows.push([buildingId, roomType, sqft, count]);
      }
    }
  }
  detailRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  writeCsv("room_capacity_detail.csv", ["Building ID", "Room Type", "Sqft", "Room Count"], detailRows);

  // ---------- emit nearby_parcels.csv ----------
  // Real city-owned property (COLP) with no current use -- the honest version
  // of "land the city already controls near this school".
  //
  // Two limits of this source, both surfaced in the UI rather than papered
  // over: COLP publishes no lot area (so Lot Area Sqft stays blank and no
  // seat estimate is derived), and its `address` is frequently a bare street
  // name with no house number ("GREENE AVENUE") or absent entirely -- about
  // 6% have nothing usable. BBL (Borough-Block-Lot) is the fix: it is present
  // on 100% of rows and is the city's authoritative parcel identifier, so it
  // pins the exact lot on ZoLa or the Digital Tax Map even when the address
  // string is useless. Latitude/longitude are carried through for the same
  // reason.
  const parcelRows: (string | number)[][] = [];
  for (const p of cityProperty) {
    if (!/NO USE/i.test(p.excatdesc || "")) continue;
    if (!p.latitude || !p.longitude) continue;
    const label = (p.address || p.parcel_name || "").trim();
    // COLP writes BBL as a float in some rows (3085910175.0); the canonical
    // form is a 10-digit integer string.
    const bblRaw = String(p.bbl ?? "").trim();
    const bbl = bblRaw ? String(Math.trunc(Number(bblRaw))) : "";
    parcelRows.push([
      `COLP-${parcelRows.length + 1}`,
      label, // may be blank -- the UI decides how to present a missing address
      "", // district: COLP uses community districts, not school districts
      Number(p.latitude),
      Number(p.longitude),
      "", // lot area not published in COLP
      BOROUGH_BY_CODE[String(p.borough).trim()] ?? "",
      Number.isFinite(Number(bbl)) ? bbl : "",
      `City-owned — ${(p.agency || "unknown agency").trim()}`,
    ]);
  }
  writeCsv(
    "nearby_parcels.csv",
    [
      "Parcel ID",
      "Description",
      "District",
      "Latitude",
      "Longitude",
      "Lot Area Sqft",
      "Borough",
      "BBL",
      "Ownership",
    ],
    parcelRows
  );

  // ---------- emit space_deficit_schools.csv (empty) ----------
  // Published only inside the annual NYCPS Class Size Reduction Plan PDF.
  writeCsv("space_deficit_schools.csv", ["DBN", "Confirmed Space Deficit"], []);

  // ---------- emit capacity_projects.csv ----------
  // Runs last: it matches SCA projects against school_locations.csv, which is
  // only on disk once the block above has written it.
  await writeCapacityProjects();

  // ---------- report ----------
  const missingBuilding = emittedSchools.filter((s) => !s.buildingId).length;
  const withUtilization = emittedSchools.filter((s) => buildings.has(s.buildingId)).length;
  console.log("\nIngestion summary");
  console.log(`  schools emitted:            ${schoolRows.length}`);
  console.log(`  class size band records:    ${classSizeRows.length}`);
  console.log(`  buildings with capacity:    ${buildingRows.length}`);
  console.log(`  schools w/ utilization:     ${withUtilization} (${((withUtilization / schoolRows.length) * 100).toFixed(1)}%)`);
  console.log(`  schools missing building:   ${missingBuilding}`);
  console.log(`  HS Core rows used:          ${hsRows}`);
  console.log(`  special-ed rows excluded:   ${skippedSpecialEd}`);
  console.log(`  suspect records flagged:    ${suspectRecords} (avg > ${IMPLAUSIBLE_AVG_CLASS_SIZE}, source artifact)`);
  console.log(`  space-deficit list:         EMPTY (PDF-only source -- see README)`);
  const buildingsWithRooms = areasByBuildingType.size;
  const cafeteriaBuildings = [...areasByBuildingType.values()].filter((m) => m.has("Cafeteria")).length;
  const vacantRooms = [...areasByBuildingType.values()].reduce(
    (n, m) => n + (m.get("Vacant")?.length ?? 0),
    0
  );
  console.log(`  room space snapshot:        ${roomSnapshot.slice(0, 10)} (wavz-fkw8)`);
  console.log(`  buildings w/ measured rooms:${buildingsWithRooms} (${((buildingsWithRooms / neededBuildings.size) * 100).toFixed(1)}%)`);
  console.log(`  room_inventory rows:        ${roomRows.length}`);
  console.log(`  buildings w/ cafeteria:     ${cafeteriaBuildings}`);
  console.log(`  vacant rooms found:         ${vacantRooms}`);
  console.log(`  rooms dropped (no area):    ${roomsSkippedNoArea}`);
  console.log("\nNext: npm run load:data");
}

main().catch((err) => {
  console.error("\nFetch failed:", err.message);
  process.exit(1);
});
