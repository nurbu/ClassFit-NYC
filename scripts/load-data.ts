/**
 * Loads CSVs from data/raw/ into a normalized SQLite database at data/classfit.db.
 *
 * Expected input files + headers (see README.md "Bringing in real NYC Open Data"
 * for how to map the real Open Data exports onto these column names):
 *
 *   school_locations.csv:
 *     DBN, School Name, Borough, District, School Type, Latitude, Longitude, Building ID
 *   class_size.csv:
 *     DBN, Grade Band, Number Of Classes, Number Of Students, Average Class Size, Target Cap,
 *     Source Year (optional), Data Quality (optional: "ok" | "suspect")
 *   building_utilization.csv:
 *     Building ID, Capacity, Enrollment, Co-Located, Num Schools In Building
 *   space_deficit_schools.csv:
 *     DBN, Confirmed Space Deficit
 *   room_inventory.csv:
 *     Building ID, Room Type, Room Count, Typical Capacity, Square Footage
 *   room_capacity_detail.csv (optional -- powers the physical-capacity check):
 *     Building ID, Room Type, Sqft, Room Count
 *   nearby_parcels.csv (optional -- powers the real-estate candidate finder):
 *     Parcel ID, Description, District, Latitude, Longitude, Lot Area Sqft, Borough, BBL, Ownership
 *   capacity_projects.csv (optional -- powers the funded-construction panel):
 *     Project ID, Project Name, Project Type, DBN, Matched School Name, Seats,
 *     Anticipated Opening, Address, Borough, District, Latitude, Longitude, BBL
 *
 * Run with: npm run load:data
 */
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { parse } from "csv-parse/sync";
import { DatabaseSync } from "node:sqlite";

const RAW_DIR = join(process.cwd(), "data", "raw");
const DB_PATH = join(process.cwd(), "data", "classfit.db");

function readCsv(filename: string): Record<string, string>[] {
  const path = join(RAW_DIR, filename);
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${filename} in data/raw/. Run "npm run gen:mock" for demo data, or drop in the real NYC Open Data export.`
    );
  }
  const content = readFileSync(path, "utf-8");
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}

mkdirSync(join(process.cwd(), "data"), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

/** node:sqlite has no .transaction() helper (unlike better-sqlite3) -- wrap manually. */
function withTransaction(fn: () => void) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

db.exec(`
-- Child tables first. better-sqlite3 turns on PRAGMA foreign_keys by default,
-- and DROP TABLE performs an implicit DELETE of every row; dropping schools
-- while class_size_records/space_deficit_schools still reference it raises
-- "FOREIGN KEY constraint failed". (Only bites on a re-load, not a fresh DB.)
DROP TABLE IF EXISTS class_size_records;
DROP TABLE IF EXISTS space_deficit_schools;
DROP TABLE IF EXISTS room_inventory;
DROP TABLE IF EXISTS room_capacity_detail;
DROP TABLE IF EXISTS parcels;
DROP TABLE IF EXISTS capacity_projects;
DROP TABLE IF EXISTS building_utilization;
DROP TABLE IF EXISTS schools;

CREATE TABLE schools (
  dbn TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  borough TEXT NOT NULL,
  district INTEGER NOT NULL,
  school_type TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  building_id TEXT NOT NULL,
  -- Real, per-SCHOOL headcount (Blue Book "org_enroll"), distinct from
  -- building_utilization.enrollment which is shared across every school in a
  -- co-located building. Nullable: mock data and any org missing from the
  -- Blue Book leave this blank rather than guessing.
  enrollment INTEGER
);

CREATE TABLE class_size_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dbn TEXT NOT NULL REFERENCES schools(dbn),
  grade_band TEXT NOT NULL,
  num_classes INTEGER NOT NULL,
  num_students INTEGER NOT NULL,
  avg_class_size REAL NOT NULL,
  target_cap REAL NOT NULL,
  source_year TEXT,
  data_quality TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE building_utilization (
  building_id TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL,
  enrollment INTEGER NOT NULL,
  utilization_pct REAL NOT NULL,
  co_located INTEGER NOT NULL,
  num_schools_in_building INTEGER NOT NULL
);

CREATE TABLE space_deficit_schools (
  dbn TEXT PRIMARY KEY REFERENCES schools(dbn)
);

-- typical_capacity and sqft are NULLable: the real Blue Book publishes only a
-- COUNT of cluster/specialty rooms, with no per-room seats or square footage.
CREATE TABLE room_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  building_id TEXT NOT NULL,
  room_type TEXT NOT NULL,
  room_count INTEGER NOT NULL,
  typical_capacity INTEGER,
  sqft INTEGER
);

-- Per-room capacity detail, grouped only by identical sqft (not collapsed to
-- one median row like room_inventory above). Powers the HS physical-capacity
-- check in lib/queries.ts: real buildings mix room sizes within one type --
-- e.g. Satellite Academy HS has "classrooms" from 154 to 704 sqft in the same
-- building -- so a feasibility check needs to sum per-room capacity, not
-- room_count * median. Optional: absent for mock data and any building the
-- real fetch couldn't measure; the physical-capacity check simply doesn't
-- apply where this is empty.
CREATE TABLE room_capacity_detail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  building_id TEXT NOT NULL,
  room_type TEXT NOT NULL,
  sqft INTEGER NOT NULL,
  room_count INTEGER NOT NULL
);

CREATE TABLE parcels (
  parcel_id TEXT PRIMARY KEY,
  -- May be blank: COLP often carries only a bare street name, or nothing.
  -- bbl is the reliable identifier -- present on every row.
  description TEXT,
  district INTEGER,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  lot_sqft INTEGER,
  borough TEXT,
  bbl TEXT,
  ownership TEXT
);

-- SCA capacity projects in process (dtmw-avzj). Deliberately NOT foreign-keyed
-- to schools: dbn is null for every new-school build (they have no school yet)
-- and for any expansion the matcher couldn't attribute, and those rows still
-- belong in the table as area projects.
CREATE TABLE capacity_projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- 'expansion' (an addition/annex on a school that already exists) or
  -- 'new_school' (a new building, named for its address). The UI shows these
  -- very differently -- one adds seats to THIS school, the other to the area.
  project_type TEXT NOT NULL,
  -- The expanded school, when resolved. Null on new-school builds.
  dbn TEXT,
  matched_school_name TEXT,
  seats INTEGER NOT NULL,
  anticipated_opening TEXT,
  address TEXT,
  borough TEXT,
  -- Text, not INTEGER: the SCA file uses citywide pseudo-districts ("78M", "78Q")
  -- alongside the numeric geographic districts.
  district TEXT,
  -- Nullable: two rows publish no coordinates, so they can't take part in the
  -- distance-based "nearby projects" search.
  lat REAL,
  lng REAL,
  bbl TEXT
);

CREATE INDEX idx_class_size_dbn ON class_size_records(dbn);
CREATE INDEX idx_room_inventory_building ON room_inventory(building_id);
CREATE INDEX idx_capacity_projects_dbn ON capacity_projects(dbn);
`);

// ---- schools ----
const locations = readCsv("school_locations.csv");
const insertSchool = db.prepare(
  `INSERT INTO schools (dbn, name, borough, district, school_type, lat, lng, building_id, enrollment)
   VALUES (@dbn, @name, @borough, @district, @school_type, @lat, @lng, @building_id, @enrollment)`
);
withTransaction(() => {
  for (const r of locations) {
    const enrollment = Number(r["Enrollment"]);
    insertSchool.run({
      dbn: r["DBN"],
      name: r["School Name"],
      borough: r["Borough"],
      district: Number(r["District"]),
      school_type: r["School Type"],
      lat: Number(r["Latitude"]),
      lng: Number(r["Longitude"]),
      building_id: r["Building ID"],
      enrollment: Number.isFinite(enrollment) && enrollment > 0 ? enrollment : null,
    });
  }
});

// ---- class_size_records ----
const classSizes = readCsv("class_size.csv");
const insertClassSize = db.prepare(
  `INSERT INTO class_size_records (dbn, grade_band, num_classes, num_students, avg_class_size, target_cap, source_year, data_quality)
   VALUES (@dbn, @grade_band, @num_classes, @num_students, @avg_class_size, @target_cap, @source_year, @data_quality)`
);
withTransaction(() => {
  for (const r of classSizes) {
    insertClassSize.run({
      dbn: r["DBN"],
      grade_band: r["Grade Band"],
      num_classes: Number(r["Number Of Classes"]),
      num_students: Number(r["Number Of Students"]),
      avg_class_size: Number(r["Average Class Size"]),
      target_cap: Number(r["Target Cap"]),
      source_year: r["Source Year"] || null,
      data_quality: r["Data Quality"] || "ok",
    });
  }
});

// ---- building_utilization ----
const buildings = readCsv("building_utilization.csv");
const insertBuilding = db.prepare(
  `INSERT INTO building_utilization (building_id, capacity, enrollment, utilization_pct, co_located, num_schools_in_building)
   VALUES (@building_id, @capacity, @enrollment, @utilization_pct, @co_located, @num_schools_in_building)`
);
withTransaction(() => {
  for (const r of buildings) {
    const capacity = Number(r["Capacity"]);
    const enrollment = Number(r["Enrollment"]);
    insertBuilding.run({
      building_id: r["Building ID"],
      capacity,
      enrollment,
      utilization_pct: capacity > 0 ? Math.round((enrollment / capacity) * 1000) / 10 : 0,
      co_located: r["Co-Located"]?.toUpperCase() === "Y" ? 1 : 0,
      num_schools_in_building: Number(r["Num Schools In Building"]),
    });
  }
});

// ---- space_deficit_schools ----
const deficits = readCsv("space_deficit_schools.csv");
const insertDeficit = db.prepare(`INSERT OR IGNORE INTO space_deficit_schools (dbn) VALUES (?)`);
withTransaction(() => {
  for (const r of deficits) {
    if (r["Confirmed Space Deficit"]?.toUpperCase() === "Y") {
      insertDeficit.run(r["DBN"]);
    }
  }
});

// ---- room_inventory ----
const rooms = readCsv("room_inventory.csv");
const insertRoom = db.prepare(
  `INSERT INTO room_inventory (building_id, room_type, room_count, typical_capacity, sqft)
   VALUES (@building_id, @room_type, @room_count, @typical_capacity, @sqft)`
);
withTransaction(() => {
  for (const r of rooms) {
    // Blank capacity/sqft are stored as NULL rather than guessed: the
    // room-splitting tool needs real square footage, and inventing it would
    // make an unfounded feasibility claim.
    insertRoom.run({
      building_id: r["Building ID"],
      room_type: r["Room Type"],
      room_count: Number(r["Room Count"]),
      typical_capacity: r["Typical Capacity"] ? Number(r["Typical Capacity"]) : null,
      sqft: r["Square Footage"] ? Number(r["Square Footage"]) : null,
    });
  }
});

// ---- room_capacity_detail (optional) ----
let capacityDetailCount = 0;
if (existsSync(join(RAW_DIR, "room_capacity_detail.csv"))) {
  const capacityDetail = readCsv("room_capacity_detail.csv");
  const insertDetail = db.prepare(
    `INSERT INTO room_capacity_detail (building_id, room_type, sqft, room_count)
     VALUES (@building_id, @room_type, @sqft, @room_count)`
  );
  withTransaction(() => {
    for (const r of capacityDetail) {
      insertDetail.run({
        building_id: r["Building ID"],
        room_type: r["Room Type"],
        sqft: Number(r["Sqft"]),
        room_count: Number(r["Room Count"]),
      });
    }
  });
  capacityDetailCount = capacityDetail.length;
}

// ---- parcels (optional) ----
let parcelCount = 0;
if (existsSync(join(RAW_DIR, "nearby_parcels.csv"))) {
  const parcels = readCsv("nearby_parcels.csv");
  const insertParcel = db.prepare(
    `INSERT OR REPLACE INTO parcels (parcel_id, description, district, lat, lng, lot_sqft, borough, bbl, ownership)
     VALUES (@parcel_id, @description, @district, @lat, @lng, @lot_sqft, @borough, @bbl, @ownership)`
  );
  withTransaction(() => {
    for (const r of parcels) {
      insertParcel.run({
        parcel_id: r["Parcel ID"],
        description: r["Description"] || null,
        district: r["District"] ? Number(r["District"]) : null,
        lat: Number(r["Latitude"]),
        lng: Number(r["Longitude"]),
        lot_sqft: r["Lot Area Sqft"] ? Number(r["Lot Area Sqft"]) : null,
        borough: r["Borough"] || null,
        bbl: r["BBL"] || null,
        ownership: r["Ownership"] || null,
      });
    }
  });
  parcelCount = parcels.length;
}

// ---- capacity_projects (optional) ----
let projectCount = 0;
if (existsSync(join(RAW_DIR, "capacity_projects.csv"))) {
  const projects = readCsv("capacity_projects.csv");
  const insertProject = db.prepare(
    `INSERT OR REPLACE INTO capacity_projects
       (project_id, name, project_type, dbn, matched_school_name, seats, anticipated_opening,
        address, borough, district, lat, lng, bbl)
     VALUES (@project_id, @name, @project_type, @dbn, @matched_school_name, @seats,
             @anticipated_opening, @address, @borough, @district, @lat, @lng, @bbl)`
  );
  withTransaction(() => {
    for (const r of projects) {
      const lat = Number(r["Latitude"]);
      const lng = Number(r["Longitude"]);
      insertProject.run({
        project_id: r["Project ID"],
        name: r["Project Name"],
        project_type: r["Project Type"],
        dbn: r["DBN"] || null,
        matched_school_name: r["Matched School Name"] || null,
        seats: Number(r["Seats"]) || 0,
        anticipated_opening: r["Anticipated Opening"] || null,
        address: r["Address"] || null,
        borough: r["Borough"] || null,
        district: r["District"] || null,
        // Blank coordinates stay NULL rather than becoming 0/0, which would
        // place the project in the Gulf of Guinea and match every school.
        lat: r["Latitude"] && Number.isFinite(lat) ? lat : null,
        lng: r["Longitude"] && Number.isFinite(lng) ? lng : null,
        bbl: r["BBL"] || null,
      });
    }
  });
  projectCount = projects.length;
}

console.log(`Loaded ${locations.length} schools, ${classSizes.length} class size records, ${buildings.length} buildings, ${deficits.length} deficit rows, ${rooms.length} room rows, ${capacityDetailCount} room capacity detail rows, ${parcelCount} parcels, ${projectCount} capacity projects into ${DB_PATH}`);
db.close();
