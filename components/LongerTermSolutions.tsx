import Link from "next/link";
import type { NearbyCapacityOption, SiteCandidate, SchoolCapacityProjects } from "@/lib/queries";
import type { CapacityProject } from "@/lib/types";

/** Google Maps link for a project, by coordinates when known, else by address. */
function mapsHref(p: CapacityProject): string | null {
  if (p.lat != null && p.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  }
  if (p.address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${p.address}, ${p.borough ?? "New York"}, NY`
    )}`;
  }
  return null;
}

/**
 * The two levers that don't live inside one building: sending students to a
 * nearby school that has room (medium), and building new seats (slow).
 *
 * Rendered under the Space Toolkit on the school page rather than on a page of
 * their own -- they're the continuation of the same question, and splitting
 * them off meant nobody saw them.
 */
export default function LongerTermSolutions({
  nearbyOptions,
  siteCandidates,
  capacityProjects,
  buildingShortfall,
}: {
  nearbyOptions: NearbyCapacityOption[];
  siteCandidates: SiteCandidate[];
  capacityProjects: SchoolCapacityProjects;
  /**
   * Students this building is over its Blue Book target capacity today, or
   * null when there's no Blue Book row to compare against. Used only to say
   * whether a funded expansion actually closes the gap.
   */
  buildingShortfall: number | null;
}) {
  const totalSpare = nearbyOptions.reduce((sum, o) => sum + o.spareStudents, 0);
  const { direct, directSeats, nearby } = capacityProjects;

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------- MEDIUM -- */}
      <section className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h2 className="text-base font-semibold text-white">
            Nearby schools with room
          </h2>
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-200">
            Weeks–1 semester
          </span>
        </div>
        <p className="text-sm text-white/50 mb-4">
          Same school type, within 3 miles, under 90% building utilization — and with real headroom
          left in the classes they already run.
        </p>

        {nearbyOptions.length === 0 ? (
          <p className="text-sm text-white/50">
            No schools of the same type within 3 miles have room to take students without pushing
            their own classes over cap.
          </p>
        ) : (
          <>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 mb-3">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-2xl font-bold text-white">
                  {totalSpare.toLocaleString()}
                </span>
                <span className="text-sm text-white/80">
                  students could be absorbed across {nearbyOptions.length}{" "}
                  {nearbyOptions.length === 1 ? "nearby school" : "nearby schools"} without any of
                  them going over cap
                </span>
              </div>
            </div>

            <div className="max-h-96 overflow-y-auto rounded-xl border border-white/10 bg-white/5 p-2 space-y-2">
              {nearbyOptions.map((o) => (
                <div key={o.school.dbn} className="panel p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/school/${o.school.dbn}`}
                        className="text-sm font-medium text-violet-300 hover:underline"
                      >
                        {o.school.name}
                      </Link>
                      <div className="text-xs text-white/50">
                        {o.school.dbn} · District {o.school.district}
                        {o.sameDistrict ? " (same district)" : ""} · {o.utilizationPct}% utilized
                      </div>
                    </div>
                    <span className="shrink-0 text-sm font-semibold text-emerald-300">
                      room for ~{o.spareStudents.toLocaleString()}
                    </span>
                  </div>
                  <div className="text-xs text-white/65 mt-1.5">
                    ~{o.distanceMiles} mi away · ~{o.estimatedCommuteMinutes} min added commute
                    {o.buildingIsBinding && (
                      <>
                        {" "}
                        · capped by building capacity ({o.buildingHeadroom.toLocaleString()} spare
                        seats), not class size
                      </>
                    )}
                    {o.usedCourseSeatConversion && !o.buildingIsBinding && (
                      <> · converted from course seats using this school&apos;s own course load</>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="text-xs text-white/50 italic mt-3">
          Capacity is <strong>cap × classes − students</strong> per grade band, at each band&apos;s
          own cap (20 K-3, 23 4-8, 25 high school), then bounded by the building&apos;s Blue Book
          capacity. High school figures are course seats, so they&apos;re divided by that
          school&apos;s real courses-per-student before being reported as children. Labeled{" "}
          <strong>technically feasible, not a recommendation</strong> — rezoning carries real costs
          for families, and a seat existing is not the same as a family accepting it.
        </p>
      </section>

      {/* ------------------------------------------------------------ SLOW -- */}
      <section className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h2 className="text-base font-semibold text-white">New construction</h2>
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-500/15 text-red-300">
            3–5+ years
          </span>
        </div>
        <p className="text-sm text-white/50 mb-4">
          The most durable fix, and the slowest — dependent on capital funding, site approval, and
          construction. Projects below are already in the School Construction Authority&apos;s
          pipeline, with a funded seat count and an anticipated opening year.
        </p>

        {/* --- Direct: seats landing in THIS school's building ---------------- */}
        {direct.length > 0 ? (
          <div className="mb-5">
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-200">
                  Direct expansion of this school
                </span>
              </div>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-2xl font-bold text-white">+{directSeats.toLocaleString()}</span>
                <span className="text-sm text-white/80">
                  funded seats are being added to this school across {direct.length}{" "}
                  {direct.length === 1 ? "project" : "projects"}
                </span>
              </div>
              {buildingShortfall != null && buildingShortfall > 0 && (
                <p className="text-sm text-white/65 mt-1.5">
                  This building is <strong>{buildingShortfall.toLocaleString()} students</strong> over
                  its Blue Book target capacity today, so the funded seats{" "}
                  {directSeats >= buildingShortfall ? (
                    <>
                      more than cover the gap on paper — though they arrive only when the project
                      opens, and say nothing about class size within the building.
                    </>
                  ) : (
                    <>
                      close about{" "}
                      {Math.round((directSeats / buildingShortfall) * 100)}% of it, leaving roughly{" "}
                      {(buildingShortfall - directSeats).toLocaleString()} students still above
                      capacity.
                    </>
                  )}
                </p>
              )}

              <div className="mt-3 space-y-2">
                {direct.map((p) => (
                  <div key={p.project_id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="text-sm font-medium text-white">{p.name}</div>
                      <span className="shrink-0 text-sm font-semibold text-emerald-300">
                        +{p.seats.toLocaleString()} seats
                      </span>
                    </div>
                    <div className="text-xs text-white/55 mt-1">
                      {[
                        p.anticipated_opening ? `Anticipated opening ${p.anticipated_opening}` : null,
                        p.address,
                        p.borough,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    {mapsHref(p) && (
                      <a
                        href={mapsHref(p)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block mt-1.5 text-xs text-violet-300 hover:underline"
                      >
                        Open site in Maps →
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-5 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/60">
            <strong className="text-white/80">No funded expansion for this school.</strong> This
            school does not appear in the SCA&apos;s capacity projects in process, so no addition or
            annex is currently scheduled for its building.
          </div>
        )}

        {/* --- Nearby: seats landing in the area, not this school ------------- */}
        {nearby.length > 0 && (
          <div className="mb-5">
            <h3 className="text-sm font-semibold text-white/90 mb-1">
              Capacity projects nearby (not seats for this school)
            </h3>
            <p className="text-xs text-white/50 mb-2">
              Within 3 miles. New buildings can draw enrollment away from this school over time, and
              an annex on a neighbouring school frees room in the same catchment — but none of these
              seats are allocated here.
            </p>
            <div className="space-y-2">
              {nearby.map((p) => (
                <div key={p.project_id} className="rounded-xl border border-white/10 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white">{p.name}</div>
                      <div className="text-xs text-white/50 mt-0.5">
                        {[
                          p.anticipated_opening ? `Opens ${p.anticipated_opening}` : null,
                          `~${p.distanceMiles} mi away`,
                          p.address,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-white/85">
                        +{p.seats.toLocaleString()} seats
                      </div>
                      <span
                        className={`inline-block mt-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                          p.project_type === "expansion"
                            ? "bg-sky-500/15 text-sky-200"
                            : "bg-violet-500/15 text-violet-200"
                        }`}
                      >
                        {p.project_type === "expansion" ? "Expansion" : "New school"}
                      </span>
                    </div>
                  </div>
                  {p.project_type === "expansion" && p.matched_school_name && (
                    <div className="text-xs text-white/55 mt-1.5">
                      Adds seats to{" "}
                      {p.dbn ? (
                        <Link href={`/school/${p.dbn}`} className="text-violet-300 hover:underline">
                          {p.matched_school_name}
                        </Link>
                      ) : (
                        p.matched_school_name
                      )}
                      .
                    </div>
                  )}
                  {p.project_type === "new_school" && (
                    <div className="text-xs text-white/55 mt-1.5">
                      A new building with no school assigned yet — SCA names these for their address
                      until a school is sited in them.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {direct.length === 0 && nearby.length === 0 && (
          <p className="text-sm text-white/50 mb-4">
            No SCA capacity project is in process within 3 miles of this school.
          </p>
        )}

        <p className="text-xs text-white/50 italic mb-5">
          Source: NYC Open Data{" "}
          <a
            href="https://data.cityofnewyork.us/d/dtmw-avzj"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Capacity Projects in Process Site Locations
          </a>{" "}
          (School Construction Authority). Seat counts and opening years are the SCA&apos;s own
          figures and shift as projects move through design and construction. Expansions are matched
          to schools by project name and site location — the SCA file carries no DBN.
        </p>

        {siteCandidates.length > 0 && (
          <>
            <h3 className="text-sm font-semibold text-white/90 mb-1.5">
              Unused city-owned land nearby worth investigating
            </h3>
            <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-xs text-amber-200 mb-2">
              <strong>Illustrative starting points only</strong> — not a siting recommendation. Real
              siting runs through SCA Real Estate Services, a 45-day public comment period, and
              Community Board / CEC hearings.
              <div className="mt-1.5">
                <strong>On the addresses:</strong> these come from the city&apos;s COLP dataset,
                which often records only a street name with no house number — and sometimes nothing
                at all. Every parcel below therefore also carries its{" "}
                <strong>BBL (Borough-Block-Lot)</strong>, the city&apos;s authoritative parcel ID,
                and its coordinates. Searching the BBL on{" "}
                <a
                  href="https://zola.planning.nyc.gov"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  ZoLa
                </a>{" "}
                or the Digital Tax Map will pin the exact lot even when the address is vague.
              </div>
            </div>

            <div className="space-y-2">
              {siteCandidates.map((p) => (
                <div key={p.parcel_id} className="rounded-xl border border-white/10 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="text-sm font-medium text-white">
                      {p.description ?? (
                        <span className="text-white/50 italic">No address recorded in COLP</span>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-white/50">~{p.distanceMiles} mi away</span>
                  </div>
                  <div className="text-xs text-white/50 mt-0.5">
                    {[p.borough, p.ownership].filter(Boolean).join(" · ")}
                  </div>

                  <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div className="flex gap-1.5">
                      <dt className="text-white/50 shrink-0">BBL:</dt>
                      <dd className="font-mono text-white/90">{p.bbl ?? "—"}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-white/50 shrink-0">Coordinates:</dt>
                      <dd className="font-mono text-white/90">
                        {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-2 flex flex-wrap gap-3 text-xs">
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-violet-300 hover:underline"
                    >
                      Open in Maps →
                    </a>
                    {p.bbl && (
                      <a
                        href={`https://zola.planning.nyc.gov/l/lot/${p.bbl.slice(0, 1)}/${Number(
                          p.bbl.slice(1, 6)
                        )}/${Number(p.bbl.slice(6))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-violet-300 hover:underline"
                      >
                        View lot on ZoLa →
                      </a>
                    )}
                  </div>

                  <div className="text-xs text-white/50 mt-1.5">
                    {p.lot_sqft && p.estimatedSeats
                      ? `${p.lot_sqft.toLocaleString()} sqft lot · very roughly ~${p.estimatedSeats.toLocaleString()} seats if built out`
                      : "Lot area isn't published in COLP, so buildable capacity is unknown — check the BBL on ZoLa for the lot dimensions."}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ------------------------------------------------------- ADMIN GUIDE -- */}
      <section className="panel p-5 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">
            Process &amp; policy: exemptions, staffing, restructuring
          </h2>
          <p className="text-sm text-white/50">
            How to file for a class-size exemption, what the expedited resolution timeline requires,
            staffing funds and pay differentials, and capital requests.
          </p>
        </div>
        <Link
          href="/admin-guide"
          className="shrink-0 inline-flex items-center rounded-xl bg-black/40 text-white text-sm font-medium px-4 py-2 hover:bg-black/60"
        >
          Administrator guide →
        </Link>
      </section>
    </div>
  );
}
