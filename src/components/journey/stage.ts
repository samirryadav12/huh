import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { buildNesto, createNestoAnimator, haloTexture } from "./nesto";
import { createPanelArt } from "./panelArt";

/* The project journey's 3D world: one continuous workshop with a station per chapter, laid out along a
   guided route. Nesto flies from station to station; scroll position (via JourneyState) drives where he
   is, where the camera looks and what each station shows. Everything a station shows comes from the
   project's own data (parts categories, wire colours, pin count, steps, code, store stock). */

export type StationKind = "intro" | "overview" | "bom" | "wiring" | "pinout" | "steps" | "view3d" | "code" | "stores" | "faq";

/* what a floating panel shows before it is opened (panel journey only) */
export interface PanelPreview {
  eyebrow: string;
  title: string;
  stats: string[];
  thumb?: string;      // image shown on the panel
  lines?: string[];    // text preview, used when there is no image (or it fails to load)
  code?: boolean;      // render the lines as source code
}

export interface StageData {
  kinds: StationKind[];
  panels?: (PanelPreview | null)[]; // one per kind: present = panel journey, a floating panel at that station
  modelUrl?: string;
  localModel?: "line-follower" | "drone-explorer" | "robotic-arm" | "robosoccer"; // a detailed model built in code (the workshop's), used instead of modelUrl
  bomCategories: string[];
  wireColors: string[];
  pinCount: number;
  stepCount: number;
  codeLines: string[];
  storeParts: number[];
  topStore: number;
}

export interface JourneyState {
  f: number;            // continuous chapter position: 2.5 = halfway from chapter 2 to chapter 3
  local: number[];      // 0…1 reading progress through each chapter's content
  side: number[];       // where the scene sits beside each chapter's text: 1 right, -1 left, 0 centred
  hotPin: number;       // pin-table row under the pointer, -1 when none
  completed: boolean[]; // build steps the visitor has checked off
  viewerBusy: boolean;  // the interactive 3D viewer is on screen: keep the GPU free for it
  visible: boolean;     // the journey is on screen at all
  pointer: { x: number; y: number; at: number };
}

export interface StageOptions {
  reduced: boolean;
  onDark: (darkness: number) => void;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => { const x = clamp((v - a) / (b - a)); return x * x * (3 - 2 * x); };
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerpAngle = (a: number, b: number, k: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

/* how the camera frames each kind of station (azimuth, elevation, distance) and where Nesto waits
   (to the right of the prop as seen from the camera, so his pointing arm reaches it) */
const LF_TURN = -0.55; // the Line Follower model faces +z; turn it so the pedestal shows its front three-quarter
const SHOT: Record<StationKind, { az: number; el: number; dist: number; robot: [number, number, number]; up: number; dark: number }> = {
  // the panel journey's opening: a close-up of Nesto alone, introducing the project
  intro: { az: 0.22, el: 0.08, dist: 3.3, robot: [0, 1.0, 0], up: 1.05, dark: 0 },
  overview: { az: 0.38, el: 0.2, dist: 8.3, robot: [1.6, 0.95, 0.2], up: 0.6, dark: 0 },
  bom: { az: -0.42, el: 0.5, dist: 8.6, robot: [2.0, 1.15, 0.1], up: 0.45, dark: 0 },
  wiring: { az: 0.05, el: 0.12, dist: 9.0, robot: [2.25, 1.0, 0.7], up: 1.0, dark: 1 },
  pinout: { az: 0.3, el: 0.6, dist: 8.6, robot: [1.75, 1.05, 0.3], up: 0.5, dark: 1 },
  steps: { az: -0.5, el: 0.3, dist: 8.0, robot: [1.75, 1.1, 0.2], up: 0.75, dark: 0 },
  view3d: { az: 0.55, el: 0.14, dist: 9.0, robot: [2.15, 1.0, 0.3], up: 1.0, dark: 0 },
  code: { az: -0.05, el: 0.1, dist: 9.0, robot: [2.2, 1.0, 0.8], up: 1.0, dark: 1 },
  stores: { az: -0.6, el: 0.22, dist: 10.6, robot: [2.25, 1.0, 0.4], up: 0.95, dark: 0 },
  faq: { az: 0.42, el: 0.26, dist: 7.4, robot: [0.0, 0.73, 0.0], up: 0.75, dark: 0 },
};

const WIRE_HEX: Record<string, number> = {
  red: 0xd8432f, black: 0x1d1f22, white: 0xf2f0ea, yellow: 0xf2c230, green: 0x2f9e5b, blue: 0x2f6fd6,
  orange: 0xf0862e, purple: 0x8a55c9, brown: 0x7a4b2a, grey: 0x8b9096, gray: 0x8b9096, pink: 0xe8789c,
};
const wireHex = (name: string) => {
  const key = name.toLowerCase().match(/[a-z]+/g)?.find((w) => w in WIRE_HEX);
  return key ? WIRE_HEX[key] : 0xc8592e;
};

export function createStage(canvas: HTMLCanvasElement, data: StageData, state: JourneyState, opts: StageOptions) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  const mobile = Math.min(window.innerWidth, window.innerHeight) < 700;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !mobile;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = roomEnv;
  const LIGHT_BG = new THREE.Color(0xf6f1e9), DARK_BG = new THREE.Color(0x161b21);
  scene.background = LIGHT_BG.clone();
  scene.fog = new THREE.Fog(LIGHT_BG.clone(), 16, 46);

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xd9cdbd, 1.1);
  const key = new THREE.DirectionalLight(0xfff2e6, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 30 });
  key.shadow.bias = -0.0004;
  const rim = new THREE.PointLight(0x7fb2ff, 0, 18);
  scene.add(hemi, key, key.target, rim);

  const haloTex = haloTexture();
  const disposables: { dispose: () => void }[] = [roomEnv, pmrem, haloTex];
  const track = <T extends { dispose: () => void }>(x: T) => { disposables.push(x); return x; };

  const M = {
    floor: track(new THREE.MeshStandardMaterial({ color: 0xefe8dd, roughness: 0.95 })),
    plastic: track(new THREE.MeshStandardMaterial({ color: 0xf6f1ea, roughness: 0.45 })),
    wood: track(new THREE.MeshStandardMaterial({ color: 0xd9c3a5, roughness: 0.7 })),
    dark: track(new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.55, metalness: 0.2 })),
    accent: track(new THREE.MeshStandardMaterial({ color: 0xc8592e, roughness: 0.4 })),
    trim: track(new THREE.MeshStandardMaterial({ color: 0xdf9e7e, roughness: 0.5 })),
    pcb: track(new THREE.MeshStandardMaterial({ color: 0x1f5e46, roughness: 0.6 })),
    chip: track(new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.4 })),
    metal: track(new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.8 })),
    gold: track(new THREE.MeshStandardMaterial({ color: 0xd9b25a, roughness: 0.3, metalness: 0.9 })),
    wheel: track(new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 })),
    tire: track(new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.8 })),
    cell: track(new THREE.MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.45 })),
    acrylic: track(new THREE.MeshPhysicalMaterial({ color: 0xe9f1f5, roughness: 0.1, transmission: 0, transparent: true, opacity: 0.55 })),
    driver: track(new THREE.MeshStandardMaterial({ color: 0xb23a2a, roughness: 0.55 })),
    screen: track(new THREE.MeshStandardMaterial({ color: 0x0f1318, roughness: 0.25, metalness: 0.3 })),
    box: track(new THREE.MeshStandardMaterial({ color: 0xc9a27a, roughness: 0.85 })),
    glow: track(new THREE.MeshStandardMaterial({ color: 0x331408, emissive: 0xff8a3d, emissiveIntensity: 1.6, roughness: 0.4 })),
    landing: track(new THREE.MeshStandardMaterial({ color: 0xe6d3c2, emissive: 0xff8a3d, emissiveIntensity: 0, roughness: 0.4 })),
    shadow: track(new THREE.MeshBasicMaterial({ map: haloTex, color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })),
    halo: track(new THREE.SpriteMaterial({ map: haloTex, color: 0xff8a3d, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })),
  };
  const geoCache = new Map<string, THREE.BufferGeometry>();
  const geo = (k: string, make: () => THREE.BufferGeometry) => {
    let g = geoCache.get(k);
    if (!g) { g = make(); geoCache.set(k, g); }
    return g;
  };
  const rbox = (w: number, h: number, d: number, r = 0.03) => geo(`rb${w},${h},${d},${r}`, () => new RoundedBoxGeometry(w, h, d, 3, r));
  const cyl = (rt: number, rb: number, h: number, s = 32) => geo(`cy${rt},${rb},${h},${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s));
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.castShadow = o.receiveShadow = true;
    return o;
  };

  /* ---------- the ground and the guided route ---------- */
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(400, 400)), M.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const N = data.kinds.length;
  const stationPos = data.kinds.map((_, k) => new THREE.Vector3(Math.sin(k * 1.15) * 7.5, 0, -k * 10));
  const route = new THREE.CatmullRomCurve3(stationPos.map((p) => p.clone().setY(0.012)), false, "centripetal");
  const dashGeo = track(new THREE.BoxGeometry(0.34, 0.01, 0.09));
  const dashCount = Math.max(1, Math.round(route.getLength() / 0.62));
  const dashes = new THREE.InstancedMesh(dashGeo, M.accent, dashCount);
  dashes.receiveShadow = true;
  {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < dashCount; i++) {
      const u = (i + 0.5) / dashCount;
      const p = route.getPointAt(u), tng = route.getTangentAt(u);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(tng.x, tng.z) + Math.PI / 2);
      dashes.setMatrixAt(i, m4.compose(p, q, s));
    }
  }
  scene.add(dashes);
  // arc-length share of the route up to a point, so the dashes draw up to wherever Nesto is
  const uToArc = (() => {
    const lens = route.getLengths(N * 40), total = lens[lens.length - 1];
    return (u: number) => lens[Math.round(u * (lens.length - 1))] / total;
  })();

  /* ---------- the stations ---------- */
  type Station = { kind: StationKind; group: THREE.Group; prop: THREE.Vector3; robot: THREE.Vector3; target: THREE.Vector3; az: number; update?: (t: number, dt: number, lp: number, here: number) => void; look?: () => THREE.Vector3 | null; panelTarget?: THREE.Vector3 };
  const stations: Station[] = [];
  const modelHolders: THREE.Group[] = [];

  const pad = (r: number) => {
    const g = new THREE.Group();
    g.add(mesh(cyl(r, r + 0.06, 0.1, 64), M.plastic, 0, 0.05, 0));
    const ring = new THREE.Mesh(geo(`ring${r}`, () => new THREE.TorusGeometry(r - 0.16, 0.014, 8, 96)), M.trim);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.105;
    g.add(ring);
    return g;
  };
  const table = (w: number, d: number, h: number) => {
    const g = new THREE.Group();
    g.add(mesh(rbox(w, 0.08, d, 0.03), M.wood, 0, h, 0));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(cyl(0.04, 0.04, h, 12), M.dark, sx * (w / 2 - 0.15), h / 2, sz * (d / 2 - 0.15)));
    return g;
  };

  const builders: Record<StationKind, (g: THREE.Group, st: Station) => void> = {
    intro() { /* Nesto alone */ },
    overview(g) {
      g.add(mesh(cyl(0.95, 1.0, 0.5, 64), M.plastic, 0, 0.35, 0));
      g.add(mesh(cyl(0.97, 0.97, 0.04, 64), M.accent, 0, 0.62, 0));
      const holder = new THREE.Group();
      holder.position.y = 0.64;
      g.add(holder);
      modelHolders.push(holder);
      stUpdate(g, (t, dt) => { holder.rotation.y += dt * (opts.reduced ? 0 : 0.25); });
    },
    bom(g) {
      g.add(table(3.0, 1.9, 0.78));
      const cats = data.bomCategories.slice(0, 24);
      const cols = Math.max(1, Math.ceil(Math.sqrt(cats.length * 1.6)));
      const rows = Math.ceil(cats.length / cols);
      const tokens = cats.map((c, i) => {
        const tk = new THREE.Group();
        const col = i % cols, row = Math.floor(i / cols);
        tk.position.set((col - (cols - 1) / 2) * (2.6 / cols), 0.84, (row - (rows - 1) / 2) * (1.55 / Math.max(rows, 1)));
        if (c === "Electronics") {
          tk.add(mesh(rbox(0.42, 0.04, 0.3, 0.01), M.pcb, 0, 0.02, 0), mesh(rbox(0.14, 0.05, 0.14, 0.01), M.chip, 0.05, 0.065, 0));
        } else if (c === "Movement") {
          const w = mesh(cyl(0.17, 0.17, 0.08, 24), M.wheel, 0, 0.18, 0);
          w.rotation.z = Math.PI / 2;
          const tire = mesh(geo("tire", () => new THREE.TorusGeometry(0.17, 0.045, 10, 28)), M.tire, 0, 0.18, 0);
          tire.rotation.y = Math.PI / 2;
          tk.add(w, tire);
        } else if (c === "Power") {
          const b = mesh(cyl(0.08, 0.08, 0.36, 20), M.cell, 0, 0.08, 0);
          b.rotation.z = Math.PI / 2;
          const capE = mesh(cyl(0.05, 0.05, 0.03, 16), M.metal, 0.195, 0.08, 0);
          capE.rotation.z = Math.PI / 2;
          tk.add(b, capE);
        } else {
          tk.add(mesh(rbox(0.44, 0.03, 0.32, 0.01), M.acrylic, 0, 0.015, 0));
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) tk.add(mesh(cyl(0.015, 0.015, 0.05, 8), M.metal, sx * 0.17, 0.03, sz * 0.12));
        }
        tk.rotation.y = ((i * 37) % 11) / 11 - 0.5;
        tk.scale.setScalar(0.001);
        g.add(tk);
        return tk;
      });
      stUpdate(g, (t, dt, lp, here) => {
        const shown = tokens.length * clamp(0.2 + lp * 1.35) * smooth(0.2, 0.9, here);
        tokens.forEach((tk, i) => {
          const k = clamp(shown - i);
          const s = k <= 0 ? 0.001 : k * (1 + Math.sin(k * Math.PI) * 0.18);
          tk.scale.setScalar(lerp(tk.scale.x, Math.max(s, 0.001), 1 - Math.exp(-dt * 10)));
        });
      });
    },
    wiring(g) {
      g.add(mesh(rbox(3.2, 2.1, 0.1, 0.05), M.dark, 0, 1.5, -0.2));
      for (const sx of [-1, 1]) g.add(mesh(cyl(0.05, 0.05, 1.5, 12), M.dark, sx * 1.35, 0.75, -0.25));
      const ctrl = mesh(rbox(0.9, 0.62, 0.06, 0.02), M.pcb, -0.8, 1.65, -0.12);
      const drv = mesh(rbox(0.64, 0.52, 0.06, 0.02), M.driver, 0.9, 1.85, -0.12);
      const sen = mesh(rbox(0.56, 0.2, 0.06, 0.02), M.pcb, 0.75, 0.82, -0.12);
      g.add(ctrl, drv, sen, mesh(rbox(0.3, 0.22, 0.05, 0.01), M.chip, -0.8, 1.65, -0.08));
      const colors = (data.wireColors.length ? data.wireColors : ["Red", "Black", "Yellow", "Green"]).slice(0, 12);
      const wires = colors.map((c, i) => {
        const hex = wireHex(c);
        const mat = track(new THREE.MeshStandardMaterial({ color: hex, roughness: 0.45, emissive: hex, emissiveIntensity: 0.12 }));
        const from = new THREE.Vector3(-1.18 + (i % 10) * 0.077, 1.95, -0.08);
        const toDrv = i % 3 !== 2;
        const to = toDrv ? new THREE.Vector3(0.66 + (i % 6) * 0.085, 1.6, -0.08) : new THREE.Vector3(0.53 + (i % 5) * 0.1, 0.92, -0.08);
        const mid = new THREE.Vector3((from.x + to.x) / 2, (toDrv ? 2.38 : 1.1) + (i % 4) * 0.06, 0.12 + (i % 3) * 0.05);
        const curve = new THREE.CubicBezierCurve3(from, new THREE.Vector3(from.x, mid.y, mid.z), new THREE.Vector3(to.x, mid.y, mid.z), to);
        const tg = track(new THREE.TubeGeometry(curve, 48, 0.022, 8, false));
        const w = new THREE.Mesh(tg, mat);
        w.castShadow = true;
        g.add(w);
        return { w, total: tg.index ? tg.index.count : 0 };
      });
      stUpdate(g, (t, dt, lp, here) => {
        const r = clamp(0.15 + lp * 1.6) * smooth(0.15, 0.85, here) * wires.length;
        wires.forEach((x, i) => {
          const k = clamp(r - i);
          x.w.visible = k > 0.001;
          x.w.geometry.setDrawRange(0, Math.floor((x.total * k) / 6) * 6);
        });
      });
    },
    pinout(g, st) {
      g.add(mesh(cyl(1.7, 1.8, 0.36, 64), M.dark, 0, 0.18, 0));
      g.add(mesh(rbox(2.6, 0.08, 1.7, 0.03), M.pcb, 0, 0.42, 0));
      g.add(mesh(rbox(0.6, 0.08, 0.6, 0.02), M.chip, -0.3, 0.5, 0.15), mesh(rbox(0.4, 0.22, 0.32, 0.03), M.metal, -1.05, 0.55, 0.5));
      const pins = clamp(data.pinCount || 8, 4, 20);
      const span = Math.min(2.3, pins * 0.16);
      g.add(mesh(rbox(span + 0.12, 0.12, 0.16, 0.02), M.chip, 0.1, 0.52, -0.62));
      const pinMeshes: THREE.Mesh[] = [];
      for (let i = 0; i < pins; i++) {
        const p = mesh(rbox(0.045, 0.24, 0.045, 0.008), M.gold, 0.1 - span / 2 + (i + 0.5) * (span / pins), 0.66, -0.62);
        pinMeshes.push(p);
        g.add(p);
      }
      const spark = new THREE.Sprite(M.halo);
      spark.scale.setScalar(0.5);
      const lead = mesh(cyl(0.02, 0.02, 0.9, 8), M.glow, 0, 0, 0);
      g.add(spark, lead);
      let hot = 0;
      const look = new THREE.Vector3();
      st.look = () => look;
      stUpdate(g, (t, dt) => {
        const target = state.hotPin >= 0 ? state.hotPin % pins : data.pinCount ? Math.floor(t * 0.9) % pins : -1;
        hot = target;
        const visible = hot >= 0;
        spark.visible = lead.visible = visible;
        if (!visible) return;
        const p = pinMeshes[hot].position;
        spark.position.lerp(look.set(p.x, 0.82, p.z), 1 - Math.exp(-dt * 12));
        lead.position.set(spark.position.x, 1.25, spark.position.z);
        M.glow.emissiveIntensity = 1.6 + Math.sin(t * 6) * 0.4;
        look.copy(spark.position).applyMatrix4(g.matrixWorld);
      });
    },
    steps(g) {
      g.add(table(2.6, 1.8, 0.78));
      const n = clamp(data.stepCount || 6, 1, 18);
      const mats = [M.plastic, M.accent, M.pcb, M.wood, M.dark];
      const done = track(new THREE.MeshStandardMaterial({ color: 0x2f9e5b, roughness: 0.45, emissive: 0x2f9e5b, emissiveIntensity: 0.25 }));
      const layers = Array.from({ length: n }, (_, i) => {
        const l = mesh(rbox(1.15 - (i % 3) * 0.08, 0.07, 0.82 - (i % 2) * 0.06, 0.02), mats[i % mats.length], 0, 0.86 + i * 0.085, 0);
        l.rotation.y = (i % 2 ? 1 : -1) * 0.08 * (i % 3);
        l.userData.base = mats[i % mats.length];
        l.visible = false;
        g.add(l);
        return l;
      });
      stUpdate(g, (t, dt, lp, here) => {
        const shown = n * clamp(0.08 + lp * 1.1) * smooth(0.2, 0.9, here);
        layers.forEach((l, i) => {
          // a layer joins the stack once the reader reaches it, then drops into place on its own
          const on = shown - i > 0.5;
          const rest = 0.86 + i * 0.085;
          if (on && !l.visible) l.position.y = rest + 0.7;
          l.visible = on;
          l.position.y = lerp(l.position.y, rest, 1 - Math.exp(-dt * 9));
          l.material = state.completed[i] ? done : l.userData.base;
        });
      });
    },
    view3d(g) {
      g.add(mesh(cyl(1.25, 1.35, 0.3, 64), M.plastic, 0, 0.15, 0));
      const ring = mesh(geo("vring", () => new THREE.TorusGeometry(1.45, 0.06, 16, 120)), M.accent, 0, 1.75, 0);
      g.add(ring);
      const holder = new THREE.Group();
      holder.position.y = 1.05;
      g.add(holder);
      modelHolders.push(holder);
      stUpdate(g, (t, dt) => { holder.rotation.y -= dt * (opts.reduced ? 0 : 0.35); ring.rotation.y = Math.sin(t * 0.4) * 0.12; });
    },
    code(g) {
      g.add(mesh(rbox(3.0, 1.95, 0.1, 0.06), M.screen, 0, 1.7, 0));
      g.add(mesh(cyl(0.06, 0.06, 0.7, 12), M.dark, 0, 0.35, -0.08), mesh(rbox(1.0, 0.05, 0.5, 0.02), M.dark, 0, 0.03, -0.08));
      const ROWS = 18;
      const barGeo = track(new THREE.BoxGeometry(1, 0.05, 0.01));
      const palette = { comment: 0x6a9955, pre: 0xc586c0, key: 0x569cd6, text: 0xd4d4d4 };
      const barMats = Object.fromEntries(Object.entries(palette).map(([k, c]) => [k, track(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9 }))])) as Record<keyof typeof palette, THREE.MeshBasicMaterial>;
      const bars = Array.from({ length: ROWS }, (_, i) => {
        const b = new THREE.Mesh(barGeo, barMats.text);
        b.position.set(0, 2.5 - i * 0.094, 0.06);
        g.add(b);
        return b;
      });
      const lines = data.codeLines.length ? data.codeLines : [];
      let offset = -1;
      stUpdate(g, (t, dt, lp) => {
        const o = Math.max(0, Math.round(lp * Math.max(0, lines.length - ROWS)));
        if (o === offset) return;
        offset = o;
        bars.forEach((b, i) => {
          const line = lines[o + i] ?? "";
          const trimmed = line.trim();
          b.visible = trimmed.length > 0;
          const indent = line.length - line.trimStart().length;
          const w = Math.min(trimmed.length, 64) / 64 * 2.35;
          b.scale.x = Math.max(w, 0.02);
          b.position.x = -1.28 + Math.min(indent, 12) * 0.04 + w / 2;
          b.material = trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") ? barMats.comment
            : trimmed.startsWith("#") ? barMats.pre
            : /^(void|int|const|float|bool|if|else|for|while|return|set|feature|#define)\b/.test(trimmed) ? barMats.key
            : barMats.text;
        });
      });
    },
    stores(g) {
      const cols = Math.max(1, data.storeParts.length || 4);
      const width = 0.8;
      const shelves: THREE.Mesh[][] = [];
      for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) * (width + 0.1);
        for (const sx of [-1, 1]) g.add(mesh(rbox(0.05, 2.1, 0.5, 0.01), M.dark, x + sx * width / 2, 1.05, 0));
        for (let s = 0; s < 3; s++) g.add(mesh(rbox(width, 0.04, 0.5, 0.01), M.wood, x, 0.4 + s * 0.65, 0));
        if (c === data.topStore) g.add(mesh(rbox(width * 0.7, 0.12, 0.02, 0.01), M.accent, x, 2.2, 0.24));
        const count = Math.min(data.storeParts[c] ?? 6, 12);
        const boxes: THREE.Mesh[] = [];
        for (let i = 0; i < count; i++) {
          const s = Math.floor(i / 4), k = i % 4;
          const b = mesh(rbox(0.16, 0.2 + ((i * 7) % 3) * 0.05, 0.26, 0.015), M.box, x - 0.27 + k * 0.18, 0.42 + s * 0.65, 0);
          b.position.y += (b.geometry as RoundedBoxGeometry).parameters.height / 2;
          b.userData.y = b.position.y;
          boxes.push(b);
          g.add(b);
        }
        shelves.push(boxes);
      }
      stUpdate(g, (t, dt, lp, here) => {
        const k = clamp(0.25 + lp * 1.4) * smooth(0.2, 0.9, here);
        shelves.forEach((boxes) => boxes.forEach((b, i) => {
          const on = k * boxes.length - i > 0.5;
          if (on && !b.visible) b.position.y = b.userData.y + 0.4;
          b.visible = on;
          b.position.y = lerp(b.position.y, b.userData.y, 1 - Math.exp(-dt * 9));
        }));
      });
    },
    faq(g) {
      g.add(pad(1.9));
      const ring = new THREE.Mesh(geo("faqring", () => new THREE.TorusGeometry(1.0, 0.035, 10, 96)), M.landing);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.125;
      g.add(ring);
    },
  };
  // stations register their per-frame behaviour through this tiny helper
  let pendingUpdate: Station["update"];
  function stUpdate(_g: THREE.Group, fn: NonNullable<Station["update"]>) { pendingUpdate = fn; }

  // panel journey: one floating panel per station (to the subject's left, Nesto stands to its right)
  const panelMode = !!data.panels;
  const boards: THREE.Mesh[] = [];
  const BOARD = { w: 2.7, h: 2.7 * (640 / 1024), x: -1.95, y: 2.3, z: 0.8 };
  let hoverK = -1;
  // panels need the camera a little further back to frame panel, subject and Nesto together
  const distOf = (kind: StationKind) => SHOT[kind].dist + (panelMode && kind !== "intro" ? 1.9 : 0);

  data.kinds.forEach((kind, k) => {
    const shot = SHOT[kind];
    const g = new THREE.Group();
    g.position.copy(stationPos[k]);
    g.rotation.y = shot.az;
    if (kind !== "faq" && kind !== "intro") g.add(pad(2.15));
    const st: Station = { kind, group: g, prop: new THREE.Vector3(), robot: new THREE.Vector3(), target: new THREE.Vector3(), az: shot.az };
    pendingUpdate = undefined;
    builders[kind](g, st);
    st.update = pendingUpdate;
    scene.add(g);
    // camera-relative placement: Nesto waits to the prop's right as seen from the camera
    const right = new THREE.Vector3(Math.cos(shot.az), 0, -Math.sin(shot.az));
    const fwd = new THREE.Vector3(Math.sin(shot.az), 0, Math.cos(shot.az));
    st.prop.copy(stationPos[k]).setY(1.0);
    st.robot.copy(stationPos[k]).addScaledVector(right, shot.robot[0]).addScaledVector(fwd, shot.robot[2]).setY(shot.robot[1]);
    st.target.copy(stationPos[k]).addScaledVector(right, shot.robot[0] * 0.48).setY(shot.up);
    if (kind === "intro") st.target.copy(st.robot).setY(shot.up);
    // panel journey: a floating panel beside the station's subject, facing the camera; Nesto presents it
    const preview = data.panels?.[k];
    if (preview) {
      let tex: THREE.CanvasTexture | null = null;
      const art = createPanelArt(preview, () => { if (tex) tex.needsUpdate = true; });
      tex = track(new THREE.CanvasTexture(art.canvas));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const board = new THREE.Mesh(geo("board", () => new THREE.PlaneGeometry(BOARD.w, BOARD.h)), track(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })));
      board.position.set(BOARD.x, BOARD.y, BOARD.z);
      board.rotation.x = -shot.el * 0.6;
      board.userData = { k, base: BOARD.y, hover: 0 };
      board.add(mesh(rbox(BOARD.w + 0.14, BOARD.h + 0.14, 0.06, 0.06), M.plastic, 0, 0, -0.045));
      g.add(board);
      boards.push(board);
      g.updateMatrixWorld(true);
      const centre = board.getWorldPosition(new THREE.Vector3());
      st.target.lerpVectors(centre, st.robot, 0.5);
      st.look = () => centre;
      // portrait screens can't fit panel, subject and Nesto side by side: frame mostly the panel, Nesto at the edge
      st.panelTarget = st.target.clone().lerp(centre, 0.62);
    }
    stations.push(st);
  });

  /* ---------- the project's own 3D model sits on the overview pedestal and inside the 3D View ring ---------- */
  let modelRoot: THREE.Object3D | null = null;
  let modelDispose: (() => void) | null = null;
  const placeModel = (m: THREE.Object3D, span = 1.5) => {
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    const s = span / Math.max(size.x, size.y, size.z, 0.001);
    m.position.set(-centre.x * s, -box.min.y * s, -centre.z * s);
    m.scale.setScalar(s);
    m.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    modelRoot = m;
    modelHolders.forEach((h, i) => h.add(i === 0 ? m : m.clone()));
  };
  if (data.localModel === "line-follower" && modelHolders.length) {
    // the Line Follower's detailed, fully assembled model (the same one its build guide uses)
    import("@/components/workshop/lineFollowerModel").then(({ buildLineFollowerModel }) => {
      if (disposed) return;
      const lf = buildLineFollowerModel();
      lf.root.remove(lf.track); // the test track isn't part of the robot
      modelDispose = lf.dispose;
      const turn = new THREE.Group();
      turn.rotation.y = LF_TURN;
      turn.add(lf.root);
      placeModel(turn, 1.9); // a low, wide robot: a little larger so its parts read at pedestal size
    }).catch(() => { /* the stations still read fine without the model */ });
  } else if (data.localModel && data.localModel !== "line-follower" && modelHolders.length) {
    // the drone's, arm's or soccer bot's detailed, fully assembled model (the same one its build guide uses)
    (data.localModel === "drone-explorer"
      ? import("@/components/workshop/droneModel").then((m) => m.buildDroneModel)
      : data.localModel === "robotic-arm"
        ? import("@/components/workshop/armModel").then((m) => m.buildArmModel)
        : import("@/components/workshop/soccerModel").then((m) => m.buildSoccerModel)
    ).then((build) => {
      if (disposed) return;
      const dr = build();
      if (dr.track) dr.root.remove(dr.track); // the soccer bot's ball isn't part of the robot
      modelDispose = dr.dispose;
      const turn = new THREE.Group();
      turn.rotation.y = LF_TURN;
      turn.add(dr.root);
      placeModel(turn, 1.9);
    }).catch(() => { /* the stations still read fine without the model */ });
  } else if (data.modelUrl && modelHolders.length) {
    new GLTFLoader().load(
      data.modelUrl,
      (gltf) => { if (!disposed) placeModel(gltf.scene); },
      undefined,
      () => { /* no model for this project: the stations still read fine without it */ }
    );
  }

  /* ---------- Nesto ---------- */
  const nesto = buildNesto(haloTex);
  const NESTO_SCALE = 0.55;
  nesto.root.scale.setScalar(NESTO_SCALE);
  const rig = new THREE.Group(), tilt = new THREE.Group();
  rig.add(tilt);
  tilt.add(nesto.root);
  scene.add(rig);
  const blob = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), M.shadow);
  blob.rotation.x = -Math.PI / 2;
  scene.add(blob);
  const animate = createNestoAnimator(nesto);
  const robotPath = new THREE.CatmullRomCurve3(stations.map((s) => s.robot), false, "centripetal");

  /* ---------- per-frame ---------- */
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), camTarget = new THREE.Vector3(), camPos = new THREE.Vector3();
  const look = new THREE.Vector3(), lastRobot = new THREE.Vector3(), parallax = new THREE.Vector2(), ndc = new THREE.Vector2();
  const DARK_FLOOR = new THREE.Color(0x1c2128), LIGHT_FLOOR = new THREE.Color(0xefe8dd);
  const raycaster = new THREE.Raycaster();
  let fs = state.f, fv = 0, first = true, frame = 0, raf = 0, last = performance.now(), disposed = false;
  let arrived = -1, arrivedAt = 0, lastDark = -1, shift = { x: 0, y: 0 };
  const bg = new THREE.Color(), fogC = new THREE.Color();
  const clock0 = performance.now();

  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);

  function tick(now: number) {
    raf = requestAnimationFrame(tick);
    if (!state.visible || document.hidden) return;
    // the dedicated 3D viewer has its own renderer: while it is on screen this world idles at a low rate
    if (state.viewerBusy && frame++ % 3 !== 0) return;
    // a frame's timestamp is when the frame began, which can predate the (long) stage setup: never let time run
    // backwards, or every eased value in the scene is thrown off on the first frame
    const elapsed = clamp((now - last) / 1000, 0, 0.25);
    const dt = Math.min(elapsed, 0.05);
    last = Math.max(last, now);
    const t = Math.max(0, (now - clock0) / 1000);

    /* scroll → continuous chapter position on a critically damped spring: wheel steps glide, and a long jump
       (chapter navigator, deep scroll) becomes one continuous flight of about a second, never a teleport */
    const target = clamp(state.f, 0, N - 1);
    if (opts.reduced) { fs = Math.round(target); fv = 0; }
    else if (first) { fs = target; fv = 0; }
    else {
      const ex = Math.exp(-7 * elapsed), d = fs - target, c = fv + 7 * d;
      fs = clamp(target + (d + c * elapsed) * ex, 0, N - 1);
      fv = (fv - 7 * c * elapsed) * ex;
    }
    const i = Math.min(Math.floor(fs), N - 2 < 0 ? 0 : N - 2);
    const frac = N > 1 ? clamp(fs - i) : 0;
    // parked or browsing, each leg eases in and out of its station; flying past several stations at once, the
    // easing gives way to a steady pace so Nesto sweeps through instead of braking at every one
    const fast = opts.reduced ? 0 : smooth(0.8, 2.5, Math.abs(fv));
    const e = lerp(ease(frac), frac, fast);
    const A = stations[i], B = stations[Math.min(i + 1, N - 1)];
    const travel = lerp(Math.sin(Math.PI * frac), 1, fast);

    /* Nesto travels the route: lifts off, flies over, settles beside the next station */
    const u = N > 1 ? (i + e) / (N - 1) : 0;
    const pos = robotPath.getPoint(u, tmp);
    const landed = B.kind === "faq" ? smooth(0.85, 1, fs - (N - 2)) : 0;
    pos.y += travel * 1.6 + (opts.reduced ? 0 : Math.sin(t * 1.6) * 0.06 * (1 - landed));
    if (B.kind === "faq") pos.y = lerp(pos.y, stations[N - 1].robot.y, landed);
    rig.position.copy(pos);
    const speed = first ? 0 : pos.distanceTo(lastRobot) / Math.max(dt, 1e-3);
    lastRobot.copy(pos);

    /* camera: orbit parameters interpolate between the two stations' shots, pulling back mid-flight */
    const sa = SHOT[A.kind], sb = SHOT[B.kind];
    const portrait = camera.aspect < 0.8;
    const introW = A.kind === "intro" ? 1 - e : 0; // how much of the shot is still the intro
    const tA = portrait ? A.panelTarget ?? A.target : A.target, tB = portrait ? B.panelTarget ?? B.target : B.target;
    camTarget.lerpVectors(tA, tB, e).lerp(pos, travel * 0.55);
    const az = lerpAngle(sa.az, sb.az, e);
    const el = lerp(sa.el, sb.el, e) + travel * 0.22;
    const narrow = camera.aspect < 1 ? 1.45 : camera.aspect < 1.3 ? 1.15 : 1;
    // (on a phone the intro steps back a little so Nesto fits between the header and his title)
    const dist = (lerp(distOf(A.kind), distOf(B.kind), e) + travel * 3.2) * narrow * (portrait ? lerp(1, 1.3, introW) : 1);
    camPos.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist).add(camTarget);
    if (!opts.reduced && !mobile) {
      parallax.lerp(ndc.set(state.pointer.x, state.pointer.y), 1 - Math.exp(-dt * 3));
      camPos.x += parallax.x * 0.35 * Math.cos(az);
      camPos.z -= parallax.x * 0.35 * Math.sin(az);
      camPos.y -= parallax.y * 0.2;
    }
    camera.position.copy(camPos);
    camera.lookAt(camTarget);

    /* frame the scene in the half of the screen the chapter text leaves free */
    const w = canvas.clientWidth, h = canvas.clientHeight, wide = w >= 1024;
    const sideA = state.side[i] ?? 0, sideB = state.side[Math.min(i + 1, N - 1)] ?? 0;
    // (the panel journey keeps a caption along the bottom, so its scene sits a little higher)
    // on narrow screens the intro lifts Nesto clear of the title below him
    const sx = wide ? lerp(sideA, sideB, e) * 0.21 : 0, sy = wide ? (panelMode ? 0.05 : 0) : panelMode ? lerp(0.1, 0.18, introW) : 0.17;
    if (first || Math.abs(sx - shift.x) > 1e-4 || Math.abs(sy - shift.y) > 1e-4) {
      shift = { x: sx, y: sy };
      camera.setViewOffset(w, h, -sx * w, sy * h, w, h);
    }

    /* body faces the way it flies, then turns to the visitor once it arrives */
    const tng = robotPath.getTangent(clamp(u, 0, 1), tmp2);
    const flyYaw = Math.atan2(tng.x, tng.z);
    const faceYaw = Math.atan2(camPos.x - pos.x, camPos.z - pos.z);
    const moving = Math.max(smooth(0.02, 0.2, frac) * smooth(0.98, 0.8, frac), fast);
    rig.rotation.y = lerpAngle(faceYaw, flyYaw, moving);
    tilt.rotation.x = lerp(tilt.rotation.x, moving * 0.32, 1 - Math.exp(-dt * 6));

    /* where he looks: ahead while flying; at the station's subject on arrival; otherwise at the visitor */
    const rest = Math.round(fs);
    if (Math.abs(fs - rest) < 0.03) {
      if (arrived !== rest) { arrived = rest; arrivedAt = t; }
    } else arrived = -1;
    const here = stations[Math.min(Math.max(rest, 0), N - 1)];
    const sinceArrive = arrived >= 0 ? t - arrivedAt : -1;
    // (the intro has nothing to present: Nesto greets the visitor instead)
    const presents = here.kind !== "intro" && (here.kind !== "faq" || panelMode);
    const showing = presents && sinceArrive >= 0 && (sinceArrive < 2.6 || (sinceArrive % 7) > 5.6);
    const greeting = here.kind === "intro" && sinceArrive >= 0 && sinceArrive < 2.4;
    const pointerFresh = !mobile && now - state.pointer.at < 2500;
    if (moving > 0.3) look.copy(pos).addScaledVector(tng.normalize(), 4);
    else if (showing) look.copy(here.look?.() ?? here.prop);
    else if (pointerFresh && !opts.reduced) {
      raycaster.setFromCamera(ndc.set(state.pointer.x, -state.pointer.y), camera);
      // a point on the glass between visitor and robot, so the gaze stays stable even with the cursor over Nesto
      raycaster.ray.at(camera.position.distanceTo(pos) * 0.55, look);
    } else look.copy(camera.position);
    animate({
      t, dt, look, reduced: opts.reduced, speed,
      happy: pointerFresh || greeting || (here.kind === "faq" && landed > 0.9),
      pointing: showing && moving < 0.1,
      waving: greeting || (here.kind === "faq" && landed > 0.9 && sinceArrive >= 0 && sinceArrive < 2.2),
      landed,
    });
    const onPad = stations.some((st) => tmp2.set(pos.x, 0, pos.z).distanceTo(st.group.position) < 2.9);
    blob.position.set(pos.x, onPad ? 0.112 : 0.015, pos.z);
    const hgt = Math.max(pos.y - 0.6, 0);
    blob.scale.setScalar(0.9 + hgt * 0.35);
    M.shadow.opacity = 0.26 / (1 + hgt * 0.8);

    /* stations: each one animates its own subject, driven by how far the visitor has read that chapter */
    stations.forEach((st, k) => {
      const near = Math.abs(fs - k) < 1.6;
      // the panel journey keeps every station in view, so the route ahead shows in the distance
      st.group.visible = panelMode || Math.abs(fs - k) < 0.995;
      if (near && st.update) st.update(t, dt, state.local[k] ?? 0, clamp(1 - Math.abs(fs - k)));
    });
    // panels float gently and lift a touch under the pointer
    boards.forEach((b) => {
      const u = b.userData as { k: number; base: number; hover: number };
      u.hover = lerp(u.hover, u.k === hoverK ? 1 : 0, 1 - Math.exp(-dt * 10));
      b.scale.setScalar(1 + u.hover * 0.05);
      b.position.y = u.base + (opts.reduced ? 0 : Math.sin(t * 0.64 + u.k * 1.3) * 0.05);
    });
    if (N > 1) dashes.count = Math.max(1, Math.round(dashCount * clamp(uToArc(clamp(u + 0.02)) + 0.002)));
    M.landing.emissiveIntensity = landed * (1.4 + Math.sin(t * 2) * 0.3);

    /* light and colour follow the chapter: warm studio ↔ dark technical workspace */
    const dark = lerp(sa.dark, sb.dark, e);
    bg.copy(LIGHT_BG).lerp(DARK_BG, dark);
    (scene.background as THREE.Color).copy(bg);
    fogC.copy(bg);
    (scene.fog as THREE.Fog).color.copy(fogC);
    M.floor.color.copy(LIGHT_FLOOR).lerp(DARK_FLOOR, dark);
    hemi.intensity = lerp(1.1, 0.35, dark);
    key.intensity = lerp(2.2, 1.3, dark);
    rim.intensity = lerp(0, 14, dark);
    rim.position.copy(camTarget).add(tmp.set(-3, 3, 2));
    scene.environmentIntensity = lerp(0.9, 0.4, dark);
    if (Math.abs(dark - lastDark) > 0.01) { lastDark = dark; opts.onDark(dark); }
    key.target.position.copy(camTarget);
    key.position.copy(camTarget).add(tmp.set(4, 7, 5));

    renderer.render(scene, camera);
    first = false;
  }
  raf = requestAnimationFrame(tick);

  const pickNdc = new THREE.Vector2(), corner = new THREE.Vector3();
  return {
    resize,
    /* panel under a point given in normalised device coordinates (x right, y up), or -1 */
    pick(nx: number, ny: number) {
      if (!boards.length) return -1;
      raycaster.setFromCamera(pickNdc.set(nx, ny), camera);
      const hit = raycaster.intersectObjects(boards, false)[0];
      return hit ? (hit.object.userData.k as number) : -1;
    },
    setHover(k: number) { hoverK = k; },
    /* where a station's panel currently sits on screen, in CSS pixels (the open animation grows from it) */
    panelRect(k: number) {
      const b = boards.find((x) => x.userData.k === k);
      if (!b) return null;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        b.localToWorld(corner.set((sx * BOARD.w) / 2, (sy * BOARD.h) / 2, 0)).project(camera);
        const x = ((corner.x + 1) / 2) * w, y = ((1 - corner.y) / 2) * h;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      return { left, top, right, bottom };
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      nesto.dispose();
      modelDispose?.();
      modelRoot?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
        }
      });
      geoCache.forEach((g) => g.dispose());
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
    },
  };
}
