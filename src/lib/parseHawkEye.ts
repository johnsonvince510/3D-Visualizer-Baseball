// src/lib/parseHawkEye.ts

export type V3 = [number, number, number];

export interface ParsedTrack {
  role: string;                  // "pitcher" | "hitter" | "batter" | "unknown"
  name?: string;                 // from players[] when available
  personId?: any;
  fps: number;                   // frame rate used
  frames: { time: number; joints: Record<string, V3> }[];
  // Optional metric bags (you can extend later; safe to leave empty)
  pitchMetrics?: {
    velocityMph?: number | null;
    ivbInches?: number | null;
    hbInches?: number | null;
    extensionFt?: number | null;
  };
  hitMetrics?: {
    evMph?: number | null;
    laDeg?: number | null;
    batSpeedMph?: number | null;
    swingPathTiltDeg?: number | null;
    attackDirectionDeg?: number | null;
    attackAngleDeg?: number | null;
  };
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function firstDefined<T>(...vals: (T | null | undefined)[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v as T;
  return undefined;
}

function normalizeRole(raw: any): string {
  const s = (raw?.name ?? raw ?? "").toString().toLowerCase();
  if (s.includes("pitch")) return "pitcher";
  if (s.includes("bat") || s.includes("hit")) return "hitter";
  return s || "unknown";
}

function extractFPS(root: any, person?: any): number {
  return (
    num(person?.system?.targetFrameRate) ??
    num(root?.samples?.system?.targetFrameRate) ??
    num(root?.system?.targetFrameRate) ??
    300
  ) as number;
}

function buildFramesFromPerson(person: any, fps: number) {
  // Hawkeye form: person.joints = Array< Record<string, V3> >
  const jointsArr = Array.isArray(person?.joints) ? person.joints : null;
  if (!jointsArr || !jointsArr.length) return [] as { time: number; joints: Record<string, V3> }[];

  const frames = jointsArr.map((J: any, i: number) => {
    // Ensure values are triples
    const out: Record<string, V3> = {};
    if (J && typeof J === "object") {
      for (const [k, v] of Object.entries(J)) {
        if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) {
          out[k] = [v[0], v[1], v[2]];
        }
      }
    }
    return { time: i / fps, joints: out };
  });
  return frames;
}

function extractNames(root: any) {
  // Optional helper if you want names later elsewhere
  // Try several vendor locations
  const players =
    (Array.isArray(root?.players) && root.players) ||
    (Array.isArray(root?.details?.players) && root.details.players) ||
    null;

  let pitcherName: string | undefined;
  let batterName: string | undefined;

  if (players) {
    const pit =
      players.find((p: any) => (p?.role?.name ?? "").toLowerCase() === "pitcher") ||
      players.find((p: any) => (p?.role ?? "").toLowerCase?.() === "pitcher");
    const bat =
      players.find((p: any) => (p?.role?.name ?? "").toLowerCase() === "batter") ||
      players.find((p: any) => (p?.role?.name ?? "").toLowerCase() === "hitter") ||
      players.find((p: any) => ["batter", "hitter"].includes((p?.role ?? "").toLowerCase?.()));

    pitcherName = pit?.name || pit?.fullName || pit?.displayName;
    batterName  = bat?.name || bat?.fullName || bat?.displayName;
  }
  return { pitcherName, batterName };
}

function extractPitchMetrics(root: any) {
  // Pull velocity / movement / extension from a bunch of likely places
  // Return nulls if absent — the visualizer will show "-" but stay stable
  const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const mph = (ms: number | null) => (ms == null ? null : ms * 2.23694);
  const toInches = (m: number | null) => (m == null ? null : m * 39.3701);
  const toFeet = (m: number | null) => (m == null ? null : m * 3.28084);

  const objectsToSearch = [
    root?.pitch, root?.details?.pitch, root?.ball, root?.samples?.ball?.[0],
    root?.events?.pitch, root?.metrics, root?.details
  ];

  function findAny(keys: string[]) {
    for (const o of objectsToSearch) {
      if (!o) continue;
      for (const k of keys) {
        const v = o[k];
        if (Number.isFinite(Number(v))) return Number(v);
      }
    }
    return null;
  }

  const vMph = firstDefined<number | null>(
    findAny(["velocityMph", "pitchVelocityMph", "veloMph", "speedMph"]),
    (() => {
      const ms = findAny(["velocityMs", "pitchVelocityMs", "speedMs"]);
      return mph(ms);
    })()
  ) ?? null;

  const ivbIn = firstDefined<number | null>(
    findAny(["inducedVerticalBreakIn", "ivbInches", "ivb_in"]),
    toInches(findAny(["inducedVerticalBreakM", "ivbMeters", "ivb_m"]))
  ) ?? null;

  const hbIn = firstDefined<number | null>(
    findAny(["horizontalBreakIn", "hbInches", "hBreakIn"]),
    toInches(findAny(["horizontalBreakM", "hbMeters", "hBreakM"]))
  ) ?? null;

  const extFt = firstDefined<number | null>(
    findAny(["extensionFt", "releaseExtensionFt"]),
    toFeet(findAny(["extensionM", "releaseExtensionM"]))
  ) ?? null;

  return {
    velocityMph: vMph,
    ivbInches: ivbIn,
    hbInches: hbIn,
    extensionFt: extFt
  };
}

function extractHitMetrics(root: any) {
  const toMph = (ms: number | null) => (ms == null ? null : ms * 2.23694);

  const objectsToSearch = [
    root?.battedBall, root?.contact, root?.events?.contact, root?.details?.contact, root?.metrics, root?.details
  ];

  function findAny(keys: string[]) {
    for (const o of objectsToSearch) {
      if (!o) continue;
      for (const k of keys) {
        const v = o[k];
        if (Number.isFinite(Number(v))) return Number(v);
      }
    }
    return null;
  }

  const evMph = (() => {
    const mph = findAny(["exitVelocityMph", "evMph", "exitVeloMph"]);
    if (mph != null) return mph;
    const ms = findAny(["exitVelocityMs", "evMs"]);
    return toMph(ms);
  })();

  const laDeg          = findAny(["launchAngleDeg", "laDeg", "launchAngle"]);
  const batSpeedMph    = findAny(["batSpeedMph", "swingSpeedMph", "batVelocityMph"]);
  const swingPathTilt  = findAny(["swingPathTiltDeg", "swingTiltDeg"]);
  const attackDir      = findAny(["attackDirectionDeg", "attackDirDeg"]);
  const attackAngle    = findAny(["attackAngleDeg", "attackAngle"]);

  return {
    evMph: evMph ?? null,
    laDeg: laDeg ?? null,
    batSpeedMph: batSpeedMph ?? null,
    swingPathTiltDeg: swingPathTilt ?? null,
    attackDirectionDeg: attackDir ?? null,
    attackAngleDeg: attackAngle ?? null,
  };
}

export function parseHawkEyeJson(root: any): ParsedTrack[] {
  const out: ParsedTrack[] = [];

  // Preferred skeleton location (per your logs)
  const people = Array.isArray(root?.samples?.people) ? root.samples.people : null;

  if (people && people.length) {
    const pitchMetrics = extractPitchMetrics(root);
    const hitMetrics   = extractHitMetrics(root);

    for (const person of people) {
      const fps = extractFPS(root, person);
      const frames = buildFramesFromPerson(person, fps);
      if (!frames.length) continue;

      const role = normalizeRole(person?.role);
      const name =
        person?.name ||
        person?.fullName ||
        person?.displayName ||
        undefined;

      const track: ParsedTrack = {
        role,
        name,
        personId: person?.personId,
        fps,
        frames,
      };

      // Attach metric bags once per file (not per person) but available for UI
      if (role === "pitcher") track.pitchMetrics = pitchMetrics;
      if (role === "hitter")  track.hitMetrics   = hitMetrics;

      out.push(track);
    }
  }

  return out;
}
