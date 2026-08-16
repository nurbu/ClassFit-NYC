import { getDb } from "./db";
import { MIN_SQFT_PER_PUPIL, MIN_SQFT_PER_PUPIL_KINDERGARTEN } from "./roomSplit";
import type {
  School,
  ClassSizeRecord,
  BuildingUtilization,
  RoomInventoryRow,
  SchoolSummary,
  PhysicalCapacityCheck,
  CapacityDetailRow,
  Parcel,
  CapacityProject,
  NearbyCapacityProject,
} from "./types";

/**
 * Room types the HS physical-capacity check counts: general instructional
 * space plus rooms already standing empty. Specialty rooms are excluded on
 * purpose -- see computeHsPhysicalCapacity.
 */
const PHYSICAL_CHECK_TYPES = new Set(["Classroom", "Kindergarten", "Special Education", "Vacant"]);

/**
 * HS physical-capacity check: could this school's OWN classrooms hold
 * everyone under cap if course sections were spread across the rooms it
 * already has?
 *
 * Why this exists: NYC's HS class-size data reports course SECTIONS, not
 * rooms (see isCourseSectionBand in compliance.ts) -- a school can show a
 * severely-over-cap average purely because it schedules too few, too-big
 * sections, while its actual classrooms sit mostly empty. Real example:
 * Satellite Academy HS reports a 36.3 average (980 course-seats / 27
 * sections) but has 255 real students and 16 classrooms -- comfortably
 * enough room to fit everyone under cap. That's a scheduling problem, not a
 * space problem, and shouldn't paint the map the same red as a school with
 * nowhere to put students.
 *
 * If this check applies and finds enough room, the school is reclassified
 * as compliant (see listSchoolSummaries/getSchoolDetail). If it finds a real
 * shortfall, that shortfall -- not the raw average -- drives severity.
 *
 * Deliberately narrow eligibility:
 *   - Single-band 9-12 schools only. K-8 bands already report real
 *     per-classroom headcount (no course-section artifact to correct), and
 *     multi-band schools (e.g. K-8) share one room pool across bands with
 *     different caps that we have no reliable way to split -- see README.
 *   - Requires real per-school enrollment (Blue Book org_enroll) and real
 *     per-room capacity data (room_capacity_detail); returns null without
 *     either rather than guessing.
 *
 * Uses PER-ROOM capacity, not room_count * a single average: real buildings
 * mix room sizes within one type (Satellite Academy's 16 "classrooms" run
 * 154 to 704 sqft -- derived capacity 7 to 35 seats), and about 60% of
 * buildings show that kind of spread. Each room's own capacity is capped at
 * the mandate cap before summing, per the room-splitting rule already used
 * elsewhere (20 sqft/pupil general, 35 for kindergarten).
 */
export function computeHsPhysicalCapacity(
  bands: ClassSizeRecord[],
  enrollment: number | null,
  detailRows: CapacityDetailRow[]
): PhysicalCapacityCheck | null {
  if (bands.length !== 1 || bands[0].grade_band !== "9-12") return null;
  if (enrollment == null) return null;

  // room_capacity_detail carries every room type (the splitting tool needs
  // labs, art, and music). This check counts only rooms a school can put a
  // core section in every period: converting a science lab or library to
  // full-time homeroom use is a real trade-off with a real cost, and counting
  // it here would silently mark a school compliant on the strength of space
  // it would have to take away from another program.
  const counted = detailRows.filter((r) => PHYSICAL_CHECK_TYPES.has(r.room_type));
  if (counted.length === 0) return null;

  const targetCap = bands[0].target_cap;
  let totalCapacity = 0;
  let roomsCounted = 0;
  for (const r of counted) {
    const sqftPerPupil = r.room_type === "Kindergarten" ? MIN_SQFT_PER_PUPIL_KINDERGARTEN : MIN_SQFT_PER_PUPIL;
    const perRoomCapacity = Math.floor(r.sqft / sqftPerPupil);
    totalCapacity += Math.min(targetCap, perRoomCapacity) * r.room_count;
    roomsCounted += r.room_count;
  }

  const excessStudents = Math.max(0, enrollment - totalCapacity);
  const classroomsNeeded = excessStudents > 0 ? Math.ceil(excessStudents / targetCap) : 0;

  return {
    targetCap,
    enrollment,
    totalCapacity,
    excessStudents,
    classroomsNeeded,
    feasible: excessStudents === 0,
    roomsCounted,
  };
}

/** All schools with a computed compliance-gap summary, for the map + search list. */
export function listSchoolSummaries(): SchoolSummary[] {
  const db = getDb();
  const schools = db.prepare(`SELECT * FROM schools ORDER BY name`).all() as unknown as School[];
  const records = db.prepare(`SELECT * FROM class_size_records`).all() as unknown as ClassSizeRecord[];
  const deficitSet = new Set(
    (db.prepare(`SELECT dbn FROM space_deficit_schools`).all() as unknown as { dbn: string }[]).map((r) => r.dbn)
  );
  const capacityDetail = db
    .prepare(`SELECT building_id, room_type, sqft, room_count FROM room_capacity_detail`)
    .all() as unknown as (CapacityDetailRow & { building_id: string })[];

  const recordsByDbn = new Map<string, ClassSizeRecord[]>();
  for (const r of records) {
    if (!recordsByDbn.has(r.dbn)) recordsByDbn.set(r.dbn, []);
    recordsByDbn.get(r.dbn)!.push(r);
  }

  const capacityDetailByBuilding = new Map<string, CapacityDetailRow[]>();
  for (const r of capacityDetail) {
    if (!capacityDetailByBuilding.has(r.building_id)) capacityDetailByBuilding.set(r.building_id, []);
    capacityDetailByBuilding.get(r.building_id)!.push(r);
  }

  return schools.map((s) => {
    const allBands = recordsByDbn.get(s.dbn) ?? [];
    // Records flagged "suspect" are source-data artifacts (see fetch script);
    // letting them drive map color would paint a false worst-offender.
    const bands = allBands.filter((b) => b.data_quality !== "suspect");
    // worst band = the one with the highest (avg_class_size - target_cap)
    let maxGap = 0;
    let worstBand: ClassSizeRecord["grade_band"] | null = null;
    if (bands.length > 0) {
      const worst = bands.reduce((a, b) => (b.avg_class_size - b.target_cap > a.avg_class_size - a.target_cap ? b : a));
      worstBand = worst.grade_band;
      maxGap = Math.max(0, worst.avg_class_size - worst.target_cap);
    }

    const physicalCapacityCheck = computeHsPhysicalCapacity(
      bands,
      s.enrollment,
      capacityDetailByBuilding.get(s.building_id) ?? []
    );
    // Override the avg-class-size gap with the physical-capacity result where
    // it applies: classroomsNeeded (0 when feasible) replaces maxGap so the
    // map colors/sorts this school by real room shortfall, not by how few
    // sections it happens to be scheduling today.
    if (physicalCapacityCheck) {
      maxGap = physicalCapacityCheck.classroomsNeeded;
    }

    return {
      ...s,
      maxGap,
      worstBand,
      isDeficitFlagged: deficitSet.has(s.dbn),
      physicalCapacityCheck,
    };
  });
}

/** Distinct school years present in the loaded class size data, oldest first. */
export function listSourceYears(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT source_year FROM class_size_records
       WHERE source_year IS NOT NULL AND source_year != '' ORDER BY source_year`
    )
    .all() as unknown as { source_year: string }[];
  return rows.map((r) => r.source_year);
}

export interface SchoolDetail {
  school: School;
  bands: ClassSizeRecord[];
  building: BuildingUtilization | null;
  rooms: RoomInventoryRow[];
  /**
   * Per-room measured area for every room type in the building, grouped by
   * identical sqft. Powers the room-splitting tool, which needs to know which
   * INDIVIDUAL rooms are large enough to divide -- the median in `rooms`
   * can't answer that.
   */
  capacityDetail: CapacityDetailRow[];
  isDeficitFlagged: boolean;
  /** Non-null only for schools where the physical-capacity check applies (see computeHsPhysicalCapacity). */
  physicalCapacityCheck: PhysicalCapacityCheck | null;
}

export function getSchoolDetail(dbn: string): SchoolDetail | null {
  const db = getDb();
  const school = db.prepare(`SELECT * FROM schools WHERE dbn = ?`).get(dbn) as unknown as School | undefined;
  if (!school) return null;

  const bands = db
    .prepare(`SELECT * FROM class_size_records WHERE dbn = ? ORDER BY grade_band`)
    .all(dbn) as unknown as ClassSizeRecord[];

  const building = db
    .prepare(`SELECT * FROM building_utilization WHERE building_id = ?`)
    .get(school.building_id) as unknown as BuildingUtilization | undefined;

  const rooms = db
    .prepare(`SELECT * FROM room_inventory WHERE building_id = ? ORDER BY room_type`)
    .all(school.building_id) as unknown as RoomInventoryRow[];

  const capacityDetail = db
    .prepare(`SELECT room_type, sqft, room_count FROM room_capacity_detail WHERE building_id = ?`)
    .all(school.building_id) as unknown as CapacityDetailRow[];

  // Suspect records (source-data artifacts) are excluded here too, same as
  // listSchoolSummaries -- they shouldn't drive the physical-capacity check
  // either, though bands.length === 1 mostly protects against this already.
  const cleanBands = bands.filter((b) => b.data_quality !== "suspect");
  const physicalCapacityCheck = computeHsPhysicalCapacity(cleanBands, school.enrollment, capacityDetail);

  const deficitRow = db
    .prepare(`SELECT dbn FROM space_deficit_schools WHERE dbn = ?`)
    .get(dbn);

  // node:sqlite rows carry a null prototype, which React's Server->Client
  // Component serialization rejects ("Classes or null prototypes are not
  // supported"). Spreading each row into a fresh object literal fixes that
  // (object literals always get the normal Object.prototype).
  return {
    school: { ...school },
    bands: bands.map((b) => ({ ...b })),
    building: building ? { ...building } : null,
    rooms: rooms.map((r) => ({ ...r })),
    capacityDetail: capacityDetail.map((c) => ({ ...c })),
    isDeficitFlagged: !!deficitRow,
    physicalCapacityCheck,
  };
}

export interface NearbyCapacityOption {
  school: School;
  distanceMiles: number;
  estimatedCommuteMinutes: number;
  utilizationPct: number;
  sameDistrict: boolean;
  /**
   * How many more students this school could take: the smaller of its
   * class-size headroom and its building's physical headroom.
   */
  spareStudents: number;
  /** Headroom in the sections it runs, before the building bound is applied. */
  sectionHeadroom: number;
  /** Blue Book capacity - enrollment for the building. */
  buildingHeadroom: number;
  /** True when the building, not class size, is the binding constraint. */
  buildingIsBinding: boolean;
  /** True when a 9-12 band was converted from course seats (see computeSpareSeats). */
  usedCourseSeatConversion: boolean;
}

/**
 * Spare capacity at a potential receiving school: how many more students can
 * it take before a class goes over cap?
 *
 * Per band that is `cap * classes - students` -- the headroom left in the
 * sections it already runs. Each band uses its OWN cap (20 K-3, 23 4-8,
 * 25 9-12); a flat 25 would claim elementary seats the mandate forbids.
 *
 * The 9-12 correction: HS bands report course SECTIONS and course SEATS, not
 * classes and students (see isCourseSectionBand). So `cap * sections - seats`
 * is spare COURSE seats, and a student consumes several of them at once --
 * reporting it directly would overstate how many children actually fit by
 * roughly a factor of five. The divisor isn't assumed: each school publishes
 * both its course seats and its real Blue Book headcount, so
 * `courseSeats / enrollment` gives that school's own courses-per-student.
 * Where enrollment is missing there is nothing to derive from, and the band
 * is skipped rather than guessed at.
 */
export function computeSpareSeats(
  bands: ClassSizeRecord[],
  enrollment: number | null
): { spareStudents: number; usedCourseSeatConversion: boolean } {
  let spare = 0;
  let usedCourseSeatConversion = false;

  for (const b of bands) {
    if (b.data_quality === "suspect") continue;
    const headroom = b.target_cap * b.num_classes - b.num_students;
    if (headroom <= 0) continue;

    if (b.grade_band === "9-12") {
      // Course seats -> students, using this school's own ratio.
      if (enrollment == null || enrollment <= 0 || b.num_students <= 0) continue;
      const coursesPerStudent = b.num_students / enrollment;
      if (coursesPerStudent <= 0) continue;
      spare += headroom / coursesPerStudent;
      usedCourseSeatConversion = true;
    } else {
      spare += headroom;
    }
  }

  return { spareStudents: Math.floor(Math.max(0, spare)), usedCourseSeatConversion };
}

/**
 * Feature 5: nearby-school capacity finder.
 *
 * Finds schools of the SAME school_type (so a redistribution destination
 * actually serves the right grades) within `radiusMiles` that are under
 * capacity per Blue Book utilization data. This is explicitly a
 * "technically feasible" list, not a recommendation -- see the UI copy.
 */
export function findNearbyCapacityOptions(
  dbn: string,
  radiusMiles = 3,
  utilizationThresholdPct = 90
): NearbyCapacityOption[] {
  const db = getDb();
  const origin = db.prepare(`SELECT * FROM schools WHERE dbn = ?`).get(dbn) as unknown as School | undefined;
  if (!origin) return [];

  const candidates = db
    .prepare(`SELECT * FROM schools WHERE dbn != ? AND school_type = ?`)
    .all(dbn, origin.school_type) as unknown as School[];

  const bandStmt = db.prepare(`SELECT * FROM class_size_records WHERE dbn = ?`);
  const buildingStmt = db.prepare(`SELECT * FROM building_utilization WHERE building_id = ?`);

  const options: NearbyCapacityOption[] = [];
  for (const c of candidates) {
    const dist = distanceMiles(origin.lat, origin.lng, c.lat, c.lng);
    if (dist > radiusMiles) continue;

    const building = buildingStmt.get(c.building_id) as unknown as BuildingUtilization | undefined;
    if (!building || building.utilization_pct >= utilizationThresholdPct) continue;

    const { spareStudents: sectionHeadroom, usedCourseSeatConversion } = computeSpareSeats(
      bandStmt.all(c.dbn) as unknown as ClassSizeRecord[],
      c.enrollment
    );

    // Class-size headroom says how many students the SECTIONS could absorb;
    // it says nothing about whether the building holds them. Bound it by Blue
    // Book capacity so a school reporting unusually few course sections can't
    // appear to swallow more children than it has room for.
    const buildingHeadroom = Math.max(0, building.capacity - building.enrollment);
    const spareStudents = Math.min(sectionHeadroom, buildingHeadroom);

    // No headroom means it isn't a redistribution destination, however close
    // or under-utilized it otherwise looks.
    if (spareStudents <= 0) continue;

    options.push({
      school: { ...c },
      distanceMiles: Math.round(dist * 10) / 10,
      // Rough urban-commute estimate: ~4 min/mile (surface transit/walk mix) + 5 min baseline.
      estimatedCommuteMinutes: Math.round(dist * 4 + 5),
      utilizationPct: building.utilization_pct,
      sameDistrict: c.district === origin.district,
      spareStudents,
      sectionHeadroom,
      buildingHeadroom,
      buildingIsBinding: buildingHeadroom < sectionHeadroom,
      usedCourseSeatConversion,
    });
  }

  // Most capacity first -- the point of the list is where students could go.
  return options.sort((a, b) => b.spareStudents - a.spareStudents || a.distanceMiles - b.distanceMiles);
}

export interface SiteCandidate extends Parcel {
  distanceMiles: number;
  /**
   * Very rough seat estimate: assumes a school building covers ~60% of the
   * lot across ~3 floors, at the DOE planning standard of ~120 gross sqft
   * per seat (instructional space plus its share of halls/cafeteria/admin).
   * Null when the source publishes no lot area (e.g. COLP) -- no estimate is
   * invented in that case.
   */
  estimatedSeats: number | null;
}

/**
 * Feature: candidate sites for a new/second school building.
 *
 * Returns nearby parcels as ILLUSTRATIVE starting points for a site search
 * -- explicitly NOT a siting recommendation. Real NYC school siting runs
 * through the SCA's capital plan, Real Estate Services acquisition, a
 * 45-day public comment period, and Community Board / CEC hearings.
 */
export function findSiteCandidates(dbn: string, radiusMiles = 2): SiteCandidate[] {
  const db = getDb();
  const origin = db.prepare(`SELECT * FROM schools WHERE dbn = ?`).get(dbn) as unknown as School | undefined;
  if (!origin) return [];

  const parcels = db.prepare(`SELECT * FROM parcels`).all() as unknown as Parcel[];

  return parcels
    .map((p) => ({
      ...p,
      distanceMiles: Math.round(distanceMiles(origin.lat, origin.lng, p.lat, p.lng) * 10) / 10,
      estimatedSeats: p.lot_sqft ? Math.round((p.lot_sqft * 0.6 * 3) / 120) : null,
    }))
    .filter((p) => p.distanceMiles <= radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}

export interface SchoolCapacityProjects {
  /**
   * Funded expansions of THIS school -- an addition or annex whose seats land
   * in this building. Usually 0 or 1; the Harbor School has two.
   */
  direct: CapacityProject[];
  /** Total seats across `direct`. */
  directSeats: number;
  /**
   * Other in-flight projects within `radiusMiles` -- new school buildings, and
   * expansions of neighbouring schools. These add seats to the area and can
   * relieve enrollment pressure indirectly, but none of them are seats for this
   * school, and the UI says so explicitly.
   */
  nearby: NearbyCapacityProject[];
}

/**
 * Feature: funded construction already in the SCA pipeline.
 *
 * The counterpart to findSiteCandidates: those are speculative city-owned lots
 * that someone would still have to fund, site, and approve, whereas these are
 * projects with a seat count and an opening year already attached.
 *
 * Split deliberately into `direct` and `nearby`. Conflating them would be the
 * one genuinely misleading thing this panel could do -- "487 new seats" reads
 * very differently to a principal depending on whether the seats are landing in
 * their building or in a new school half a mile away.
 *
 * Rows without coordinates (two, in the current data) can still appear in
 * `direct`, since that link comes from the project name, but they cannot take
 * part in the distance search.
 */
export function findCapacityProjects(dbn: string, radiusMiles = 3): SchoolCapacityProjects {
  const db = getDb();
  const origin = db.prepare(`SELECT * FROM schools WHERE dbn = ?`).get(dbn) as unknown as School | undefined;
  if (!origin) return { direct: [], directSeats: 0, nearby: [] };

  const all = (
    db.prepare(`SELECT * FROM capacity_projects`).all() as unknown as CapacityProject[]
  ).map((p) => ({ ...p })); // node:sqlite rows are null-prototype -- see getSchoolDetail

  const direct = all
    .filter((p) => p.dbn === origin.dbn)
    .sort((a, b) => (a.anticipated_opening ?? "").localeCompare(b.anticipated_opening ?? ""));
  const directIds = new Set(direct.map((p) => p.project_id));

  const nearby = all
    .filter((p) => !directIds.has(p.project_id) && p.lat != null && p.lng != null)
    .map((p) => ({
      ...p,
      distanceMiles: Math.round(distanceMiles(origin.lat, origin.lng, p.lat!, p.lng!) * 10) / 10,
    }))
    .filter((p) => p.distanceMiles <= radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);

  return {
    direct,
    directSeats: direct.reduce((sum, p) => sum + p.seats, 0),
    nearby,
  };
}

/** Haversine distance in miles between two lat/lng points. */
export function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
