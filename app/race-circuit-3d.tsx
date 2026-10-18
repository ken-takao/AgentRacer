"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CIRCUIT_3D, CIRCUIT_LAP_DISTANCE, circuitAtDistance, circuitPosition, circuitBodyOffsets } from "../lib/circuit-geometry";
import "./race-circuit-3d.css";

type DriverId = "red" | "blue";
type View = "overview" | DriverId;
type CircuitRace = {
  phase: string;
  updatedAt: number;
  now?: number;
  course: { length: number; obstacles: { id: string; progress: number; blockedLane: number }[] };
  players: Record<DriverId, { progress: number; lane: number; speed: number; slowedUntil: number }>;
};
export type RaceCircuit3DProps = { race: CircuitRace; decorative?: boolean; onUnavailable?: () => void };
const DRIVERS: DriverId[] = ["red", "blue"];
const COLORS = { red: 0xff625b, blue: 0x5aa4ff };

/** A view of server-authoritative positions, with no additional race simulation. */
export function RaceCircuit3D({ race, decorative = false, onUnavailable }: RaceCircuit3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<Record<DriverId, HTMLDivElement | null>>({ red: null, blue: null });
  const overlapNoteRef = useRef<HTMLDivElement>(null);
  const latest = useRef(race);
  latest.current = race;
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;
  const viewRef = useRef<View>("overview");
  const [view, setView] = useState<View>("overview");
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let frame = 0;
    let previousFrame = 0;
    let width = 1;
    let height = 1;
    let lostContext = false;
    const abort = new AbortController();
    const fail = () => {
      if (disposed) return;
      setStatus("unavailable");
      unavailableRef.current?.();
    };
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch { fail(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10242d);
    scene.fog = new THREE.Fog(0x10242d, 185, 360);
    const roots = new Set<THREE.Object3D>([scene]);
    const camera = new THREE.OrthographicCamera(-70, 70, 45, -45, 0.1, 500);
    const target = new THREE.Vector3();
    const eye = new THREE.Vector3();
    const projected = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const group = new THREE.Group();
    scene.add(group);

    const material = (color: number, roughness = 0.8, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const asphalt = material(0x343f47);
    const concrete = material(0x53616a);
    const dark = material(0x182a34);
    const white = material(0xe3e9df);
    const lime = material(0xc5df64);
    const grass = material(0x31524a);
    const rail = material(0x354c55, 0.5, 0.2);
    const orange = material(0xff9d43);
    const assets = new THREE.Group();
    roots.add(assets);
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true; mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const ringGeometry = (inner: number, outer: number, elevation: number) => {
      const vertices: number[] = [], indices: number[] = [];
      const segments = 240;
      for (let i = 0; i <= segments; i++) {
        const d = i / segments * CIRCUIT_LAP_DISTANCE;
        for (const offset of [inner, outer]) {
          const p = circuitAtDistance(d, offset);
          vertices.push(p.x, elevation, p.z);
        }
        if (i < segments) {
          const n = i * 2;
          indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      return geometry;
    };
    const ring = (inner: number, outer: number, y: number, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(ringGeometry(inner, outer, y), mat);
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    // Raised island and run-off keep the circuit's depth readable from the broadcast camera.
    box(132, 1.5, 82, dark, 0, -1.15, 0);
    box(130, 0.12, 80, grass, 0, -0.32, 0);
    ring(-8.8, 9.2, -0.1, concrete);
    ring(-6.3, 6.3, 0.02, asphalt);
    ring(-6.35, -6.12, 0.065, white);
    ring(6.12, 6.35, 0.065, white);
    // The lane boundaries and curbs use the same course coordinates as cars and gates.
    const dashGeometry = new THREE.BoxGeometry(1.5, 0.025, 0.12);
    const curbGeometry = new THREE.BoxGeometry(1.52, 0.12, 0.86);
    assets.add(new THREE.Mesh(dashGeometry, white), new THREE.Mesh(curbGeometry, lime));
    for (let i = 0; i < 104; i++) {
      const d = i / 104 * CIRCUIT_LAP_DISTANCE;
      for (const offset of [-2.1, 2.1]) {
        if (i % 2) continue;
        const p = circuitAtDistance(d, offset);
        const dash = new THREE.Mesh(dashGeometry, white);
        dash.position.set(p.x, 0.07, p.z); dash.rotation.y = -p.heading;
        group.add(dash);
      }
      for (const offset of [-6.85, 6.85]) {
        const p = circuitAtDistance(d, offset);
        const curb = new THREE.Mesh(curbGeometry, i % 2 ? dark : lime);
        curb.position.set(p.x, 0.08, p.z); curb.rotation.y = -p.heading;
        group.add(curb);
      }
    }
    // An outer wall, with breathing room between the race lane and track furniture.
    const wallGeometry = new THREE.BoxGeometry(2.6, 0.75, 0.38);
    assets.add(new THREE.Mesh(wallGeometry, rail));
    for (let i = 0; i < 110; i++) {
      const p = circuitAtDistance(i / 110 * CIRCUIT_LAP_DISTANCE, 9);
      const wall = new THREE.Mesh(wallGeometry, i % 7 === 0 ? lime : rail);
      wall.position.set(p.x, 0.3, p.z); wall.rotation.y = -p.heading;
      wall.castShadow = true; group.add(wall);
    }
    // Actual checkerboard start/finish line across all three lanes.
    for (let row = 0; row < 2; row++) for (let lane = 0; lane < 12; lane++) {
      box(0.75, 0.035, 1.05, (row + lane) % 2 ? dark : white, row * 0.75 - 0.375, 0.075, 15.225 + lane * 1.05);
    }
    // Start gantry is on the near straight; its high crossbeam clears the cars.
    for (const z of [12.8, 29.2]) box(0.5, 6.7, 0.5, rail, 0, 3.25, z);
    box(1.05, 1.0, 17.2, dark, 0, 6.6, 21);
    box(1.09, 0.1, 17.2, lime, 0, 7.15, 21);
    const lightMaterial = new THREE.MeshStandardMaterial({ color: 0xff5b4d, emissive: 0xff342d, emissiveIntensity: 1.5 });
    const startLights: THREE.Mesh[] = [];
    for (let i = 0; i < 5; i++) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), lightMaterial);
      lamp.position.set(0.58, 6.5, 19 + i); group.add(lamp); startLights.push(lamp);
    }
    // Far-side grandstands: stepped terraces, seats and a cantilever canopy.
    for (const standX of [-23, 23]) {
      for (let step = 0; step < 4; step++) {
        box(37, 0.7 + step * 0.7, 2.3, concrete, standX, (0.7 + step * 0.7) / 2 - 0.2, -31.3 - step * 2.0);
        for (let seat = 0; seat < 18; seat++) {
          box(1.45, 0.25, 0.85, (seat + step) % 4 === 0 ? lime : dark, standX - 17 + seat * 2, 0.65 + step * 0.7, -31.4 - step * 2);
        }
      }
      for (const x of [standX - 17, standX + 17]) box(0.38, 7, 0.38, rail, x, 3.3, -38.1);
      box(39, 0.3, 9.8, dark, standX, 6.8, -34.9);
      box(39, 0.18, 0.2, lime, standX, 6.72, -29.95);
    }
    // Infield pit pavilion and planting define scale without obscuring the racing lanes.
    box(32, 1.8, 6.5, dark, 1, 0.65, -7.5);
    box(34, 0.28, 7.5, concrete, 1, 1.7, -7.5);
    for (let x = -11; x <= 13; x += 8) box(6.5, 1.2, 0.08, material(0x55767d, 0.25, 0.25), x, 0.65, -4.22);
    const treeGeometry = new THREE.ConeGeometry(1.4, 3.8, 6);
    const treeMaterial = material(0x3b6b57);
    assets.add(new THREE.Mesh(treeGeometry, treeMaterial));
    for (const x of [-20, -14, 16, 22]) {
      const tree = new THREE.Mesh(treeGeometry, treeMaterial); tree.position.set(x, 1.75, 6.5); tree.castShadow = true; group.add(tree);
    }
    // Canvas typography is generated locally and remains part of the 3D world.
    const textPlane = (text: string, textWidth: number, color: string) => {
      const bitmap = document.createElement("canvas"); bitmap.width = 1024; bitmap.height = 128;
      const context = bitmap.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, bitmap.width, bitmap.height);
      context.font = "700 65px sans-serif"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillStyle = color;
      context.fillText(text, 512, 65);
      const texture = new THREE.CanvasTexture(bitmap); texture.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(textWidth, textWidth / 8), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
      mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, -0.14, 0.6); group.add(mesh);
    };
    textPlane("AGENT GRAND PRIX", 42, "#b5d4c4");

    const hemi = new THREE.HemisphereLight(0xc5e9ff, 0x354936, 2.4); scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d4, 3.6); sun.position.set(-35, 75, 35);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -82, right: 82, top: 67, bottom: -67, near: 1, far: 180 });
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05; scene.add(sun);
    const fill = new THREE.DirectionalLight(0x87baff, 1.25); fill.position.set(25, 30, -45); scene.add(fill);

    const cars: Partial<Record<DriverId, THREE.Group>> = {};
    const auras: Partial<Record<DriverId, THREE.Mesh>> = {};
    const tethers: Partial<Record<DriverId, THREE.Line>> = {};
    for (const id of DRIVERS) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
      const tether = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: COLORS[id], transparent: true, opacity: 0.8 }));
      tether.visible = false; group.add(tether); tethers[id] = tether;
    }
    const gates = new THREE.Group(); group.add(gates);
    const barrierGeometry = new THREE.BoxGeometry(0.7, 1.1, 3.5);
    assets.add(new THREE.Mesh(barrierGeometry, orange));
    let barrierModel: THREE.Group | undefined;
    let gateKey = "";
    const refreshGates = () => {
      const current = latest.current;
      const key = JSON.stringify([current.course, Boolean(barrierModel)]);
      if (key === gateKey) return;
      gateKey = key; gates.clear();
      for (const obstacle of current.course.obstacles) {
        const p = circuitPosition(obstacle.progress, obstacle.blockedLane, current.course.length);
        const gate = new THREE.Group(); gate.position.set(p.x, 0.05, p.z); gate.rotation.y = -p.heading;
        if (barrierModel) {
          const model = barrierModel.clone(true); model.rotation.y = Math.PI / 2; model.scale.setScalar(1.55); gate.add(model);
        } else {
          const mesh = new THREE.Mesh(barrierGeometry, orange); mesh.position.y = 0.55; mesh.castShadow = true; gate.add(mesh);
        }
        gates.add(gate);
      }
    };
    const loader = new GLTFLoader();
    const loadModel = async (url: string) => {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`Model unavailable: ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (disposed) throw new Error("Scene disposed");
      const gltf = await loader.parseAsync(buffer, url.slice(0, url.lastIndexOf("/") + 1));
      if (disposed) { disposeRoots([gltf.scene]); throw new Error("Scene disposed"); }
      roots.add(gltf.scene);
      gltf.scene.traverse(object => {
        if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; }
      });
      return gltf.scene;
    };
    void Promise.all(DRIVERS.map(async id => {
      const model = await loadModel(`/models/tesla-roadster/roadster_${id === "red" ? "02_red" : "03_blue"}.glb`);
      if (disposed) return;
      const car = new THREE.Group(); car.add(model); group.add(car); cars[id] = car;
      const glow = new THREE.Mesh(new THREE.RingGeometry(1.85, 2.08, 40), new THREE.MeshBasicMaterial({ color: COLORS[id], transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
      glow.rotation.x = -Math.PI / 2; glow.position.y = 0.055; group.add(glow); auras[id] = glow;
    })).then(() => { if (!disposed) setStatus("ready"); }).catch(() => { if (!disposed) fail(); });
    // A failed decorative prop leaves a visible geometric barrier in its correct gameplay position.
    void loadModel("/roadster-circuit/props/water_barrier.glb").then(model => { barrierModel = model; gateKey = ""; }).catch(() => {});

    let currentView: View | undefined;
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width); height = Math.max(1, bounds.height);
      renderer.setSize(width, height, false);
      currentView = undefined;
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const handleContextLost = (event: Event) => { event.preventDefault(); lostContext = true; cancelAnimationFrame(frame); fail(); };
    canvas.addEventListener("webglcontextlost", handleContextLost);
    const draw = (timestamp: number) => {
      if (disposed || lostContext) return;
      frame = requestAnimationFrame(draw);
      if (document.hidden || timestamp - previousFrame < 1000 / 40) return;
      previousFrame = timestamp;
      const current = latest.current;
      refreshGates();
      const anchors = DRIVERS.map(id => circuitPosition(current.players[id].progress, current.players[id].lane, current.course.length));
      const bodyOffsets = circuitBodyOffsets(anchors[0], anchors[1]);
      const overlapping = bodyOffsets[0] !== 0;
      if (overlapNoteRef.current) overlapNoteRef.current.hidden = !overlapping;
      const positions = DRIVERS.map((id, index) => {
        const player = current.players[id];
        const p = anchors[index];
        // Only the visible body separates; rings retain the exact server race position.
        const offset = bodyOffsets[index];
        const display = { ...p, x: p.x - Math.sin(p.heading) * offset, z: p.z + Math.cos(p.heading) * offset };
        const car = cars[id];
        if (car) {
          car.position.set(display.x, 0.08, display.z);
          // The team's GLB nose is local -X; yaw aligns that nose with the race tangent.
          car.rotation.y = Math.PI - p.heading;
        }
        const aura = auras[id];
        if (aura) {
          aura.position.set(p.x, 0.06, p.z);
          aura.scale.setScalar(overlapping && id === "blue" ? 1.13 : 1);
          (aura.material as THREE.MeshBasicMaterial).opacity = current.phase === "racing" && player.slowedUntil > (current.now ?? current.updatedAt) ? 1 : 0.55;
        }
        const tether = tethers[id];
        if (tether) {
          tether.visible = overlapping;
          const vertices = tether.geometry.getAttribute("position");
          vertices.setXYZ(0, p.x, 0.1, p.z); vertices.setXYZ(1, display.x, 0.12, display.z);
          vertices.needsUpdate = true;
          tether.geometry.computeBoundingSphere();
        }
        return display;
      });
      const selectedView = viewRef.current;
      if (currentView !== selectedView) {
        currentView = selectedView;
        const aspect = width / height;
        const visibleHeight = selectedView === "overview" ? Math.max(89, 146 / aspect) : Math.max(29, 43 / aspect);
        camera.left = -visibleHeight * aspect / 2; camera.right = visibleHeight * aspect / 2;
        camera.top = visibleHeight / 2; camera.bottom = -visibleHeight / 2; camera.updateProjectionMatrix();
      }
      if (selectedView === "overview") {
        eye.set(84, 100, 116); target.set(0, 0, -1);
      } else {
        const p = anchors[selectedView === "red" ? 0 : 1];
        const dx = Math.cos(p.heading), dz = Math.sin(p.heading);
        target.set(p.x + dx * 5, 0, p.z + dz * 5);
        eye.set(p.x - dx * 17 + dz * 11, 20, p.z - dz * 17 - dx * 11);
      }
      camera.position.copy(eye); camera.up.copy(up); camera.lookAt(target); camera.updateMatrixWorld();
      lightMaterial.color.set(current.phase === "racing" ? 0xb8f065 : 0xff5b4d);
      lightMaterial.emissive.copy(lightMaterial.color);
      startLights.forEach(lamp => { lamp.visible = current.phase === "countdown" || current.phase === "racing"; });
      const labelPoints = positions.map(p => projected.set(p.x, 2.8, p.z).project(camera).clone());
      const close = Math.abs((labelPoints[0].x - labelPoints[1].x) * width / 2) < 100 && Math.abs((labelPoints[0].y - labelPoints[1].y) * height / 2) < 40;
      DRIVERS.forEach((id, index) => {
        const label = labelsRef.current[id]; if (!label) return;
        const point = labelPoints[index];
        const x = (point.x * 0.5 + 0.5) * width;
        const y = (-point.y * 0.5 + 0.5) * height;
        label.style.visibility = cars[id] && point.z > -1 && point.z < 1 && x > 0 && x < width && y > 0 && y < height ? "visible" : "hidden";
        label.style.transform = `translate(${x}px, ${y - (close && index === 1 ? 33 : 0)}px) translate(-50%, -100%)`;
      });
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true; abort.abort(); cancelAnimationFrame(frame); observer.disconnect();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      sun.shadow.map?.dispose();
      disposeRoots(roots);
      renderer.renderLists.dispose(); renderer.dispose();
    };
  }, []);

  const chooseView = (next: View) => { viewRef.current = next; setView(next); };
  return <div className={`race-circuit-3d${decorative ? " is-decorative" : ""}`} data-renderer="three-dimensional" data-scene-status={status}>
    <canvas ref={canvasRef} aria-label="赤と青のロードスターが走る3Dの3レーンレースコース" role="img" />
    <div className="circuit-3d-topline"><span><i />TOKYO CIRCUIT <b>3D</b></span><small>3 LANES · 1 LAP</small></div>
    {DRIVERS.map(id => <div key={id} ref={element => { labelsRef.current[id] = element; }} className={`circuit-3d-car-label is-${id}`}><i />{id === "red" ? "SCARLET" : "COBALT"}</div>)}
    {status === "loading" && <div className="circuit-3d-loading" role="status"><i />3Dサーキットを準備しています</div>}
    {status === "unavailable" && <div className="circuit-3d-unavailable" role="status">3D表示を読み込めませんでした。ページを再読み込みしてください。</div>}
    {!decorative && <div className="circuit-3d-cameras" role="group" aria-label="観戦カメラ"><span>CAMERA</span><button type="button" aria-pressed={view === "overview"} onClick={() => chooseView("overview")}>コース全体</button><button type="button" className="red-camera" aria-pressed={view === "red"} onClick={() => chooseView("red")}>SCARLET</button><button type="button" className="blue-camera" aria-pressed={view === "blue"} onClick={() => chooseView("blue")}>COBALT</button></div>}
    <div ref={overlapNoteRef} className="circuit-3d-overlap-note" hidden>接近中：車体を左右にずらして表示 · リングが実際の位置</div>
    <div className="circuit-3d-caption">{view === "overview" ? "BROADCAST VIEW" : "ONBOARD VIEW"}<span>LIVE POSITIONS</span></div>
  </div>;
}

/** Dispose shared cloned meshes exactly once, including texture-backed canvas labels. */
function disposeRoots(roots: Iterable<THREE.Object3D>) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const root of roots) root.traverse(object => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => {
    const image = texture.image;
    texture.dispose();
    if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
  });
}
