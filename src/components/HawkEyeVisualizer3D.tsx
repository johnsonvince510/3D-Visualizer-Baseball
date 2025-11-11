import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { parseHawkEyeJson } from "../lib/parseHawkEye"; // keep relative (no @ alias)

// =================== Config/Constants ===================
const FS_DEFAULT = 560; // user-requested fixed indices
const BR_DEFAULT = 605;// ======== Hawk-Eye metric/name helpers (non-breaking) ========
function firstNum(...vals:any[]){ for(const v of vals){ const n = Number(v); if(Number.isFinite(n)) return n; } return null; }
function mphFromMs(ms:number|null){ return ms==null? null : ms*2.23694; }
function mphFromKph(kph:number|null){ return kph==null? null : kph*0.621371; }
function inchesFromMm(mm:number|null){ return mm==null? null : (mm/25.4); }
function inchesFromCm(cm:number|null){ return cm==null? null : (cm/2.54); }
function feetFromM(m:number|null){ return m==null? null : (m*3.28084); }

function extractNames(root:any){
  let pitcherName:string|undefined, batterName:string|undefined;
  const players = Array.isArray(root?.players)? root.players : (Array.isArray(root?.details?.players)? root.details.players : null);
  if(players){
    const pit = players.find((p:any)=> (p?.role?.name||"").toLowerCase()==="pitcher") || players[0];
    const bat = players.find((p:any)=> ["batter","hitter"].includes((p?.role?.name||"").toLowerCase()));
    pitcherName = pit?.name || pit?.fullName || pit?.displayName;
    batterName  = bat?.name || bat?.fullName || bat?.displayName;
  }else{
    pitcherName = root?.pitcher?.name || root?.details?.pitcher?.name;
    batterName  = root?.batter?.name  || root?.details?.batter?.name;
  }
  return {pitcherName, batterName};
}

function extractPitchMetrics(root:any){
  const velocityMph = firstNum(
    root?.pitch?.velocityMph, root?.pitchData?.velocityMph, root?.details?.pitch?.velocityMph, root?.metrics?.pitch?.velocityMph,
    (()=>{ const ms = firstNum(root?.pitch?.velocityMs, root?.pitchData?.velocityMs); return mphFromMs(ms); })(),
    (()=>{ const k = firstNum(root?.pitch?.velocityKph, root?.pitchData?.velocityKph); return mphFromKph(k); })()
  );
  const inducedVertBreakIn = firstNum(
    root?.pitch?.inducedVertBreakIn, root?.pitchData?.inducedVertBreakIn, root?.metrics?.pitch?.ivbIn, root?.metrics?.pitch?.verticalBreakIn,
    (()=> inchesFromMm(firstNum(root?.pitch?.inducedVertBreakMm, root?.pitchData?.inducedVertBreakMm)) )(),
    (()=> inchesFromCm(firstNum(root?.pitch?.inducedVertBreakCm, root?.pitchData?.inducedVertBreakCm)) )()
  );
  const horizontalBreakIn = firstNum(
    root?.pitch?.horizontalBreakIn, root?.pitchData?.horizontalBreakIn, root?.metrics?.pitch?.hbIn, root?.metrics?.pitch?.horizontalBreakIn,
    (()=> inchesFromMm(firstNum(root?.pitch?.horizontalBreakMm, root?.pitchData?.horizontalBreakMm)) )(),
    (()=> inchesFromCm(firstNum(root?.pitch?.horizontalBreakCm, root?.pitchData?.horizontalBreakCm)) )()
  );
  const extensionFt = firstNum(
    root?.pitch?.extensionFt, root?.pitchData?.extensionFt, root?.metrics?.pitch?.extensionFt,
    (()=> feetFromM(firstNum(root?.pitch?.extensionM, root?.pitchData?.extensionM)) )()
  );
  return { velocityMph, inducedVertBreakIn, horizontalBreakIn, extensionFt };
}

function extractBatMetrics(root:any){
  // EV, LA, Bat speed, swing path tilt, attack direction, attack angle
  const contact = (Array.isArray(root?.events)? root.events : (Array.isArray(root?.details?.events)? root.details.events : []))?.find?.((e:any)=> String(e?.type||"").toUpperCase()==="CONTACT");
  const evMph = firstNum(root?.battedBall?.exitVelocityMph, contact?.exitVelocityMph,
                         mphFromMs(firstNum(root?.battedBall?.exitVelocityMs, contact?.exitVelocityMs)),
                         mphFromKph(firstNum(root?.battedBall?.exitVelocityKph, contact?.exitVelocityKph)));
  const laDeg = firstNum(root?.battedBall?.launchAngleDeg, contact?.launchAngleDeg, root?.battedBall?.launchAngle, contact?.launchAngle);

  const batSpeedMph = firstNum(root?.swing?.batSpeedMph, root?.metrics?.bat?.speedMph, contact?.batSpeedMph,
                               mphFromMs(firstNum(root?.swing?.batSpeedMs, contact?.batSpeedMs)),
                               mphFromKph(firstNum(root?.swing?.batSpeedKph, contact?.batSpeedKph)));
  const swingPathTiltDeg = firstNum(root?.swing?.swingPathTiltDeg, root?.metrics?.swing?.pathTiltDeg, contact?.swingPathTiltDeg);
  const attackDirectionDeg = firstNum(root?.swing?.attackDirectionDeg, root?.metrics?.swing?.attackDirectionDeg, contact?.attackDirectionDeg);
  const attackAngleDeg = firstNum(root?.swing?.attackAngleDeg, root?.metrics?.swing?.attackAngleDeg, contact?.attackAngleDeg);

  return { evMph, laDeg, batSpeedMph, swingPathTiltDeg, attackDirectionDeg, attackAngleDeg };
}



// ========== Helpers ==========
type V3 = [number, number, number];

const IDX = {
  head: 0, neck: 1, chest: 2, pelvis: 3,
  lShoulder: 4, lElbow: 5, lWrist: 6,
  rShoulder: 7, rElbow: 8, rWrist: 9,
  lHip: 10, lKnee: 11, lAnkle: 12,
  rHip: 13, rKnee: 14, rAnkle: 15,
} as const;

const BONES: [number, number][] = [
  [IDX.head, IDX.neck], [IDX.neck, IDX.chest], [IDX.chest, IDX.pelvis],
  [IDX.chest, IDX.lShoulder], [IDX.lShoulder, IDX.lElbow], [IDX.lElbow, IDX.lWrist],
  [IDX.chest, IDX.rShoulder], [IDX.rShoulder, IDX.rElbow], [IDX.rElbow, IDX.rWrist],
  [IDX.pelvis, IDX.lHip], [IDX.lHip, IDX.lKnee], [IDX.lKnee, IDX.lAnkle],
  [IDX.pelvis, IDX.rHip], [IDX.rHip, IDX.rKnee], [IDX.rKnee, IDX.rAnkle],
];

const HOME_BASE = new THREE.Vector3(-1, 0, 0); // pitcher->catcher along -X
const SMOOTH_ALPHA = 0.35;

function wrap180(d: number) {
  if (!isFinite(d)) return d;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}
function unwrapToPrev(newDeg: number, prevDeg: number) {
  let cand = newDeg;
  while (prevDeg - cand > 180) cand += 360;
  while (cand - prevDeg > 180) cand -= 360;
  return wrap180(cand);
}
function yawDeg(ref: THREE.Vector3, v: THREE.Vector3) {
  // Signed angle between ref and v on ground (XY) plane
  const R = new THREE.Vector3(ref.x, ref.y, 0).normalize();
  const V = new THREE.Vector3(v.x, v.y, 0).normalize();
  const cross = R.x * V.y - R.y * V.x;
  const dot = R.dot(V);
  return THREE.MathUtils.radToDeg(Math.atan2(cross, dot));
}
function finiteDiff(vals: number[], times: number[]) {
  const n = vals.length, v = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(1e-6, (times[i] ?? 0) - (times[i - 1] ?? 0));
    v[i] = (vals[i] - vals[i - 1]) / dt;
  }
  return v;
}
function movingAvg(a: number[], k = 3) {
  if (k <= 1) return a.slice();
  const n = a.length, out = new Array(n).fill(0);
  const r = Math.floor(k / 2);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = i - r; j <= i + r; j++) {
      if (j >= 0 && j < n) { s += a[j]; c++; }
    }
    out[i] = c ? s / c : a[i];
  }
  return out;
}
function fold90(deg: number) {
  const d = Math.abs(deg % 360);
  const d180 = d > 180 ? 360 - d : d;
  return Math.min(d180, 180 - d180);
}
function signedAngleInPlane(a: THREE.Vector3, b: THREE.Vector3, planeNormal: THREE.Vector3) {
  const A = a.clone().normalize();
  const B = b.clone().normalize();
  const cross = new THREE.Vector3().crossVectors(A, B);
  const sin = cross.dot(planeNormal);
  const cos = A.dot(B);
  return THREE.MathUtils.radToDeg(Math.atan2(sin, cos));
}

// Release time from JSON → seconds since clip start (if present)
function extractReleaseSecondsFromJson(root: any): number | undefined {
  const events = root?.events ?? root?.details?.events ?? [];
  const pitchEvt = Array.isArray(events)
    ? events.find((e: any) => String(e?.type || "").toUpperCase() === "PITCH")
    : undefined;

  const relUTC =
    pitchEvt?.refinedReleaseTimeUTC ??
    pitchEvt?.releaseTimeUTC ??
    pitchEvt?.ballReleaseTimeUTC ??
    pitchEvt?.releaseUtc ??
    null;

  if (!relUTC) return undefined;

  const startUTC =
    root?.time?.startUTC ??
    root?.timeline?.startUTC ??
    root?.meta?.startUTC ??
    null;

  if (!startUTC) return undefined;

  const relMs = new Date(relUTC).getTime() - new Date(startUTC).getTime();
  return relMs / 1000;
}
function indexFromTime(frames: { time: number }[], tSec?: number): number | undefined {
  if (!frames?.length || tSec == null) return undefined;
  let best = 0, bestErr = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const err = Math.abs((frames[i]?.time ?? 0) - tSec);
    if (err < bestErr) { bestErr = err; best = i; }
  }
  return best;
}

// ————— Enhanced Foot-Strike —————
function findFootStrike(frames: { time: number; joints: Record<string, V3> }[], handHint: "R"|"L"|"?") {
  if (!frames.length) return undefined;

  // Detect lead side
  let leadSide: "L" | "R";
  if (handHint === "R") leadSide = "L";
  else if (handHint === "L") leadSide = "R";
  else {
    const mid = frames[Math.floor(frames.length * 0.5)]?.joints ?? {};
    const rA = (mid["rAnkle"] || (mid as any)["rightAnkle"] || (mid as any)["rHeel"] || (mid as any)["rBigToe"]) as V3 | undefined;
    const lA = (mid["lAnkle"] || (mid as any)["leftAnkle"]  || (mid as any)["lHeel"] || (mid as any)["lBigToe"]) as V3 | undefined;
    leadSide = rA && lA ? (rA[0] < lA[0] ? "R" : "L") : rA ? "R" : "L";
  }

  const aKey = leadSide === "R"
    ? (names: Record<string, V3>) => (names["rAnkle"] || (names as any)["rightAnkle"] || (names as any)["rHeel"] || (names as any)["rBigToe"]) as V3 | undefined
    : (names: Record<string, V3>) => (names["lAnkle"] || (names as any)["leftAnkle"] || (names as any)["lHeel"] || (names as any)["lBigToe"]) as V3 | undefined;

  // series
  const Y: number[] = [], X: number[] = [], Z: number[] = [], T: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const p = aKey(frames[i].joints);
    const lastY = Y.length ? Y[Y.length - 1] : 0;
    const lastX = X.length ? X[X.length - 1] : 0;
    const lastZ = Z.length ? Z[Z.length - 1] : 0;
    Y.push(p ? p[1] : lastY);
    X.push(p ? p[0] : lastX);
    Z.push(p ? p[2] : lastZ);
    T.push(frames[i].time ?? (i * 1 / 120));
  }

  const Vy = movingAvg(finiteDiff(Y, T), 3);
  const Vh = movingAvg(X.map((_, i) => Math.hypot((X[i] - (X[i-1] ?? X[i])), (Z[i] - (Z[i-1] ?? Z[i])))/Math.max(1e-6,(T[i]-(T[i-1]??T[i])))), 3);

  // Foot yaw stability proxy
  const footYaw: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const j = frames[i].joints as Record<string, V3>;
    const a = aKey(j);
    const toe = leadSide === "R"
      ? ((j as any)["rBigToe"] || (j as any)["rightBigToe"] || (j as any)["rHeel"])
      : ((j as any)["lBigToe"] || (j as any)["leftBigToe"]  || (j as any)["lHeel"]);
    if (a && toe) {
      const dir = new THREE.Vector3(toe[0]-a[0], toe[1]-a[1], toe[2]-a[2]);
      dir.setZ(0);
      if (dir.lengthSq() > 1e-10) dir.normalize();
      footYaw.push(Math.atan2(dir.y, dir.x)); // radians
    } else {
      footYaw.push(footYaw.length ? footYaw[footYaw.length - 1] : 0);
    }
  }
  const dYaw = movingAvg(finiteDiff(footYaw, T).map(v => Math.abs(v)), 5);

  // Score
  let bestIdx: number | undefined;
  let bestScore = Infinity;
  for (let i = 2; i < Y.length - 2; i++) {
    const localMin = Y[i] <= Y[i - 1] && Y[i] <= Y[i + 1];
    if (!localMin) continue;
    const vy0 = Math.abs(Vy[i]);
    const speedDrop = (Vh[i - 1] - Vh[i]);
    const yawStable = dYaw[i];
    const score = (vy0 * 4.0) + (-speedDrop * 2.0) + (yawStable * 1.5) + (Y[i] * 0.2);
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ————— Enhanced Ball Release —————
function findBallRelease(frames: { time: number; joints: Record<string, V3> }[], handHint: "R"|"L"|"?", jsonReleaseSec?: number) {
  if (!frames.length) return undefined;

  let seedIdx: number | undefined;
  if (jsonReleaseSec != null) {
    seedIdx = indexFromTime(frames as any, jsonReleaseSec);
  }

  // Identify throwing side
  let throwSide: "R" | "L";
  if (handHint === "R") throwSide = "R";
  else if (handHint === "L") throwSide = "L";
  else {
    const n = frames.length;
    const s = Math.floor(n * 0.75);
    let rx = 0, lx = 0, rc = 0, lc = 0;
    for (let i = s + 1; i < n; i++) {
      const a = frames[i - 1].joints as Record<string, V3>;
      const b = frames[i].joints as Record<string, V3>;
      const r0 = (a["rWrist"] || (a as any)["rightWrist"]) as V3 | undefined;
      const r1 = (b["rWrist"] || (b as any)["rightWrist"]) as V3 | undefined;
      const l0 = (a["lWrist"] || (a as any)["leftWrist"]) as V3 | undefined;
      const l1 = (b["lWrist"] || (b as any)["leftWrist"]) as V3 | undefined;
      if (r0 && r1) { rx += (r1[0] - r0[0]); rc++; }
      if (l0 && l1) { lx += (l1[0] - l0[0]); lc++; }
    }
    const rdx = rc ? rx / rc : 0;
    const ldx = lc ? lx / lc : 0;
    throwSide = (rdx < ldx) ? "R" : "L";
  }

  // Series for wrist forward speed (toward HOME is −X)
  const wKeyX = (j: Record<string, V3>) => {
    const w = throwSide === "R"
      ? (j["rWrist"] || (j as any)["rightWrist"])
      : (j["lWrist"] || (j as any)["leftWrist"]);
    return (w as V3 | undefined)?.[0];
  };

  const T: number[] = [];
  const X: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    T.push(frames[i].time ?? (i * 1 / 120));
    const x = wKeyX(frames[i].joints);
    X.push(x != null ? x : (X.length ? X[X.length - 1] : 0));
  }
  const Vx = movingAvg(finiteDiff(X, T), 3); // forward speed

  // Elbow extension velocity proxy
  function elbowExtVel(side: "R" | "L") {
    const ang: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      const j = frames[i].joints as Record<string, V3>;
      const s = side === "R"
        ? { sh: j["rShoulder"] || (j as any)["rightShoulder"], el: j["rElbow"] || (j as any)["rightElbow"], wr: j["rWrist"] || (j as any)["rightWrist"] }
        : { sh: j["lShoulder"] || (j as any)["leftShoulder"], el: j["lElbow"] || (j as any)["leftElbow"], wr: j["lWrist"] || (j as any)["leftWrist"] };
      if (s.sh && s.el && s.wr) {
        const u = new THREE.Vector3(s.sh[0]-s.el[0], s.sh[1]-s.el[1], s.sh[2]-s.el[2]).normalize();
        const f = new THREE.Vector3(s.wr[0]-s.el[0], s.wr[1]-s.el[1], s.wr[2]-s.el[2]).normalize();
        ang.push(THREE.MathUtils.radToDeg(u.angleTo(f)));
      } else {
        ang.push(ang.length ? ang[ang.length-1] : 0);
      }
    }
    const d = movingAvg(finiteDiff(ang, T), 3);
    return d;
  }
  const dElbow = elbowExtVel(throwSide);

  // Trunk angular speed proxy
  const trunkYaw: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const j = frames[i].joints as Record<string, V3>;
    const lSh = (j["lShoulder"] || (j as any)["leftShoulder"]) as V3 | undefined;
    const rSh = (j["rShoulder"] || (j as any)["rightShoulder"]) as V3 | undefined;
    if (lSh && rSh) {
      const axis = new THREE.Vector3(rSh[0]-lSh[0], rSh[1]-lSh[1], rSh[2]-lSh[2]);
      trunkYaw.push(yawDeg(HOME_BASE, axis));
    } else {
      trunkYaw.push(trunkYaw.length ? trunkYaw[trunkYaw.length-1] : 0);
    }
  }
  const dTrunk = movingAvg(finiteDiff(trunkYaw, T).map(v => Math.abs(v)), 3);

  if (seedIdx == null) {
    let minV = 1e9, idx = 0;
    for (let i = 1; i < Vx.length; i++) {
      if (Vx[i] < minV) { minV = Vx[i]; idx = i; }
    }
    seedIdx = idx;
  }

  const lo = Math.max(1, seedIdx - 20);
  const hi = Math.min(Vx.length - 2, seedIdx + 20);
  let best = seedIdx;
  let bestScore = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const score = (-Vx[i]) * 1.0 + (dElbow[i] ?? 0) * 0.8 + (dTrunk[i] ?? 0) * 0.5;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// Handedness fallback
function detectHandedness(frames: { time: number; joints: Record<string, V3> }[]): "R" | "L" | "?" {
  if (!frames.length) return "?";
  const n = frames.length;
  const start = Math.floor(n * 0.75);
  let rx = 0, lx = 0, rc = 0, lc = 0;
  for (let i = start + 1; i < n; i++) {
    const a = frames[i - 1].joints as Record<string, V3>;
    const b = frames[i].joints as Record<string, V3>;
    const r0 = (a["rWrist"] || (a as any)["rightWrist"]) as V3 | undefined;
    const r1 = (b["rWrist"] || (b as any)["rightWrist"]) as V3 | undefined;
    const l0 = (a["lWrist"] || (a as any)["leftWrist"]) as V3 | undefined;
    const l1 = (b["lWrist"] || (b as any)["leftWrist"]) as V3 | undefined;
    if (r0 && r1) { rx += (r1[0] - r0[0]); rc++; }
    if (l0 && l1) { lx += (l1[0] - l0[0]); lc++; }
  }
  const rdx = rc ? rx / rc : 0;
  const ldx = lc ? lx / lc : 0;
  if (rdx < ldx) return "R";
  if (ldx < rdx) return "L";
  return "?";
}

// ---- Simple Sparkline (for biomech series) ----
function Sparkline({ series, idx, label, fmt = (v:number)=>v.toFixed(1), unit="" }: { series: number[]; idx: number; label: string; fmt?: (v:number)=>string; unit?: string }) {
  const w = 260, h = 60, pad = 6;
  const vals = series.filter((v)=>Number.isFinite(v));
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const range = (max - min) || 1;
  const path = [];
  for (let i = 0; i < series.length; i++) {
    const x = pad + (w - 2*pad) * (i / Math.max(1, series.length - 1));
    const y = pad + (h - 2*pad) * (1 - ((series[i] - min) / range));
    path.push(`${i===0 ? 'M' : 'L'}${x},${y}`);
  }
  const cx = pad + (w - 2*pad) * (idx / Math.max(1, series.length - 1));
  const cy = pad + (h - 2*pad) * (1 - (((series[idx] ?? NaN) - min) / range));
  const cur = series[idx];
  return (
    <div style={{display:"grid", gridTemplateColumns:"1fr auto", gap:8, alignItems:"center"}}>
      <div style={{fontSize:12, opacity:0.85}}>{label}</div>
      <div style={{fontVariantNumeric:"tabular-nums"}}><b>{Number.isFinite(cur)? fmt(cur): "-"}</b>{unit}</div>
      <svg width={w} height={h} style={{gridColumn:"1 / span 2", background:"#0b1224", border:"1px solid #1e293b", borderRadius:8}}>
        <path d={path.join(" ")} fill="none" stroke="#93c5fd" strokeWidth="1.5" />
        <line x1={cx} x2={cx} y1={pad} y2={h-pad} stroke="#ef4444" strokeDasharray="2,2" />
        {Number.isFinite(cur) && <circle cx={cx} cy={cy} r="3" fill="#ef4444" />}
      </svg>
    </div>
  );
}

// ========== Component ==========
export default function HawkEyeVisualizer3D() {
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer>();
  const sceneRef = useRef<THREE.Scene>(new THREE.Scene());
  const cameraRef = useRef<THREE.PerspectiveCamera>();
  const controlsRef = useRef<OrbitControls>();

  const skeletonRootRef = useRef<THREE.Group>(new THREE.Group());
  const jointsGroup = useRef<THREE.Group>(new THREE.Group());
  const bonesGroup = useRef<THREE.Group>(new THREE.Group());
  jointsGroup.current.name = "jointsGroup";
  bonesGroup.current.name = "bonesGroup";
  skeletonRootRef.current.name = "skeletonRoot";

  const lockedQuatRef = useRef<THREE.Quaternion | null>(null);
  const prevQuatRef = useRef<THREE.Quaternion | null>(null);
  const prevJointMapRef = useRef<Record<string, THREE.Vector3>>({});
  const prevTrunkDegRef = useRef<number | null>(null);

  const [tracks, setTracks] = useState<any[]>([]);
  const [ti, setTi] = useState(0);
  const [fi, setFi] = useState(0);
  const [fsIdx, setFsIdx] = useState<number | null>(FS_DEFAULT);
  const [brIdx, setBrIdx] = useState<number | null>(BR_DEFAULT);

  const [debug, setDebug] = useState("");
  const [bodyHeight, setBodyHeight] = useState<number | "">("");
  const [showOverlay, setShowOverlay] = useState(false);
  const [flipHome, setFlipHome] = useState(false);
  const [flipHAbd, setFlipHAbd] = useState(false);

  const [hands, setHands] = useState<Record<number, "R"|"L"|"?">>({});

  // --- Pitch metrics (constant-per-pitch display) ---
  const [pitchVelocity, setPitchVelocity] = useState<number | null>(null);
  const [pitchIVB, setPitchIVB] = useState<number | null>(null);
  const [pitchHB, setPitchHB] = useState<number | null>(null);
  const [pitchExt, setPitchExt] = useState<number | null>(null);

  useEffect(() => {
    const host = canvasHost.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = sceneRef.current;
    scene.background = new THREE.Color(0x0b1020);
    scene.add(skeletonRootRef.current);
    skeletonRootRef.current.add(jointsGroup.current);
    skeletonRootRef.current.add(bonesGroup.current);

    const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.01, 1000);
    camera.position.set(3.0, 1.8, 4.0);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(3, 5, 6);
    scene.add(dir);

    const grid = new THREE.GridHelper(10, 10, 0x1e293b, 0x1e293b);
    grid.name = "gridHelper";
    scene.add(grid);

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth, h = host.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      host.innerHTML = "";
    };
  }, []);

  function purgeStray(scene: THREE.Scene) {
    const toRemove: THREE.Object3D[] = [];
    scene.traverse((obj) => {
      const pn = obj.parent?.name || "";
      const isSkeleton =
        pn === "jointsGroup" || pn === "bonesGroup" ||
        obj.name === "jointsGroup" || obj.name === "bonesGroup" || obj.name === "skeletonRoot";
      const isGrid = obj.name === "gridHelper" || obj.type === "GridHelper";
      const isAxes = obj.type === "AxesHelper" || (obj.name || "").toLowerCase().includes("axes");
      const isLine = (obj as any).isLine || (obj as any).isLineSegments;
      const looksLikeSpoke = (obj.name || "").toLowerCase().includes("spoke") || (isLine && !isSkeleton);
      if (!isSkeleton && (isGrid || isAxes || isLine || looksLikeSpoke)) toRemove.push(obj);
    });
    toRemove.forEach((o) => o.parent?.remove(o));
  }

  // Read files, parse tracks, attach handedness & (optional) pitch metrics
// Read files, parse tracks, attach handedness & (optional) pitch metrics
async function onFiles(fs: FileList | null) {
  if (!fs) return;

  const all: any[] = [];

  for (const f of Array.from(fs)) {
    try {
      const text = await f.text();
      const obj = JSON.parse(text);

      // ===== Debug taps so you can see what shape this file has =====
      try {
        // eslint-disable-next-line no-console
        console.log("RAW JSON LOADED:", obj);
        // eslint-disable-next-line no-console
        console.log("root.samples:", obj?.samples);
        // eslint-disable-next-line no-console
        console.log("root.samples?.people:", obj?.samples?.people);
        // eslint-disable-next-line no-console
        console.log("root.people:", obj?.people);
        // eslint-disable-next-line no-console
        console.log("root.tracks:", obj?.tracks);
      } catch {}

      // ===== Your existing parser (kept) =====
      const parsed = parseHawkEyeJson(obj);

      // ===== Pitcher/Hitter names (optional – doesn’t break if absent) =====
      let pitcherName: string | undefined;
      let batterName: string | undefined;
      try {
        const players =
          (Array.isArray((obj as any).players) && (obj as any).players) ||
          (Array.isArray((obj as any).details?.players) && (obj as any).details.players) ||
          null;

        if (players) {
          const pit =
            players.find((p: any) => (p?.role?.name || "").toLowerCase() === "pitcher") ||
            players.find((p: any) => ["p"].includes((p?.role?.abbr || "").toLowerCase()));
          const bat =
            players.find((p: any) => (p?.role?.name || "").toLowerCase() === "batter") ||
            players.find((p: any) => ["hitter", "b"].includes((p?.role?.name || "").toLowerCase()));

          pitcherName = pit?.name || pit?.fullName || pit?.displayName;
          batterName  = bat?.name || bat?.fullName || bat?.displayName;
        }
      } catch {}

      // ===== Lift pitch metrics if the file contains them somewhere =====
      const pitch = obj?.pitch || obj?.details?.pitch || obj?.metrics || obj?.trackman || {};
      const pitchMeta = {
        velocity:        pitch.releaseSpeed ?? pitch.releaseVelocity ?? pitch.pitchVelocity ?? null, // mph or m/s depending vendor
        ivb:             pitch.inducedVerticalBreak ?? pitch.ivb ?? null,                            // usually inches
        hb:              pitch.horizontalBreak ?? pitch.hBreak ?? null,                              // inches (L/R sign by vendor)
        extension:       pitch.extension ?? pitch.releaseExtension ?? null,                          // ft or m
      };

      // If your JSON also stores per-frame/ball arrays, attach them so we can fill series:
      const ball = obj?.ball || obj?.details?.ball || null;

      // ===== Attach per-track metadata without mutating your parser’s structure =====
      if (Array.isArray(parsed)) {
        for (const t of parsed as any[]) {
          // keep existing hand hint from elsewhere if you already place it
          (t as any)._handFromJson = (t as any)._handFromJson ?? "?";
          (t as any)._releaseSeconds =
            (obj?.events ?? obj?.details?.events ?? [])
              ?.find?.((e: any) => String(e?.type || "").toUpperCase() === "PITCH")
              ? undefined // your extractReleaseSeconds routine will run later if you use it
              : undefined;

          // names (if you want to display them later)
          (t as any)._pitcherName = pitcherName;
          (t as any)._batterName  = batterName;

          // constant pitch-meta (for the metric tiles — DOES NOT animate)
          (t as any).pitchMeta = pitchMeta;

          // optional ball arrays for graph fill (if present)
          if (ball && Array.isArray(ball.times)) {
            (t as any).ballTimes = ball.times;
            (t as any).ballV     = ball.velocity ?? null;
            (t as any).ballIVB   = ball.ivb ?? null;
            (t as any).ballHB    = ball.hb ?? null;
            (t as any).ballExt   = ball.extension ?? null;
          }
        }
      }

      // ===== Important: ensure we push all parsed tracks =====
      all.push(...parsed);
    } catch (e: any) {
      setDebug(`Parse error in ${f.name}: ${String(e?.message || e)}`);
    }
  }

  // Your visualizer only wants pitcher/hitter roles
  const playable = all.filter((t) =>
    ["pitcher", "hitter", "batter"].includes(String(t.role || "").toLowerCase())
  );

  if (!playable.length) {
    setDebug("No tracks found (expected samples.people[].joints with role pitcher|hitter).");
    setTracks([]);
    return;
  }

  // Derive throwing/batting hand — keep your previous logic
  const hs: Record<number, "R" | "L" | "?"> = {};
  playable.forEach((t: any, i: number) => {
    const auto = detectHandedness(t.frames || []);
    const metaHand = (t.handedness || t.hand || t.pitchHand || t.bats || "").toString().toUpperCase();
    const meta = metaHand.startsWith("R") ? "R" : metaHand.startsWith("L") ? "L" : "?";
    hs[i] = auto !== "?" ? auto : meta;
  });

  setHands(hs);
  setTracks(playable);
  setTi(0);
  setFi(0);
  setDebug(`Loaded ${playable.length} track(s).`);
}


// ---- Lift names ----
try {
  const players = Array.isArray(obj?.players) ? obj.players :
                  Array.isArray(obj?.details?.players) ? obj.details.players : null;
  if (players) {
    const pit = players.find((p:any)=> (p?.role?.name||"").toLowerCase()==="pitcher") || players.find((p:any)=> ["pitcher"].includes((p?.role?.name||"").toLowerCase()));
    const bat = players.find((p:any)=> (p?.role?.name||"").toLowerCase() in {batter:1,hitter:1}) || players.find((p:any)=> ["batter","hitter"].includes((p?.role?.name||"").toLowerCase()));
    setPitcherName(pit?.name || pit?.fullName || pit?.displayName || null);
    setBatterName(bat?.name || bat?.fullName || bat?.displayName || null);
  }
} catch {}

// ---- Lift pitch & hit metrics (robust over many vendor keys) ----
function firstNum(...vals: any[]) { for(const v of vals){ const n = Number(v); if(Number.isFinite(n)) return n; } return null; }
function mph(ms:number|null){ return (ms==null)?null : (ms*2.23694); }
function ivbInches(m:number|null){ return (m==null)?null : (m*39.3701); }
function hbInches(m:number|null){ return (m==null)?null : (m*39.3701); }
function feet(v:number|null){ return (v==null)?null : (v*3.28084); }

const eventsArr = Array.isArray(obj?.events) ? obj.events :
                  Array.isArray(obj?.details?.events) ? obj.details.events : [];

const pitchEvt = eventsArr.find((e:any)=> String(e?.type||"").toUpperCase()==="PITCH") || {};
const contactEvt = eventsArr.find((e:any)=> String(e?.type||"").toUpperCase()==="CONTACT") || {};

const pitchRoot = obj?.pitch || obj?.details?.pitch || obj?.metrics || obj?.trackman || {};
const movement  = pitchRoot?.movement || pitchEvt?.movement || {};

const vel = firstNum(pitchRoot.releaseSpeed, pitchRoot.releaseVelocity, pitchEvt.releaseSpeed, pitchEvt.releaseVelocity, pitchRoot.pitchVelocity);
const ivb = firstNum(pitchRoot.inducedVerticalBreak, movement.inducedVerticalBreak, pitchEvt.inducedVerticalBreak);
const hb  = firstNum(pitchRoot.horizontalBreak, movement.horizontalBreak, pitchEvt.horizontalBreak, pitchRoot.hBreak);
const ext = firstNum(pitchRoot.extension, pitchRoot.releaseExtension, pitchEvt.extension);

setPitchVelocity(vel!=null ? Number(vel) : null);
setPitchIVB(ivb!=null ? Number(ivb) : null);
setPitchHB(hb!=null ? Number(hb) : null);
setPitchExt(ext!=null ? Number(ext) : null);

const bb = obj?.battedBall || obj?.details?.battedBall || contactEvt || {};
const ev  = firstNum(bb.exitVelocityMph, bb.exitVeloMph, bb.exitVelocity, contactEvt.exitVelocityMph, contactEvt.exitVelocity);
const la  = firstNum(bb.launchAngle, bb.launchAngleDeg, contactEvt.launchAngle, contactEvt.launchAngleDeg);
const bs  = firstNum(bb.batSpeedMph, bb.batSpeed, contactEvt.batSpeedMph);
const spt = firstNum(bb.swingPathTilt, bb.swingPathTiltDeg, contactEvt.swingPathTilt, contactEvt.swingPathTiltDeg);
const ad  = firstNum(bb.attackDirection, bb.attackDirectionDeg, contactEvt.attackDirection, contactEvt.attackDirectionDeg);
const aa  = firstNum(bb.attackAngle, bb.attackAngleDeg, contactEvt.attackAngle, contactEvt.attackAngleDeg);

setEvMph(ev!=null? Number(ev): null);
setLaDeg(la!=null? Number(la): null);
setBatSpeedMph(bs!=null? Number(bs): null);
setSwingPathTiltDeg(spt!=null? Number(spt): null);
setAttackDirDeg(ad!=null? Number(ad): null);
setAttackAngleDeg(aa!=null? Number(aa): null);

// Attach pitchMeta per track so switching tracks keeps constants
if (Array.isArray(parsed)) {
  for (const __t of parsed as any[]) {
    (__t as any).pitchMeta = {
      velocity: vel ?? null,
      ivb: ivb ?? null,
      hb: hb ?? null,
      extension: ext ?? null,
    };
  }
}
// Try to lift pitch metrics if present (do not vary during playback)
        const pitch = obj?.pitch || obj?.details?.pitch || obj?.metrics || obj?.trackman || {};
        const pitchMeta = {
          velocity: pitch.releaseSpeed ?? pitch.releaseVelocity ?? pitch.pitchVelocity ?? null,
          ivb: pitch.inducedVerticalBreak ?? pitch.ivb ?? null,
          hb: pitch.horizontalBreak ?? pitch.hBreak ?? null,
          extension: pitch.extension ?? pitch.releaseExtension ?? null,
        };

        if (Array.isArray(parsed)) {
          for (const __t of parsed as any[]) {
            (__t as any)._handFromJson = "?";
            (__t as any).pitchMeta = pitchMeta;
          }
        }

        // Throwing handedness from players[] (prefer Pitcher)
        let throwHand: "R" | "L" | "?" = "?";
        try {
          const players =
            (Array.isArray((obj as any).players) && (obj as any).players) ||
            (Array.isArray((obj as any).details?.players) && (obj as any).details.players) ||
            null;
          if (players) {
            const pitcher = players.find(
              (p: any) => (p?.role?.name || "").toString().toLowerCase() === "pitcher"
            ) || players[0];
            const throwing = pitcher?.handedness?.throwing as string | undefined;
            if (throwing) {
              const t = throwing.toUpperCase();
              if (t.startsWith("R")) throwHand = "R";
              else if (t.startsWith("L")) throwHand = "L";
            }
          }
        } catch { /* ignore */ }

        for (const t of parsed) {
          (t as any)._handFromJson = (t as any)._handFromJson !== "?" ? (t as any)._handFromJson : throwHand;
          (t as any)._releaseSeconds = extractReleaseSecondsFromJson(obj);
        }

        
        // Attach names and metrics directly to each track for UI
        const {pitcherName, batterName} = extractNames(obj);
        const pitchM = extractPitchMetrics(obj);
        const batM = extractBatMetrics(obj);
        if (Array.isArray(parsed)) {
          for (const t of parsed as any[]) {
            if (!(t as any).meta) (t as any).meta = {};
            (t as any).meta.pitcherName = pitcherName ?? (t as any).meta?.pitcherName;
            (t as any).meta.batterName  = batterName  ?? (t as any).meta?.batterName;
            (t as any).meta.pitch      = pitchM;
            (t as any).meta.battedBall = batM;
          }
        }
        all.push(...parsed);
    
} catch (e: any) {
        setDebug(`Parse error in ${f.name}: ${String(e.message || e)}`);
      }
    }

    // NEW (accept any track that actually has frames)
    const playable = all.filter((t: any) => Array.isArray(t.frames) && t.frames.length > 0);
    if (!playable.length) {
  const summary = all.map((t: any, i: number) => {
    const role = String(t?.role ?? "unknown");
    const n = Array.isArray(t?.frames) ? t.frames.length : 0;
    return `#${i}: role=${role}, frames=${n}, name=${t?.name ?? "?"}`;
  }).join(" | ");
  setDebug(
    `No playable tracks after filter. Received ${all.length} parsed track(s).\n` +
    (summary ? `Tracks: ${summary}` : "Tracks: <none>")
  );
  setTracks([]);
  return;
    }

    const hs: Record<number,"R"|"L"|"?"> = {};
    playable.forEach((t: any, i: number) => {
      const jsonH = (t as any)._handFromJson as "R"|"L"|"?";
      const auto = detectHandedness(t.frames || []);
      const metaHand = (t.handedness || t.hand || t.pitchHand || t.bats || "").toString().toUpperCase();
      const meta = metaHand.startsWith("R") ? "R" : metaHand.startsWith("L") ? "L" : "?";
      hs[i] = jsonH !== "?" ? jsonH : (auto !== "?" ? auto : meta);
    });

    setHands(hs);
    setTracks(playable);
    setTi(0);
    setFi(0);

    // Set constant pitch metrics from first track (or selected later)
    const pm = (playable[0]?.pitchMeta) || {};
    setPitchVelocity(pm.velocity ?? null);
    setPitchIVB(pm.ivb ?? null);
    setPitchHB(pm.hb ?? null);
    setPitchExt(pm.extension ?? null);

    // Force FS/BR to fixed user-requested markers
    setFsIdx(FS_DEFAULT);
    setBrIdx(BR_DEFAULT);

    setDebug(`Loaded ${playable.length} track(s).`);
  }

  const frames = useMemo(() => tracks[ti]?.frames ?? [], [tracks, ti]);
  const rawJ = useMemo(() => frames[fi]?.joints ?? {}, [frames, fi]);

  // When track changes, also update pitch constants & keep FS/BR fixed
  useEffect(() => {
    if (!tracks.length) return;
    const pm = (tracks[ti]?.pitchMeta) || {};
    setPitchVelocity(pm.velocity ?? null);
    setPitchIVB(pm.ivb ?? null);
    setPitchHB(pm.hb ?? null);
    setPitchExt(pm.extension ?? null);
    setFsIdx(FS_DEFAULT);
    setBrIdx(BR_DEFAULT);
  }, [ti, tracks.length]);

  const frameJoints = useMemo(() => {
    const out: Record<string, V3> = {};
    const prev = prevJointMapRef.current;
    for (const [k, p] of Object.entries(rawJ as Record<string, V3>)) {
      const pv = prev[k];
      const cv = new THREE.Vector3(p[0], p[1], p[2]);
      if (pv) {
        pv.multiplyScalar(1 - SMOOTH_ALPHA).addScaledVector(cv, SMOOTH_ALPHA);
        out[k] = [pv.x, pv.y, pv.z];
      } else {
        prev[k] = cv.clone();
        out[k] = [cv.x, cv.y, cv.z];
      }
    }
    prevJointMapRef.current = Object.fromEntries(
      Object.entries(out).map(([k, v]) => [k, new THREE.Vector3(v[0], v[1], v[2])])
    );
    return out;
  }, [rawJ]);

  // ------- per-frame metric (current) -------
  const metrics = useMemo(() => {
    if (!frames.length) return null as any;
    const J = frameJoints as Record<string, V3>;

    const get = (name: string): V3 | undefined => {
      const want = name.replace(/[^a-z]/gi, "").toLowerCase();
      for (const k of Object.keys(J)) if (k.replace(/[^a-z]/gi, "").toLowerCase() === want) return J[k];
      return undefined;
    };

    // Key joints
    const lSh = get("lShoulder") || (J as any)["leftShoulder"];
    const rSh = get("rShoulder") || (J as any)["rightShoulder"];
    const lEl = get("lElbow") || (J as any)["leftElbow"];
    const rEl = get("rElbow") || (J as any)["rightElbow"];
    const lW  = get("lWrist") || (J as any)["leftWrist"];
    const rW  = get("rWrist") || (J as any)["rightWrist"];
    const lHip = get("lHip") || (J as any)["leftHip"];
    const rHip = get("rHip") || (J as any)["rightHip"];
    const lKn  = get("lKnee") || (J as any)["leftKnee"];
    const rKn  = get("rKnee") || (J as any)["rightKnee"];
    const lAn  = get("lAnkle") || (J as any)["leftAnkle"] || (J as any)["lHeel"] || (J as any)["leftHeel"] || (J as any)["lBigToe"] || (J as any)["leftBigToe"];
    const rAn  = get("rAnkle") || (J as any)["rightAnkle"] || (J as any)["rHeel"] || (J as any)["rightHeel"] || (J as any)["rBigToe"] || (J as any)["rightBigToe"];

    const pelvisRaw = get("midHip") || get("pelvis") || (J as any)["hipCenter"] || (J as any)["pelvisCenter"];
    const pelvis: V3 | undefined = pelvisRaw || (lHip && rHip ? ([(lHip[0]+rHip[0])/2, (lHip[1]+rHip[1])/2, (lHip[2]+rHip[2])/2] as V3) : undefined);

    const chestRaw = get("chest") || (J as any)["midShoulder"] || (J as any)["upperChest"] || (J as any)["sternum"] || get("neck") || (J as any)["c7"];
    const chest: V3 | undefined = chestRaw || (lSh && rSh ? ([(lSh[0]+rSh[0])/2, (lSh[1]+rSh[1])/2, (lSh[2]+rSh[2])/2] as V3) : undefined);

    // Height for stride%
    const head = get("head") || get("nose") || (J as any)["topHead"];
    let H = 1.0;
    if (head && (lAn || rAn)) {
      const hv = new THREE.Vector3(...head);
      const av = lAn ? new THREE.Vector3(...lAn) : new THREE.Vector3(...(rAn as V3));
      H = hv.distanceTo(av);
    }
    if (typeof bodyHeight === "number" && bodyHeight > 0) H = bodyHeight;

    // Stride
    let stride: number | undefined;
    if (lAn && rAn) stride = new THREE.Vector3(...lAn).distanceTo(new THREE.Vector3(...rAn));
    const stridePct = stride && H ? (stride / H) * 100 : undefined;

    const homeVec = (flipHome ? HOME_BASE.clone().multiplyScalar(-1) : HOME_BASE.clone());

    // Hip rotation
    const hipVec = (lHip && rHip) ? new THREE.Vector3(rHip[0] - lHip[0], rHip[1] - lHip[1], rHip[2] - lHip[2]) : null;
    const hipRotDeg = hipVec ? yawDeg(homeVec, hipVec) : undefined;

    // Local body basis
    const T = (() => {
      if (pelvis && chest) {
        const t = new THREE.Vector3(chest[0]-pelvis[0], chest[1]-pelvis[1], chest[2]-pelvis[2]);
        if (t.lengthSq() > 1e-10) return t.normalize();
      }
      return new THREE.Vector3(0,1,0);
    })();
    const R = (() => {
      if (lSh && rSh) {
        const r = new THREE.Vector3(rSh[0]-lSh[0], rSh[1]-lSh[1], rSh[2]-lSh[2]);
        if (r.lengthSq() > 1e-10) return r.normalize();
      }
      const tmp = Math.abs(T.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
      return tmp.clone().sub(T.clone().multiplyScalar(tmp.dot(T))).normalize();
    })();
    let F = new THREE.Vector3().crossVectors(R, T);
    if (F.lengthSq() < 1e-9) {
      F = homeVec.clone().sub(T.clone().multiplyScalar(homeVec.dot(T)));
    }
    F.normalize();

    // Trunk rotation
    let trunkRotDeg: number | undefined = undefined;
    if (lSh && rSh) {
      const rShV = new THREE.Vector3(...rSh);
      const lShV = new THREE.Vector3(...lSh);
      const shoulderAxis = rShV.clone().sub(lShV);
      const raw = wrap180(yawDeg(homeVec, shoulderAxis));
      const prev = prevTrunkDegRef.current;
      const unwrapped = prev == null ? raw : unwrapToPrev(raw, prev);
      const smoothed = prev == null ? unwrapped : (0.7 * prev + 0.3 * unwrapped);
      prevTrunkDegRef.current = smoothed;
      trunkRotDeg = wrap180(smoothed);
    }

    const hipMinusTrunk = (hipRotDeg != null && trunkRotDeg != null)
      ? wrap180(hipRotDeg - trunkRotDeg)
      : undefined;

    // Upper arms
    const rUpper = (rSh && rEl) ? new THREE.Vector3(rEl[0] - rSh[0], rEl[1] - rSh[1], rEl[2] - rSh[2]) : null;
    const lUpper = (lSh && lEl) ? new THREE.Vector3(lEl[0] - lSh[0], lEl[1] - lSh[1], lEl[2] - lSh[2]) : null;

    // Shoulder abduction: angle to torso-up axis
    let rAbd: number | undefined, lAbd: number | undefined;
    if (rUpper && rUpper.lengthSq() > 1e-10) rAbd = fold90(THREE.MathUtils.radToDeg(rUpper.clone().normalize().angleTo(T)));
    if (lUpper && lUpper.lengthSq() > 1e-10) lAbd = fold90(THREE.MathUtils.radToDeg(lUpper.clone().normalize().angleTo(T)));

    // Knee flexion
    function kneeFlex(hip?: V3, knee?: V3, ankle?: V3) {
      if (!hip || !knee || !ankle) return undefined;
      const t = new THREE.Vector3(hip[0] - knee[0], hip[1] - knee[1], hip[2] - knee[2]).normalize();
      const s = new THREE.Vector3(ankle[0] - knee[0], ankle[1] - knee[1], ankle[2] - knee[2]).normalize();
      return THREE.MathUtils.radToDeg(t.angleTo(s));
    }
    const rKneeFlex = kneeFlex(rHip, rKn, rAn);
    const lKneeFlex = kneeFlex(lHip, lKn, lAn);

    // Elbow flexion
    function pickJoint(Jmap: Record<string, any>, names: string[]): [number,number,number] | undefined {
      for (const n of names) {
        const v = Jmap[n];
        if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) return v as [number,number,number];
      }
      return undefined;
    }
    function elbowFlex(shoulder?: [number,number,number], elbow?: [number,number,number], wrist?: [number,number,number]) {
      if (!shoulder || !elbow || !wrist) return undefined;
      const u = new THREE.Vector3(shoulder[0]-elbow[0], shoulder[1]-elbow[1], shoulder[2]-elbow[2]).normalize();
      const f = new THREE.Vector3(wrist[0]-elbow[0], wrist[1]-elbow[1], wrist[2]-elbow[2]).normalize();
      return THREE.MathUtils.radToDeg(u.angleTo(f));
    }
    const rElbowFlex = elbowFlex(pickJoint(J, ["rShoulder","rightShoulder"]), pickJoint(J, ["rElbow","rightElbow"]), pickJoint(J, ["rWrist","rightWrist"]));
    const lElbowFlex = elbowFlex(pickJoint(J, ["lShoulder","leftShoulder"]), pickJoint(J, ["lElbow","leftElbow"]), pickJoint(J, ["lWrist","leftWrist"]));

    // Linear displacement trunk vs hips -> home
    const trunkCoG = (() => {
      const pts = [pelvis, chest, rSh, lSh].filter(Boolean) as V3[];
      if (!pts.length) return undefined;
      const vs = pts.map(p => new THREE.Vector3(p[0], p[1], p[2]));
      return vs.reduce((s, v) => s.add(v), new THREE.Vector3()).multiplyScalar(1 / vs.length);
    })();
    const hipsCoG = (lHip && rHip)
      ? new THREE.Vector3((lHip[0] + rHip[0]) / 2, (lHip[1] + rHip[1]) / 2, (lHip[2] + rHip[2]) / 2)
      : undefined;
    let linDispHome: number | undefined = undefined;
    if (trunkCoG && hipsCoG) linDispHome = hipsCoG.x - trunkCoG.x;

    const hand = hands[ti] || "?";

    const dbg = {
      frame: fi,
      time: frames[fi]?.time ?? null,
      basis: {
        T: [Number(T.x.toFixed(3)), Number(T.y.toFixed(3)), Number(T.z.toFixed(3))],
        R: [Number(R.x.toFixed(3)), Number(R.y.toFixed(3)), Number(R.z.toFixed(3))],
        F: [Number(F.x.toFixed(3)), Number(F.y.toFixed(3)), Number(F.z.toFixed(3))],
      },
      hand,
    };
    return {
      trunkRotDeg,
      hipRotDeg,
      hipMinusTrunk,
      rAbd,
      lAbd,
      rKneeFlex,
      lKneeFlex,
      rElbowFlex,
      lElbowFlex,
      stride,
      stridePct,
      linDispHome,
      dbg
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, frameJoints, bodyHeight, fi, flipHome, flipHAbd, ti, hands]);

  // ------- full-pitch biomech series (for graphs) -------
  const biomech = useMemo(() => {
    const n = frames.length;
    const series = {
      trunkRot: new Array<number>(n).fill(NaN),
      hipRot: new Array<number>(n).fill(NaN),
      hipMinusTrunk: new Array<number>(n).fill(NaN),
      rAbd: new Array<number>(n).fill(NaN),
      lAbd: new Array<number>(n).fill(NaN),
      rKnee: new Array<number>(n).fill(NaN),
      lKnee: new Array<number>(n).fill(NaN),
      rElbow: new Array<number>(n).fill(NaN),
      lElbow: new Array<number>(n).fill(NaN),
      stride: new Array<number>(n).fill(NaN),
      stridePct: new Array<number>(n).fill(NaN),
      linDispHome: new Array<number>(n).fill(NaN),
    };
    if (!n) return series;

    const hand = hands[ti] || "?";
    const homeVec = (flipHome ? HOME_BASE.clone().multiplyScalar(-1) : HOME_BASE.clone());

    // Helpers reused inside the loop
    const getFrom = (J: Record<string,V3>, name: string): V3 | undefined => {
      const want = name.replace(/[^a-z]/gi, "").toLowerCase();
      for (const k of Object.keys(J)) if (k.replace(/[^a-z]/gi, "").toLowerCase() === want) return J[k];
      return undefined;
    };
    const kneeFlex = (hip?: V3, knee?: V3, ankle?: V3) => {
      if (!hip || !knee || !ankle) return undefined as any;
      const t = new THREE.Vector3(hip[0] - knee[0], hip[1] - knee[1], hip[2] - knee[2]).normalize();
      const s = new THREE.Vector3(ankle[0] - knee[0], ankle[1] - knee[1], ankle[2] - knee[2]).normalize();
      return THREE.MathUtils.radToDeg(t.angleTo(s));
    };
    const elbowFlex = (shoulder?: V3, elbow?: V3, wrist?: V3) => {
      if (!shoulder || !elbow || !wrist) return undefined as any;
      const u = new THREE.Vector3(shoulder[0]-elbow[0], shoulder[1]-elbow[1], shoulder[2]-elbow[2]).normalize();
      const f = new THREE.Vector3(wrist[0]-elbow[0], wrist[1]-elbow[1], wrist[2]-elbow[2]).normalize();
      return THREE.MathUtils.radToDeg(u.angleTo(f));
    };

    let prevTrunk: number | null = null;
    for (let i = 0; i < n; i++) {
      const Jmap = frames[i]?.joints as Record<string,V3> || {};
      // key joints
      const lSh = getFrom(Jmap, "lShoulder") || (Jmap as any)["leftShoulder"];
      const rSh = getFrom(Jmap, "rShoulder") || (Jmap as any)["rightShoulder"];
      const lEl = getFrom(Jmap, "lElbow") || (Jmap as any)["leftElbow"];
      const rEl = getFrom(Jmap, "rElbow") || (Jmap as any)["rightElbow"];
      const lW  = getFrom(Jmap, "lWrist") || (Jmap as any)["leftWrist"];
      const rW  = getFrom(Jmap, "rWrist") || (Jmap as any)["rightWrist"];
      const lHip = getFrom(Jmap, "lHip") || (Jmap as any)["leftHip"];
      const rHip = getFrom(Jmap, "rHip") || (Jmap as any)["rightHip"];
      const lKn  = getFrom(Jmap, "lKnee") || (Jmap as any)["leftKnee"];
      const rKn  = getFrom(Jmap, "rKnee") || (Jmap as any)["rightKnee"];
      const lAn  = getFrom(Jmap, "lAnkle") || (Jmap as any)["leftAnkle"] || (Jmap as any)["lHeel"] || (Jmap as any)["leftHeel"] || (Jmap as any)["lBigToe"] || (Jmap as any)["leftBigToe"];
      const rAn  = getFrom(Jmap, "rAnkle") || (Jmap as any)["rightAnkle"] || (Jmap as any)["rHeel"] || (Jmap as any)["rightHeel"] || (Jmap as any)["rBigToe"] || (Jmap as any)["rightBigToe"];
      const pelvisRaw = getFrom(Jmap, "midHip") || getFrom(Jmap,"pelvis") || (Jmap as any)["hipCenter"] || (Jmap as any)["pelvisCenter"];
      const pelvis: V3 | undefined = pelvisRaw || (lHip && rHip ? ([(lHip[0]+rHip[0])/2, (lHip[1]+rHip[1])/2, (lHip[2]+rHip[2])/2] as V3) : undefined);
      const chestRaw = getFrom(Jmap,"chest") || (Jmap as any)["midShoulder"] || (Jmap as any)["upperChest"] || (Jmap as any)["sternum"] || getFrom(Jmap,"neck") || (Jmap as any)["c7"];
      const chest: V3 | undefined = chestRaw || (lSh && rSh ? ([(lSh[0]+rSh[0])/2, (lSh[1]+rSh[1])/2, (lSh[2]+rSh[2])/2] as V3) : undefined);

      // height
      const head = getFrom(Jmap,"head") || getFrom(Jmap,"nose") || (Jmap as any)["topHead"];
      let H = 1.0;
      if (head && (lAn || rAn)) {
        const hv = new THREE.Vector3(...head);
        const av = lAn ? new THREE.Vector3(...lAn) : new THREE.Vector3(...(rAn as V3));
        H = hv.distanceTo(av);
      }
      if (typeof bodyHeight === "number" && bodyHeight > 0) H = bodyHeight;

      // stride
      let stride: number | undefined;
      if (lAn && rAn) stride = new THREE.Vector3(...lAn).distanceTo(new THREE.Vector3(...rAn));
      const stridePct = stride && H ? (stride / H) * 100 : undefined;

      // hip rot
      const hipVec = (lHip && rHip) ? new THREE.Vector3(rHip[0] - lHip[0], rHip[1] - lHip[1], rHip[2] - lHip[2]) : null;
      const hipRotDeg = hipVec ? yawDeg(homeVec, hipVec) : undefined;

      // body basis
      const T = (() => {
        if (pelvis && chest) {
          const t = new THREE.Vector3(chest[0]-pelvis[0], chest[1]-pelvis[1], chest[2]-pelvis[2]);
          if (t.lengthSq() > 1e-10) return t.normalize();
        }
        return new THREE.Vector3(0,1,0);
      })();
      const R = (() => {
        if (lSh && rSh) {
          const r = new THREE.Vector3(rSh[0]-lSh[0], rSh[1]-lSh[1], rSh[2]-lSh[2]);
          if (r.lengthSq() > 1e-10) return r.normalize();
        }
        const tmp = Math.abs(T.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
        return tmp.clone().sub(T.clone().multiplyScalar(tmp.dot(T))).normalize();
      })();
      let F = new THREE.Vector3().crossVectors(R, T);
      if (F.lengthSq() < 1e-9) F = homeVec.clone().sub(T.clone().multiplyScalar(homeVec.dot(T)));
      F.normalize();

      // trunk rot unwrapped lightly
      let trunkRotDeg: number | undefined = undefined;
      if (lSh && rSh) {
        const rShV = new THREE.Vector3(...rSh);
        const lShV = new THREE.Vector3(...lSh);
        const shoulderAxis = rShV.clone().sub(lShV);
        const raw = wrap180(yawDeg(homeVec, shoulderAxis));
        if (prevTrunk == null) prevTrunk = raw;
        const unwrapped = unwrapToPrev(raw, prevTrunk);
        trunkRotDeg = unwrapped;
        prevTrunk = unwrapped;
      }

      const hipMinus = (hipRotDeg != null && trunkRotDeg != null) ? wrap180(hipRotDeg - trunkRotDeg) : undefined;

      // abduction
      const rUpper = (rSh && rEl) ? new THREE.Vector3(rEl[0] - rSh[0], rEl[1] - rSh[1], rEl[2] - rSh[2]) : null;
      const lUpper = (lSh && lEl) ? new THREE.Vector3(lEl[0] - lSh[0], lEl[1] - lSh[1], lEl[2] - lSh[2]) : null;
      let rAbd = (rUpper && rUpper.lengthSq()>1e-10) ? fold90(THREE.MathUtils.radToDeg(rUpper.clone().normalize().angleTo(T))) : undefined;
      let lAbd = (lUpper && lUpper.lengthSq()>1e-10) ? fold90(THREE.MathUtils.radToDeg(lUpper.clone().normalize().angleTo(T))) : undefined;

      const rKneeF = kneeFlex(rHip, rKn, rAn);
      const lKneeF = kneeFlex(lHip, lKn, lAn);
      const rElbF = elbowFlex(rSh as any, rEl as any, rW as any);
      const lElbF = elbowFlex(lSh as any, lEl as any, lW as any);

      // lin disp
      const trunkCoG = (() => {
        const pts = [pelvis, chest, rSh, lSh].filter(Boolean) as V3[];
        if (!pts.length) return undefined;
        const vs = pts.map(p => new THREE.Vector3(p[0], p[1], p[2]));
        return vs.reduce((s, v) => s.add(v), new THREE.Vector3()).multiplyScalar(1 / vs.length);
      })();
      const hipsCoG = (lHip && rHip)
        ? new THREE.Vector3((lHip[0] + rHip[0]) / 2, (lHip[1] + rHip[1]) / 2, (lHip[2] + rHip[2]) / 2)
        : undefined;
      let linDispHome = (trunkCoG && hipsCoG) ? (hipsCoG.x - trunkCoG.x) : undefined;

      // write
      series.trunkRot[i] = Number.isFinite(trunkRotDeg as any) ? (trunkRotDeg as number) : NaN;
      series.hipRot[i] = Number.isFinite(hipRotDeg as any) ? (hipRotDeg as number) : NaN;
      series.hipMinusTrunk[i] = Number.isFinite(hipMinus as any) ? (hipMinus as number) : NaN;
      series.rAbd[i] = Number.isFinite(rAbd as any) ? (rAbd as number) : NaN;
      series.lAbd[i] = Number.isFinite(lAbd as any) ? (lAbd as number) : NaN;
      series.rKnee[i] = Number.isFinite(rKneeF as any) ? (rKneeF as number) : NaN;
      series.lKnee[i] = Number.isFinite(lKneeF as any) ? (lKneeF as number) : NaN;
      series.rElbow[i] = Number.isFinite(rElbF as any) ? (rElbF as number) : NaN;
      series.lElbow[i] = Number.isFinite(lElbF as any) ? (lElbF as number) : NaN;
      series.stride[i] = Number.isFinite(stride as any) ? (stride as number) : NaN;
      series.stridePct[i] = Number.isFinite(stridePct as any) ? (stridePct as number) : NaN;
      series.linDispHome[i] = Number.isFinite(linDispHome as any) ? (linDispHome as number) : NaN;
    }
    return series;
  }, [frames, ti, hands, flipHome, flipHAbd, bodyHeight]);

  // Draw current frame
  useEffect(() => {
    const scene = sceneRef.current;
    purgeStray(scene);
    jointsGroup.current.clear();
    bonesGroup.current.clear();
    if (!frames.length) return;

    const J = frameJoints as Record<string, V3>;
    const current: (V3 | undefined)[] = new Array(16).fill(undefined);
    const aliases: Record<number, string[]> = {
      0: ["head", "nose", "topHead"],
      1: ["neck", "c7", "neckBase"],
      2: ["chest", "midShoulder", "upperChest", "sternum"],
      3: ["midHip", "pelvis", "hipCenter", "pelvisCenter"],
      4: ["lShoulder", "leftShoulder"],
      5: ["lElbow", "leftElbow"],
      6: ["lWrist", "leftWrist"],
      7: ["rShoulder", "rightShoulder"],
      8: ["rElbow", "rightElbow"],
      9: ["rWrist", "rightWrist"],
      10: ["lHip", "leftHip"],
      11: ["lKnee", "leftKnee"],
      12: ["lAnkle", "leftAnkle", "lHeel", "leftHeel", "lBigToe", "leftBigToe"],
      13: ["rHip", "rightHip"],
      14: ["rKnee", "rightKnee"],
      15: ["rAnkle", "rightAnkle", "rHeel", "rightHeel", "rBigToe", "rightBigToe"],
    };
    for (const [idxStr, names] of Object.entries(aliases)) {
      const idx = Number(idxStr);
      for (const nm of names) {
        if (!current[idx] && J[nm]) { current[idx] = J[nm]; break; }
      }
    }
    if (!current[2] && current[4] && current[7]) {
      const L = current[4]!, R = current[7]!;
      current[2] = [(L[0]+R[0])/2, (L[1]+R[1])/2, (L[2]+R[2])/2];
    }
    if (!current[3] && current[10] && current[13]) {
      const L = current[10]!, R = current[13]!;
      current[3] = [(L[0]+R[0])/2, (L[1]+R[1])/2, (L[2]+R[2])/2];
    }

    const sphere = new THREE.SphereGeometry(0.03, 16, 16);
    const sMat = new THREE.MeshStandardMaterial({ color: 0x7dd3fc, metalness: 0.1, roughness: 0.8 });
    const cyl = new THREE.CylinderGeometry(0.015, 0.015, 1, 12);
    const bMat = new THREE.MeshStandardMaterial({ color: 0x93c5fd, metalness: 0.1, roughness: 0.8 });

    current.forEach((p) => {
      if (!p) return;
      const m = new THREE.Mesh(sphere, sMat);
      m.position.set(p[0], p[1], p[2]);
      jointsGroup.current.add(m);
    });
    for (const [a, b] of BONES) {
      const pa = current[a], pb = current[b];
      if (!pa || !pb) continue;
      const va = new THREE.Vector3(pa[0], pa[1], pa[2]);
      const vb = new THREE.Vector3(pb[0], pb[1], pb[2]);
      const mid = va.clone().add(vb).multiplyScalar(0.5);
      const dir = vb.clone().sub(va);
      const len = dir.length();
      if (len < 1e-6) continue;
      const bone = new THREE.Mesh(cyl, bMat);
      bone.scale.set(1, len, 1);
      bone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      bone.position.copy(mid);
      bonesGroup.current.add(bone);
    }

    // Keep orientation locked (smooth slerp to track-locked quaternion)
    const root = skeletonRootRef.current;
    const targetQ = (lockedQuatRef.current ?? new THREE.Quaternion()).normalize();
    if (prevQuatRef.current && targetQ.dot(prevQuatRef.current) < 0) /* Quaternion sign flip */
      (() => { const __q = targetQ; __q.x*=-1; __q.y*=-1; __q.z*=-1; __q.w*=-1; })();
    const qNow = root.quaternion.clone();
    qNow.slerp(targetQ, 0.6);
    root.setRotationFromQuaternion(qNow);
    prevQuatRef.current = qNow.clone();
  }, [frames, frameJoints, fi]);

  // Lock orientation & fit camera on track switch
  useEffect(() => {
    lockedQuatRef.current = null;
    prevQuatRef.current = null;
    prevJointMapRef.current = {};
    prevTrunkDegRef.current = null;

    if (!frames.length) return;
    const idx = Math.min(frames.length - 1, Math.max(0, Math.floor(frames.length * 0.1)));
    const J = frames[idx].joints as Record<string, V3>;

    const headP = J["head"] || J["nose"] || (J as any)["topHead"];
    const pelvisP = J["midHip"] || J["pelvis"] || (J as any)["hipCenter"] || (J as any)["pelvisCenter"];
    const chestP = J["chest"] || (J as any)["midShoulder"] || (J as any)["upperChest"] || (J as any)["sternum"] || J["neck"];
    const hipL = J["lHip"] || (J as any)["leftHip"];
    const hipR = J["rHip"] || (J as any)["rightHip"];

    let q = new THREE.Quaternion();
    if (headP && pelvisP) {
      const head = new THREE.Vector3(...headP);
      const pelvis = new THREE.Vector3(...pelvisP);
      const upNow = head.clone().sub(pelvis).normalize();
      const q1 = new THREE.Quaternion().setFromUnitVectors(upNow, new THREE.Vector3(0, 1, 0));

      let fwdProbe = new THREE.Vector3(1, 0, 0);
      if (hipL && hipR) {
        const v = new THREE.Vector3(hipR[0] - hipL[0], hipR[1] - hipL[1], hipR[2] - hipL[2]);
        fwdProbe = upNow.clone().cross(v).normalize();
      } else if (chestP) {
        const chest = new THREE.Vector3(...chestP);
        fwdProbe = chest.clone().sub(pelvis).normalize();
      }
      const homeVec = (flipHome ? HOME_BASE.clone().multiplyScalar(-1) : HOME_BASE.clone());
      const fwdAfter = fwdProbe.clone().applyQuaternion(q1).setZ(0).normalize();
      const ang = Math.atan2(fwdAfter.x * homeVec.y - fwdAfter.y * homeVec.x, fwdAfter.dot(homeVec));
      const q2 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ang);
      q = q2.multiply(q1);
    } else {
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI * 0.5);
    }

    // Upright sanity flip if needed
    try {
      const headP2 = headP;
      const lAn   = J["lAnkle"] || (J as any)["leftAnkle"] || (J as any)["lHeel"] || (J as any)["leftHeel"] || (J as any)["lBigToe"] || (J as any)["leftBigToe"];
      const rAn   = J["rAnkle"] || (J as any)["rightAnkle"] || (J as any)["rHeel"] || (J as any)["rightHeel"] || (J as any)["rBigToe"] || (J as any)["rightBigToe"];
      if (headP2 && (lAn || rAn)) {
        const toLocal = (p: any) => new THREE.Vector3(p[0], p[1], p[2]).applyQuaternion(q);
        const headY = toLocal(headP2).y;
        const ys: number[] = [];
        if (lAn) ys.push(toLocal(lAn).y);
        if (rAn) ys.push(toLocal(rAn).y);
        const anklesY = ys.reduce((a,b)=>a+b,0)/ys.length;
        if (headY < anklesY) {
          const flipX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), Math.PI);
          q = flipX.multiply(q);
        }
      }
    } catch {}

    lockedQuatRef.current = q.normalize();
    prevQuatRef.current = q.clone();

    // Fit camera
    setTimeout(() => {
      const cam = cameraRef.current!;
      const box = new THREE.Box3().setFromObject(skeletonRootRef.current);
      const size = new THREE.Vector3(); box.getSize(size);
      const center = new THREE.Vector3(); box.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z, 1);
      const desired = new THREE.Vector3(center.x + maxDim * 1.8, center.y + maxDim * 0.6, center.z + maxDim * 1.8);
      cam.position.copy(desired);
      controlsRef.current!.target.copy(center);
      cam.lookAt(controlsRef.current!.target);
    }, 0);
  }, [ti, frames.length, flipHome]);

  // Smooth jump (ease over ~320ms)
  function smoothJump(target: number, ms = 320) {
    const start = performance.now();
    const from = fi ?? 0;
    function easeInOutQuad(t: number) { return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t; }
    function step(now: number) {
      const t = Math.min(1, (now - start) / ms);
      const e = easeInOutQuad(t);
      const next = Math.round(from + (target - from) * e);
      if (next !== fi) setFi(next);
      if (t < 1) requestAnimationFrame(step);
      else setFi(target);
    }
    requestAnimationFrame(step);
  }

  const goFootStrike = () => { if (fsIdx != null) smoothJump(fsIdx); };
  const goRelease    = () => { if (brIdx != null) smoothJump(brIdx); };

  return (
    <div className="layout" style={{ display: "grid", gridTemplateColumns: "480px 1fr", minHeight: "calc(100vh - 50px)" }}>
      <aside style={{ width: 480, borderRight: "1px solid #1e293b", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="file" multiple accept=".json,application/json" onChange={(e) => onFiles(e.target.files)} />
        <div style={{ fontSize: 12, opacity: 0.85 }}>Tracks loaded: {tracks.length}</div>

        <label style={{ fontSize: 12, opacity: 0.85 }}>Select Track</label>
        <select
          value={ti}
          onChange={(e) => { setTi(+e.target.value); setFi(0); }}
          style={{ background: "#0f172a", color: "#e2e8f0", border: "1px solid #1e293b", borderRadius: 8, padding: "6px 8px" }}
        >
          {tracks.map((t: any, i: number) => (
            <option key={i} value={i}>[{t.role}] {t.name ?? t.personId ?? t.trackId ?? `Track ${i + 1}`}</option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 8, fontSize: 12, opacity: 0.85, alignItems:"center", flexWrap:"wrap" }}>
          <div>Frames: {frames.length}</div>
          <div>Hand: <b>{hands[ti] || "?"}</b></div>
          <div>FS: <b>{fsIdx ?? "-"}</b></div>
          <div>BR: <b>{brIdx ?? "-"}</b></div>
        </div>

        <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={fi} onChange={(e) => setFi(+e.target.value)} />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button disabled={fsIdx == null} onClick={goFootStrike}
            style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #1e293b", background: fsIdx==null?"#182034":"#0f172a", color: "#e2e8f0" }}>
            Go Foot-Strike
          </button>
          <button disabled={brIdx == null} onClick={goRelease}
            style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #1e293b", background: brIdx==null?"#182034":"#0f172a", color: "#e2e8f0" }}>
            Go Release
          </button>
          <button
            title='Press "D" too'
            onClick={() => {
              console.log("DEBUG joint map (smoothed):", frameJoints);
              if (metrics) console.log("DEBUG metrics:", metrics);
              setDebug("Debug dumped to console.");
            }}
            style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #1e293b", background: "#0f172a", color: "#e2e8f0" }}
          >
            Dump Debug
          </button>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 6, flexWrap:"wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)} />
            Live Debug Overlay
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={flipHome} onChange={(e) => setFlipHome(e.target.checked)} />
            Flip HOME
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={flipHAbd} onChange={(e) => setFlipHAbd(e.target.checked)} />
            Flip H-Abd Sign
          </label>
        </div>

        {/* --- PITCH METRICS (constants from JSON) --- */}
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
          <div><b>Velocity</b></div><div>{pitchVelocity ?? "-"}</div>
          <div><b>Induced Vertical Break</b></div><div>{pitchIVB ?? "-"}</div>
          <div><b>Horizontal Break</b></div><div>{pitchHB ?? "-"}</div>
          <div><b>Extension</b></div><div>{pitchExt ?? "-"}</div>
        </div>

        <hr style={{ borderColor: "#1e293b" }} />

        {/* --- BIOMECH GRAPHS --- */}
        <div style={{display:"grid", gridTemplateColumns:"1fr", gap:10}}>
          <Sparkline series={biomech.trunkRot} idx={fi} label="Trunk Rot (°)" />
          <Sparkline series={biomech.hipRot} idx={fi} label="Hip Rot (°)" />
          <Sparkline series={biomech.hipMinusTrunk} idx={fi} label="Hip − Trunk (°)" />
          <Sparkline series={biomech.rAbd} idx={fi} label="R Abd (°)" />
          <Sparkline series={biomech.lAbd} idx={fi} label="L Abd (°)" />
          <Sparkline series={biomech.rKnee} idx={fi} label="R Knee Flex (°)" />
          <Sparkline series={biomech.lKnee} idx={fi} label="L Knee Flex (°)" />
          <Sparkline series={biomech.rElbow} idx={fi} label="R Elbow Flex (°)" />
          <Sparkline series={biomech.lElbow} idx={fi} label="L Elbow Flex (°)" />
          <Sparkline series={biomech.stride} idx={fi} label="Stride (m)" fmt={(v)=>v.toFixed(3)} />
          <Sparkline series={biomech.stridePct} idx={fi} label="Stride %H" fmt={(v)=>v.toFixed(1)} unit="%" />
          <Sparkline series={biomech.linDispHome} idx={fi} label="Lin Disp → Home (m)" fmt={(v)=>v.toFixed(3)} />
        </div>

        <div style={{ fontSize: 12, opacity: 0.85 }}>Debug: {debug}</div>
      </aside>

      <main ref={canvasHost} style={{ position: "relative" }}>
        {showOverlay && metrics && (
          <div style={{
            position: "absolute", top: 10, left: 10, background: "rgba(2,6,23,0.7)",
            border: "1px solid #1e293b", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#e2e8f0",
            whiteSpace: "pre", lineHeight: 1.4
          }}>
{`Frame: ${metrics.dbg.frame}   t=${frames[metrics.dbg.frame]?.time?.toFixed?.(6) ?? "?"}
Hand: ${metrics.dbg.hand}
FS: ${fsIdx ?? "-"}
BR: ${brIdx ?? "-"}
T: [${(metrics as any).dbg.basis.T.join(", ")}]
R: [${(metrics as any).dbg.basis.R.join(", ")}]
F: [${(metrics as any).dbg.basis.F.join(", ")}]

Trunk Rot: ${metrics.trunkRotDeg != null ? metrics.trunkRotDeg.toFixed(1) : "-"}
Hip Rot:   ${metrics.hipRotDeg != null ? metrics.hipRotDeg.toFixed(1) : "-"}
Hip-Trunk: ${metrics.hipMinusTrunk != null ? metrics.hipMinusTrunk.toFixed(1) : "-"}

R Abd:   ${metrics.rAbd != null ? metrics.rAbd.toFixed(1) : "-"}
L Abd:   ${metrics.lAbd != null ? metrics.lAbd.toFixed(1) : "-"}

R Knee: ${metrics.rKneeFlex != null ? metrics.rKneeFlex.toFixed(1) : "-"}
L Knee: ${metrics.lKneeFlex != null ? metrics.lKneeFlex.toFixed(1) : "-"}

R Elbow: ${metrics.rElbowFlex != null ? metrics.rElbowFlex.toFixed(1) : "-"}
L Elbow: ${metrics.lElbowFlex != null ? metrics.lElbowFlex.toFixed(1) : "-"}

Stride: ${metrics.stride != null ? metrics.stride.toFixed(3) : "-"}
%Height: ${metrics.stridePct != null ? metrics.stridePct.toFixed(1) + "%" : "-"}
Lin→Home: ${metrics.linDispHome != null ? metrics.linDispHome.toFixed(3) : "-"}
`}
          </div>
        )}
        {/* Visual markers for Foot‑Strike / Release along bottom-left */}
        <div style={{position:"absolute", bottom:10, left:10, display:"flex", gap:8}}>
          <div style={{padding:"2px 6px", borderRadius:6, border:"1px solid #1e293b", background:"#0f172a", color:"#e2e8f0"}}>
            FS: {fsIdx ?? "-"}
          </div>
          <div style={{padding:"2px 6px", borderRadius:6, border:"1px solid #1e293b", background:"#0f172a", color:"#e2e8f0"}}>
            BR: {brIdx ?? "-"}
          </div>
        </div>
      </main>
    </div>
  );
}