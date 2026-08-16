import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getSchoolDetail,
  findNearbyCapacityOptions,
  findSiteCandidates,
  findCapacityProjects,
} from "@/lib/queries";
import {
  getComplianceStatus,
  plainLanguageStatus,
  isCourseSectionBand,
} from "@/lib/compliance";
import { generateFastTrackSuggestions } from "@/lib/solver";
import SpaceToolkit from "@/components/SpaceToolkit";
import LongerTermSolutions from "@/components/LongerTermSolutions";

export default async function SchoolDetailPage({
  params,
}: {
  params: Promise<{ dbn: string }>;
}) {
  const { dbn } = await params;
  const detail = getSchoolDetail(dbn.toUpperCase());
  if (!detail) notFound();

  const { school, bands, building, rooms, capacityDetail, isDeficitFlagged, physicalCapacityCheck } =
    detail;
  const worstBand =
    bands.length > 0
      ? bands.reduce((a, b) => (b.avg_class_size - b.target_cap > a.avg_class_size - a.target_cap ? b : a))
      : null;
  // Where the physical-capacity check applies (single-band HS, real
  // enrollment + room data -- see computeHsPhysicalCapacity), it overrides
  // the badge: severity is driven by real room shortfall, not by how few
  // course sections the school happens to be scheduling today.
  const overallStatus = physicalCapacityCheck
    ? getComplianceStatus(physicalCapacityCheck.classroomsNeeded)
    : getComplianceStatus(worstBand ? worstBand.avg_class_size - worstBand.target_cap : 0);
  // Standard instructional rooms: general classrooms + kindergarten + SPED --
  // i.e. rooms a student is assigned to for core instruction, as opposed to
  // specialty spaces (gym, library, cafeteria, auditorium, labs).
  const STANDARD_ROOM_TYPES = new Set(["Classroom", "Homeroom", "Kindergarten", "Special Education"]);
  const standardRoomCount = rooms
    .filter((r) => STANDARD_ROOM_TYPES.has(r.room_type))
    .reduce((sum, r) => sum + r.room_count, 0);

  const cafeteriaRoom = rooms.find((r) => r.room_type === "Cafeteria");

  // Longer-term levers, computed server-side (all need database access).
  const repurposeSuggestions = generateFastTrackSuggestions(bands, rooms);
  const nearbyOptions = findNearbyCapacityOptions(school.dbn).slice(0, 8);
  const siteCandidates = findSiteCandidates(school.dbn).slice(0, 3);
  const capacityProjects = findCapacityProjects(school.dbn);
  // Students the BUILDING is over its Blue Book target today -- the only
  // like-for-like comparison against an SCA seat count, which is also a
  // building-capacity figure. Null (rather than 0) when there's no Blue Book
  // row, so the panel stays quiet instead of implying the gap is zero.
  const buildingShortfall = building ? Math.max(0, building.enrollment - building.capacity) : null;

  return (
    <div className="mx-auto max-w-4xl w-full px-6 py-6 space-y-6">
      <div>
        <Link href="/" className="text-sm text-violet-300 hover:underline">
          ← Back to map &amp; search
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{school.name}</h1>
          <p className="text-sm text-white/50 mt-1">
            {school.dbn} &middot; {school.school_type} &middot; District {school.district} &middot;{" "}
            {school.borough}
          </p>
        </div>
        <span
          className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-full"
          style={{ backgroundColor: `${overallStatus.color}26`, color: overallStatus.color }}
        >
          <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: overallStatus.color }} />
          {overallStatus.label}
        </span>
      </div>

      {isDeficitFlagged && (
        <div className="rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <strong>NYCPS confirmed space deficit:</strong> this school appears on NYC Public
          Schools&apos; own list of buildings with confirmed classroom space deficits.
        </div>
      )}

      {physicalCapacityCheck && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            physicalCapacityCheck.feasible
              ? "border-sky-500/25 bg-sky-500/10 text-sky-200"
              : "border-red-500/25 bg-red-500/10 text-red-300"
          }`}
        >
          {physicalCapacityCheck.feasible ? (
            <>
              <strong>This is a scheduling problem, not a space problem.</strong> High school class
              size is reported per course section, and the average above ({worstBand?.avg_class_size.toFixed(1)}{" "}
              students/section) reflects too few, too-large sections — not a lack of rooms. This
              building has {physicalCapacityCheck.roomsCounted} classrooms with a combined capacity
              of ~{physicalCapacityCheck.totalCapacity.toLocaleString()} students at the mandate cap of{" "}
              {physicalCapacityCheck.targetCap}, comfortably above the {physicalCapacityCheck.enrollment.toLocaleString()}{" "}
              students actually enrolled. Scheduling more, smaller sections across the rooms already
              available would bring every section under cap without any construction.
            </>
          ) : (
            <>
              <strong>This is a real space shortfall, not just a scheduling issue.</strong> Even
              spreading all {physicalCapacityCheck.enrollment.toLocaleString()} enrolled students
              across all {physicalCapacityCheck.roomsCounted} classrooms at full capacity, this
              building can only seat ~{physicalCapacityCheck.totalCapacity.toLocaleString()} students
              under the mandate cap of {physicalCapacityCheck.targetCap} — short by{" "}
              {physicalCapacityCheck.excessStudents.toLocaleString()} students, or roughly{" "}
              {physicalCapacityCheck.classroomsNeeded}{" "}
              {physicalCapacityCheck.classroomsNeeded === 1 ? "more classroom" : "more classrooms"}.
            </>
          )}
          <p className="mt-1.5 text-xs opacity-80">
            Based on real Blue Book enrollment and per-room measured floor area (20 sqft/pupil), not
            the course-section average shown below. See the room math in the space toolkit.
          </p>
        </div>
      )}

      {/* Class size vs. cap by grade band */}
      <section className="panel p-5">
        <h2 className="text-base font-semibold text-white mb-3">
          Class size vs. mandate cap by grade band
        </h2>
        <div className="space-y-4">
          {bands.map((b) => {
            const status = getComplianceStatus(b.avg_class_size - b.target_cap);
            return (
              <div key={b.grade_band} className="border-b border-white/10 last:border-0 pb-4 last:pb-0">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-medium text-white/90">
                    Grades {b.grade_band}
                    {b.source_year && (
                      <span className="ml-2 text-xs font-normal text-white/35">
                        {b.source_year} data
                      </span>
                    )}
                  </span>
                  <span className="text-sm text-white/50">
                    {b.num_classes.toLocaleString()}{" "}
                    {isCourseSectionBand(b.grade_band) ? "core sections" : "classes"} &middot;{" "}
                    {b.num_students.toLocaleString()}{" "}
                    {isCourseSectionBand(b.grade_band) ? "student course seats" : "students"}
                  </span>
                </div>
                {isCourseSectionBand(b.grade_band) && (
                  <p className="text-xs text-white/50 mb-1.5">
                    High school figures count core <em>course sections</em>, so one student
                    taking five core courses appears five times. The average is still
                    seats ÷ sections; the totals are not headcount.
                  </p>
                )}
                {b.data_quality === "suspect" && (
                  <div className="mb-1.5 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/25 rounded px-2 py-1">
                    ⚠ The source dataset reports an implausible average here (students appear
                    attributed to too few sections). Treat this figure as unreliable.
                  </div>
                )}
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="flex-1 h-2.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (b.avg_class_size / (b.target_cap * 1.4)) * 100)}%`,
                        backgroundColor: status.color,
                      }}
                    />
                  </div>
                  <span className="text-sm font-semibold text-white tabular-nums w-24 text-right">
                    {b.avg_class_size.toFixed(1)} / {b.target_cap}
                  </span>
                </div>
                <p className="text-sm text-white/65">{plainLanguageStatus(b.avg_class_size, b.target_cap)}</p>
              </div>
            );
          })}
          {bands.length === 0 && <p className="text-sm text-white/50">No class size data on file.</p>}
        </div>
      </section>

      {/* Building utilization */}
      <section className="panel p-5">
        <h2 className="text-base font-semibold text-white mb-3">Building utilization</h2>
        {building ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-white/50">Utilization</div>
              <div className="text-lg font-semibold text-white">{building.utilization_pct}%</div>
            </div>
            <div>
              <div className="text-white/50">
                Building enrollment
                {/* co_located comes out of SQLite as 0/1: `0 && <span>` would
                    render the literal "0", so coerce to a real boolean. */}
                {!!building.co_located && <span className="text-white/35"> (shared)</span>}
              </div>
              <div className="text-lg font-semibold text-white">{building.enrollment}</div>
            </div>
            <div>
              <div className="text-white/50">Target capacity</div>
              <div className="text-lg font-semibold text-white">{building.capacity}</div>
            </div>
            <div>
              <div className="text-white/50">Co-located</div>
              <div className="text-lg font-semibold text-white">
                {building.co_located ? `Yes (${building.num_schools_in_building} schools)` : "No"}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-white/50 mb-2">No Blue Book utilization data on file for this building.</p>
        )}

        {/* School-specific stats, as opposed to the building-level figures above. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm mt-4 pt-4 border-t border-white/10">
          <div>
            <div className="text-white/50">This school&apos;s enrollment</div>
            <div className="text-lg font-semibold text-white">
              {school.enrollment != null ? school.enrollment.toLocaleString() : "—"}
            </div>
            {school.enrollment == null && (
              <div className="text-xs text-white/35">not in the Blue Book</div>
            )}
          </div>
          <div>
            <div className="text-white/50">Standard classrooms</div>
            <div className="text-lg font-semibold text-white">
              {standardRoomCount > 0 ? standardRoomCount.toLocaleString() : "—"}
            </div>
            {standardRoomCount === 0 && <div className="text-xs text-white/35">no room data</div>}
          </div>
          <div>
            <div className="text-white/50">Cafeteria size</div>
            <div className="text-lg font-semibold text-white">
              {cafeteriaRoom?.sqft ? `${cafeteriaRoom.sqft.toLocaleString()} sqft` : "—"}
            </div>
            {!cafeteriaRoom?.sqft && <div className="text-xs text-white/35">no cafeteria on record</div>}
          </div>
        </div>
        <p className="text-xs text-white/35 mt-2">
          Room and cafeteria figures are measured floor area from DOE building space records, not
          headcount — see the space toolkit below for what they mean for capacity.
        </p>
      </section>

      {/* Space toolkit: room splitting, extended day, teacher need */}
      <section className="panel p-5">
        <h2 className="text-base font-semibold text-white mb-1">Space toolkit</h2>
        <p className="text-sm text-white/50 mb-4">
          Where the capacity could come from in the building you already have — and what staffing it
          would take.
        </p>
        <SpaceToolkit
          bands={bands}
          capacityDetail={capacityDetail}
          cafeteriaSqft={cafeteriaRoom?.sqft ?? null}
          enrollment={school.enrollment}
          repurposeSuggestions={repurposeSuggestions}
        />
      </section>

      <LongerTermSolutions
        nearbyOptions={nearbyOptions}
        siteCandidates={siteCandidates}
        capacityProjects={capacityProjects}
        buildingShortfall={buildingShortfall}
      />

    </div>
  );
}
