/**
 * Fetches SCA "Capacity Projects in Process Site Locations" (dtmw-avzj) and
 * writes data/raw/capacity_projects.csv.
 *
 * Run standalone with:  npm run fetch:projects
 * Also called at the end of scripts/fetch-nyc-data.ts, which must run first --
 * this reads back the school_locations.csv that script emits, because matching
 * a project to a school needs the school list.
 *
 * WHAT THE DATASET IS
 * -------------------
 * The School Construction Authority's in-flight capacity program: ~18 projects
 * totalling ~8,200 seats, opening 2026-2028. Two kinds of row, distinguished
 * only by how the project is named:
 *
 *   EXPANSION   "P.S. 206 ADDITION", "JOHN BOWNE HS ANNEX"
 *               -- seats bolted onto a school that already exists, so they
 *                  relieve THAT school's overcrowding directly.
 *   NEW SCHOOL  "P.S. @ 46-10 70 STREET", "H.S. @ PARCEL C"
 *               -- a new building named for its address because it has no
 *                  school yet. Relieves the surrounding area, not one school.
 *
 * The distinction is the whole point of the feature, so it is derived here
 * (once, at ingest) rather than re-guessed in the UI.
 *
 * MATCHING EXPANSIONS TO A DBN
 * ----------------------------
 * The dataset carries no DBN -- only a project name, a district, and usually
 * coordinates. Matching is therefore name + proximity, and deliberately
 * conservative: an expansion attributed to the wrong school would show an
 * administrator hundreds of seats that are not coming to their building.
 *
 * A candidate must be in the same borough, within MAX_MATCH_MILES, and agree
 * on name. Ranking prefers, in order: an exact school-number match
 * ("P.S. 206" -> "P.S. 206 Joseph F Lamb"), a compatible school level (an
 * "HS ANNEX" should land on the high school, not the elementary school of the
 * same name -- real case: "JOHN BOWNE HS ANNEX" sits between "John Bowne High
 * School" and "P.S. 020 John Bowne"), then distance.
 *
 * Two rows publish no coordinates at all, and proximity is exactly what
 * disambiguates them -- "HARBOR HIGH SCHOOL ATHLETIC COMPLEX" scores identically
 * against "Harbor Heights" and "Urban Assembly New York Harbor School" on name
 * alone. Those are resolved by the explicit override table below rather than by
 * loosening the matcher for every other row. Any expansion that resolves by
 * neither route is reported loudly and written with an empty DBN: it still
 * appears as an area project, it just isn't attributed to a school.
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse } from "csv-parse/sync";

const RAW_DIR = join(process.cwd(), "data", "raw");
const SOCRATA = "https://data.cityofnewyork.us/resource";
const APP_TOKEN = process.env.NYC_APP_TOKEN;
const DATASET = "dtmw-avzj";

/** How far a project may sit from the school it is attributed to. */
const MAX_MATCH_MILES = 1;

/**
 * Expansions whose row publishes no latitude/longitude, so the name matcher has
 * no way to break a tie. Verified by hand against the SCA project name; keyed
 * on the exact project name so a renamed or removed project falls out of the
 * override rather than silently mis-attributing seats.
 */
const PROJECT_DBN_OVERRIDES: Record<string, string> = {
  "JOHN DEWEY ANNEX": "21K540",
  "HARBOR HIGH SCHOOL ATHLETIC COMPLEX": "02M551",
};

/** SCA's suffix vocabulary for "this adds onto an existing school". */
const EXPANSION_SUFFIX = /\s+(ADDITION|ANNEX|ATHLETIC COMPLEX|EXPANSION)$/;

/**
 * Generic words that carry no identifying signal -- every other school is a
 * "school" and half are an "academy". Dropped before token overlap so
 * "NEW YORK HARBOR SCHOOL" is compared on NEW/YORK/HARBOR.
 */
const NAME_STOPWORDS = new Set([
  "THE", "SCHOOL", "SCHOOLS", "HIGH", "JUNIOR", "INTERMEDIATE", "ELEMENTARY",
  "ACADEMY", "CAMPUS", "ANNEX", "ADDITION", "EXPANSION", "ATHLETIC", "COMPLEX",
  "AT", "OF", "AND", "FOR", "PS", "IS", "JHS", "MS", "HS", "EC",
]);

/** School-level prefixes -> the school_type values load-data.ts stores. */
const LEVEL_TYPES: [RegExp, string[]][] = [
  [/\b(?:P\.?\s?S\.?|ELEMENTARY)\b/, ["ES", "K8", "K12", "EC"]],
  [/\b(?:I\.?\s?S\.?|J\.?H\.?\s?S\.?|M\.?\s?S\.?|MIDDLE|INTERMEDIATE)\b/, ["MS", "K8", "K12"]],
  [/\b(?:H\.?\s?S\.?|HIGH SCHOOL)\b/, ["HS", "K12"]],
];

interface MatchSchool {
  dbn: string;
  name: string;
  borough: string;
  district: number;
  school_type: string;
  lat: number;
  lng: number;
}

type Row = Record<string, string>;

const BOROUGH_BY_NAME: Record<string, string> = {
  MANHATTAN: "Manhattan",
  BRONX: "Bronx",
  BROOKLYN: "Brooklyn",
  QUEENS: "Queens",
  "STATEN ISLAND": "Staten Island",
};

function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The school number in a name, normalized past zero-padding: the projects file
 * writes "P.S. 95" where the locations file writes "P.S. 095 Eastwood".
 * Returns null for named schools ("JOHN BOWNE HS"), which carry no number.
 */
function schoolNumber(name: string): number | null {
  const m = name
    .toUpperCase()
    .match(/\b(?:P\.?\s?S\.?|I\.?\s?S\.?|J\.?H\.?\s?S\.?|M\.?\s?S\.?|H\.?\s?S\.?)[\s/.]*?(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

/** Identifying words only -- see NAME_STOPWORDS. */
function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w))
  );
}

/** school_type values a project's name is consistent with, or null if unstated. */
function compatibleTypes(projectName: string): string[] | null {
  const upper = projectName.toUpperCase();
  // Checked high-school-first: "H.S." is the most specific claim in a name, and
  // "JOHN BOWNE HS ANNEX" must not fall through to the elementary bucket.
  for (const [re, types] of [...LEVEL_TYPES].reverse()) {
    if (re.test(upper)) return types;
  }
  return null;
}

interface MatchResult {
  school: MatchSchool;
  distance: number;
  numberMatch: boolean;
  levelMatch: boolean;
}

function matchExpansion(
  projectName: string,
  lat: number | null,
  lng: number | null,
  borough: string,
  schools: MatchSchool[]
): MatchResult | null {
  if (lat == null || lng == null) return null;

  const base = projectName.toUpperCase().replace(EXPANSION_SUFFIX, "").trim();
  const projNumber = schoolNumber(base);
  const projTokens = nameTokens(base);
  const types = compatibleTypes(projectName);

  const results: MatchResult[] = [];
  for (const s of schools) {
    if (borough && s.borough !== borough) continue;
    const distance = distanceMiles(lat, lng, s.lat, s.lng);
    if (distance > MAX_MATCH_MILES) continue;

    const numberMatch = projNumber != null && schoolNumber(s.name) === projNumber;
    if (!numberMatch) {
      if (projNumber != null) continue; // numbered project, wrong number
      // Named project: every identifying word must appear in the school name.
      const schoolTokens = nameTokens(s.name);
      if (projTokens.size === 0) continue;
      if (![...projTokens].every((t) => schoolTokens.has(t))) continue;
    }

    results.push({
      school: s,
      distance,
      numberMatch,
      levelMatch: types ? types.includes(s.school_type) : false,
    });
  }

  if (results.length === 0) return null;
  results.sort(
    (a, b) =>
      Number(b.numberMatch) - Number(a.numberMatch) ||
      Number(b.levelMatch) - Number(a.levelMatch) ||
      a.distance - b.distance
  );
  return results[0];
}

async function fetchProjects(): Promise<Row[]> {
  const res = await fetch(`${SOCRATA}/${DATASET}.json?$limit=50000`, {
    headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {},
  });
  if (!res.ok) {
    throw new Error(`Socrata ${DATASET} failed: ${res.status} ${res.statusText}\n${await res.text()}`);
  }
  return (await res.json()) as Row[];
}

function loadSchools(): MatchSchool[] {
  const path = join(RAW_DIR, "school_locations.csv");
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Run "npm run fetch:real" first -- expansions are matched against it.`);
  }
  const rows = parse(readFileSync(path, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Row[];
  return rows.map((r) => ({
    dbn: r["DBN"],
    name: r["School Name"],
    borough: r["Borough"],
    district: Number(r["District"]),
    school_type: r["School Type"],
    lat: Number(r["Latitude"]),
    lng: Number(r["Longitude"]),
  }));
}

function csvEscape(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeCapacityProjects(): Promise<void> {
  const schools = loadSchools();
  const projects = await fetchProjects();
  console.log(`  ${DATASET}: ${projects.length} rows`);

  const schoolByDbn = new Map(schools.map((s) => [s.dbn, s]));
  const rows: (string | number)[][] = [];
  let expansions = 0;
  let matched = 0;
  const unmatched: string[] = [];

  projects.forEach((p, i) => {
    const name = (p.school || "").trim();
    if (!name) return;
    const isExpansion = EXPANSION_SUFFIX.test(name.toUpperCase());
    const borough = BOROUGH_BY_NAME[(p.borough || "").trim().toUpperCase()] ?? "";
    const lat = p.latitude ? Number(p.latitude) : null;
    const lng = p.longitude ? Number(p.longitude) : null;

    let dbn = "";
    let matchedName = "";
    if (isExpansion) {
      expansions++;
      const override = PROJECT_DBN_OVERRIDES[name.toUpperCase()];
      if (override && schoolByDbn.has(override)) {
        dbn = override;
        matchedName = schoolByDbn.get(override)!.name;
      } else {
        const hit = matchExpansion(name, lat, lng, borough, schools);
        if (hit) {
          dbn = hit.school.dbn;
          matchedName = hit.school.name;
        }
      }
      if (dbn) matched++;
      else unmatched.push(name);
    }

    // BBL arrives as a number and is the city's canonical 10-digit parcel id.
    const bblRaw = String(p.bbl ?? "").trim();
    const bbl = bblRaw && Number.isFinite(Number(bblRaw)) ? String(Math.trunc(Number(bblRaw))) : "";

    rows.push([
      `SCA-${i + 1}`,
      name,
      isExpansion ? "expansion" : "new_school",
      dbn,
      matchedName,
      Number(p.number_of_seats) || 0,
      (p.anticipated_opening || "").trim(),
      (p.address || "").trim(),
      borough,
      (p.district || "").trim(),
      lat ?? "",
      lng ?? "",
      bbl,
    ]);
  });

  const header = [
    "Project ID", "Project Name", "Project Type", "DBN", "Matched School Name",
    "Seats", "Anticipated Opening", "Address", "Borough", "District",
    "Latitude", "Longitude", "BBL",
  ];
  writeFileSync(
    join(RAW_DIR, "capacity_projects.csv"),
    [header.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n") + "\n"
  );

  const seats = rows.reduce((n, r) => n + Number(r[5]), 0);
  console.log(`  wrote capacity_projects.csv (${rows.length} rows)`);
  console.log(`  capacity projects:          ${rows.length} (${seats.toLocaleString()} seats)`);
  console.log(`  school expansions:          ${expansions} (${matched} matched to a DBN)`);
  console.log(`  new-school builds:          ${rows.length - expansions}`);
  if (unmatched.length > 0) {
    // Loud on purpose: an unmatched expansion still shows as an area project,
    // but no school's page will claim those seats until it is resolved -- add
    // it to PROJECT_DBN_OVERRIDES above.
    console.warn(`  !! UNMATCHED EXPANSIONS (${unmatched.length}): ${unmatched.join("; ")}`);
  }
}

// Standalone entry point, so the projects file can be refreshed on its own.
if (process.argv[1]?.endsWith("fetch-capacity-projects.ts")) {
  writeCapacityProjects().catch((err) => {
    console.error("\nFetch failed:", err.message);
    process.exit(1);
  });
}
