"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { circuitAtProgress, circuitBounds, circuitPosition } from "../lib/circuit-geometry";
import { COURSE_NAMES, type CourseFeatures, type RouteChoice } from "../lib/race-course";
import { cameraPose, selectAutoShot, smoothCameraHeading, type CameraShot } from "../lib/race-camera";
import "./race-circuit-3d.css";

type DriverId = "red" | "blue";
type View = "auto" | "overview" | DriverId;
type CircuitRace = {
  phase: string;
  updatedAt: number;
  now?: number;
  course: CourseFeatures & { length: number; obstacles: { id: string; progress: number; blockedLane: number; junctionId?: string; route?: RouteChoice }[] };
  players: Record<DriverId, { progress: number; lane: number; speed: number; slowedUntil: number; routeChoices?: Record<string, RouteChoice> }>;
};
export type RaceCircuit3DProps = { race: CircuitRace; decorative?: boolean; onUnavailable?: () => void; sampleRace?: (timestamp: number) => CircuitRace | undefined };
const DRIVERS: DriverId[] = ["red", "blue"];
const COLORS = { red: 0xff625b, blue: 0x5aa4ff };

/** Renders server-authoritative positions and routes; it does not simulate a second race. */
export function RaceCircuit3D({ race, decorative = false, onUnavailable, sampleRace }: RaceCircuit3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const shotLabelRef = useRef<HTMLSpanElement>(null);
  const labelsRef = useRef<Record<DriverId, HTMLDivElement | null>>({ red: null, blue: null });
  const latest = useRef(race); latest.current = race;
  const sampleRef = useRef(sampleRace); sampleRef.current = sampleRace;
  const unavailableRef = useRef(onUnavailable); unavailableRef.current = onUnavailable;
  const viewRef = useRef<View>(decorative ? "overview" : "auto");
  const [view, setView] = useState<View>(decorative ? "overview" : "auto");
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const courseKey = JSON.stringify(race.course);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false, lostContext = false;
    let frame = 0, previousFrame = 0, width = 1, height = 1;
    const abort = new AbortController();
    setStatus("loading");
    const fail = () => { if (!disposed) { setStatus("unavailable"); unavailableRef.current?.(); } };
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" }); }
    catch { fail(); return; }
    const maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    let pixelRatio = maxPixelRatio;
    renderer.setPixelRatio(pixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.28;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x17313d);
    scene.fog = new THREE.Fog(0x17313d, 185, 410);
    const roots = new Set<THREE.Object3D>([scene]);
    const camera = new THREE.PerspectiveCamera(62, 1, 0.15, 1000);
    const target = new THREE.Vector3(), eye = new THREE.Vector3(), projected = new THREE.Vector3();
    const group = new THREE.Group(); scene.add(group);
    const assets = new THREE.Group(); roots.add(assets);
    const course = latest.current.course, bounds = circuitBounds(course), complex = Boolean(course.layout);
    const material = (color: number, roughness = 0.8, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const asphalt = material(0x35444c), concrete = material(0x657b82), dark = material(0x172a34);
    const white = material(0xe3e9df), lime = material(0xd7ee8d), grass = material(0x315b53);
    const rail = material(0x4b6871, 0.5, 0.2), orange = material(0xffa64d), cyan = material(0x61ccd4);
    concrete.side = THREE.DoubleSide;
    // Seats, supports and buildings share one geometry and one draw per material.
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    assets.add(new THREE.Mesh(unitBox, dark));
    const boxBatches = new Map<string, { parent: THREE.Object3D; material: THREE.Material; matrices: THREE.Matrix4[] }>();
    const boxTransform = new THREE.Object3D();
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) => {
      const key = `${parent.uuid}:${mat.uuid}`;
      let batch = boxBatches.get(key);
      if (!batch) { batch = { parent, material: mat, matrices: [] }; boxBatches.set(key, batch); }
      boxTransform.position.set(x, y, z); boxTransform.scale.set(w, h, d); boxTransform.updateMatrix();
      batch.matrices.push(boxTransform.matrix.clone());
    };
    const textPlane = (text: string, textWidth: number, color: string, x: number, y: number, z: number, heading = 0) => {
      const bitmap = document.createElement("canvas"); bitmap.width = 1024; bitmap.height = 160;
      const context = bitmap.getContext("2d"); if (!context) return;
      context.font = "700 74px sans-serif"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillStyle = color; context.fillText(text, 512, 80);
      const texture = new THREE.CanvasTexture(bitmap); texture.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(textWidth, textWidth / 6.4), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
      mesh.rotation.set(-Math.PI / 2, 0, -heading); mesh.position.set(x, y, z); group.add(mesh);
    };
    box(bounds.width + 12, 1.5, bounds.depth + 12, dark, 0, -1.3, 0);
    box(bounds.width + 10, 0.12, bounds.depth + 10, grass, 0, -0.48, 0);

    type Section = { start: number; end: number; routes: Record<string, RouteChoice>; accent: THREE.Material };
    const sections: Section[] = [];
    let sectionStart = 0;
    for (const junction of course.junctions ?? []) {
      sections.push({ start: sectionStart, end: junction.start, routes: {}, accent: lime });
      for (const choice of ["left", "right"] as const) sections.push({ start: junction.start, end: junction.end, routes: { [junction.id]: choice }, accent: junction.routes[choice].speedMultiplier > 1 ? orange : cyan });
      sectionStart = junction.end;
    }
    sections.push({ start: sectionStart, end: course.length, routes: {}, accent: lime });
    const ribbon = (section: Section, inner: number, outer: number, elevation: number, mat: THREE.Material) => {
      const positions: number[] = [], indices: number[] = [];
      const segments = Math.max(8, Math.ceil((section.end - section.start) / course.length * (complex ? 850 : 400)));
      for (let i = 0; i <= segments; i++) {
        const progress = section.start + (section.end - section.start) * i / segments;
        for (const offset of [inner, outer]) {
          const p = circuitAtProgress(progress, offset, course.length, course, section.routes);
          positions.push(p.x, p.y + elevation, p.z);
        }
        if (i < segments) { const n = i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, mat); mesh.receiveShadow = true; mesh.castShadow = true; group.add(mesh);
    };
    const dashGeometry = new THREE.BoxGeometry(1.3, 0.025, 0.11), curbGeometry = new THREE.BoxGeometry(1.6, 0.15, 0.65), wallGeometry = new THREE.BoxGeometry(2.3, 0.65, 0.25);
    assets.add(new THREE.Mesh(dashGeometry, white), new THREE.Mesh(curbGeometry, lime), new THREE.Mesh(wallGeometry, rail));
    const instanceGroups = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] }>();
    const marker = (geometry: THREE.BufferGeometry, mat: THREE.Material, p: ReturnType<typeof circuitAtProgress>, height: number) => {
      const key = `${geometry.uuid}:${mat.uuid}`;
      let batch = instanceGroups.get(key);
      if (!batch) { batch = { geometry, material: mat, matrices: [] }; instanceGroups.set(key, batch); }
      const transform = new THREE.Object3D(); transform.position.set(p.x, p.y + height, p.z); transform.rotation.set(0, -p.heading, p.slope, "YXZ"); transform.updateMatrix(); batch.matrices.push(transform.matrix.clone());
    };
    for (const section of sections) {
      if (section.end <= section.start) continue;
      ribbon(section, -7.6, 7.6, -0.18, concrete);
      ribbon(section, -6.3, 6.3, 0.02, asphalt);
      ribbon(section, -6.32, -6.16, 0.065, white); ribbon(section, 6.16, 6.32, 0.065, white);
      const count = Math.max(2, Math.ceil((section.end - section.start) / course.length * (complex ? 300 : 145)));
      for (let i = 0; i < count; i++) {
        const progress = section.start + (section.end - section.start) * (i + 0.5) / count;
        if (i % 2 === 0) for (const offset of [-2.1, 2.1]) {
          const p = circuitAtProgress(progress, offset, course.length, course, section.routes);
          marker(dashGeometry, white, p, 0.08);
        }
        for (const offset of [-6.9, 6.9]) {
          const branch = Object.values(section.routes)[0];
          const amount = (progress - section.start) / (section.end - section.start);
          const inner = (branch === "left" && offset > 0) || (branch === "right" && offset < 0);
          if (branch && inner && (amount < 0.36 || amount > 0.64)) continue;
          const p = circuitAtProgress(progress, offset, course.length, course, section.routes);
          marker(curbGeometry, i % 2 ? dark : section.accent, p, 0.07);
        }
        // Continuous roadside markers close to the camera provide honest speed cues.
        if (i % 2 === 0) for (const offset of [-8.5, 8.5]) {
          const branch = Object.values(section.routes)[0];
          const amount = (progress - section.start) / (section.end - section.start);
          // Keep fork mouths and merges completely open; no intersecting guardrail tips.
          if (branch && (amount < 0.28 || amount > 0.72)) continue;
          const inner = (branch === "left" && offset > 0) || (branch === "right" && offset < 0);
          if (branch && inner && (amount < 0.36 || amount > 0.64)) continue;
          const p = circuitAtProgress(progress, offset, course.length, course, section.routes);
          marker(wallGeometry, i % 8 === 0 ? section.accent : rail, p, 0.3);
          if (p.y > 5 && i % 8 === 0 && Math.hypot(p.x, p.z) > 18) box(1.1, p.y, 1.1, concrete, p.x, p.y / 2 - 0.3, p.z);
        }
      }
    }
    for (const batch of instanceGroups.values()) {
      const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
      batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix)); mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true; mesh.castShadow = true; group.add(mesh);
    }
    for (const junction of course.junctions ?? []) for (const choice of ["left", "right"] as const) {
      const routes = { [junction.id]: choice }, progress = junction.start + (junction.end - junction.start) * 0.46;
      const p = circuitPosition(progress, 1, course.length, course, routes), route = junction.routes[choice];
      textPlane(route.name, 9, route.speedMultiplier > 1 ? "#ffd29c" : "#abf7f7", p.x, p.y + 0.1, p.z, p.heading);
    }
    const start = circuitPosition(0, 1, course.length, course);
    const gantry = new THREE.Group(); gantry.position.set(start.x, start.y, start.z); gantry.rotation.y = -start.heading; group.add(gantry);
    for (let row = 0; row < 2; row++) for (let tile = 0; tile < 12; tile++) box(0.75, 0.035, 1.05, (row + tile) % 2 ? dark : white, row * 0.75 - 0.375, 0.08, -5.775 + tile * 1.05, gantry);
    for (const z of [-8.3, 8.3]) box(0.45, 7.3, 0.45, rail, 0, 3.6, z, gantry);
    box(0.9, 0.8, 17.2, dark, 0, 7.1, 0, gantry); box(0.94, 0.1, 17.2, lime, 0, 7.56, 0, gantry);
    const lightMaterial = new THREE.MeshStandardMaterial({ color: 0xff5b4d, emissive: 0xff342d, emissiveIntensity: 1.5 });
    const startLights: THREE.Mesh[] = [];
    for (let i = 0; i < 5; i++) { const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), lightMaterial); lamp.position.set(0.51, 7, -2 + i); gantry.add(lamp); startLights.push(lamp); }

    // Scenery remains outside the course and fork envelopes.
    const standZ = complex ? 66 : -36;
    for (const standX of [-36, 12, 60]) {
      for (let step = 0; step < 4; step++) {
        box(32, 0.7 + step * 0.7, 2.2, concrete, standX, (0.7 + step * 0.7) / 2 - 0.2, standZ + step * 2);
        for (let seat = 0; seat < 14; seat++) box(1.5, 0.25, 0.85, (seat + step) % 4 === 0 ? lime : dark, standX - 14 + seat * 2.1, 0.65 + step * 0.7, standZ + step * 2);
      }
      for (const x of [standX - 15, standX + 15]) box(0.35, 7, 0.35, rail, x, 3.3, standZ + 7);
      box(34, 0.28, 9.5, dark, standX, 6.8, standZ + 3.7);
    }
    const treeGeometry = new THREE.ConeGeometry(1.5, 5, 7), treeMaterial = material(0x49856a); assets.add(new THREE.Mesh(treeGeometry, treeMaterial));
    const trees = new THREE.InstancedMesh(treeGeometry, treeMaterial, 32);
    const treeTransform = new THREE.Object3D();
    for (let i = 0; i < 32; i++) {
      const x = -bounds.width / 2 + 9 + i * (bounds.width - 18) / 31, z = -bounds.depth / 2 + 3 + Math.sin(i * 1.8) * 3;
      treeTransform.position.set(x, 2.15, z); treeTransform.updateMatrix(); trees.setMatrixAt(i, treeTransform.matrix);
    }
    trees.instanceMatrix.needsUpdate = true; trees.castShadow = true; group.add(trees);
    for (const batch of boxBatches.values()) {
      const mesh = new THREE.InstancedMesh(unitBox, batch.material, batch.matrices.length);
      batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = true; mesh.receiveShadow = true; batch.parent.add(mesh);
    }
    textPlane(complex ? COURSE_NAMES[course.layout!] : "AGENT GRAND PRIX", 38, "#b5d4c4", 0, -0.35, complex ? -62 : 0);
    scene.add(new THREE.HemisphereLight(0xc5e9ff, 0x354936, 2.3));
    const sun = new THREE.DirectionalLight(0xfff1d4, 3.4); sun.position.set(-45, 115, 60); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -145, right: 145, top: 110, bottom: -110, near: 1, far: 250 }); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05; scene.add(sun);
    const fill = new THREE.DirectionalLight(0x87baff, 1.1); fill.position.set(25, 35, -45); scene.add(fill);

    const cars: Partial<Record<DriverId, THREE.Group>> = {}, auras: Partial<Record<DriverId, THREE.Mesh>> = {};
    const gates = new THREE.Group(); group.add(gates);
    const barrierGeometry = new THREE.BoxGeometry(0.7, 1.1, 3.5); assets.add(new THREE.Mesh(barrierGeometry, orange));
    let barrierModel: THREE.Group | undefined;
    const refreshGates = () => {
      gates.clear();
      for (const obstacle of course.obstacles) {
        const routes = obstacle.junctionId && obstacle.route ? { [obstacle.junctionId]: obstacle.route } : {};
        const p = circuitPosition(obstacle.progress, obstacle.blockedLane, course.length, course, routes);
        const gate = new THREE.Group(); gate.position.set(p.x, p.y + 0.05, p.z); gate.rotation.set(0, -p.heading, p.slope, "YXZ");
        if (barrierModel) { const model = barrierModel.clone(true); model.rotation.y = Math.PI / 2; model.scale.setScalar(1.55); gate.add(model); }
        else { const mesh = new THREE.Mesh(barrierGeometry, orange); mesh.position.y = 0.55; mesh.castShadow = true; gate.add(mesh); }
        gates.add(gate);
      }
    };
    refreshGates();
    const loader = new GLTFLoader();
    const loadModel = async (url: string) => {
      const response = await fetch(url, { signal: abort.signal }); if (!response.ok) throw new Error(`Model unavailable: ${response.status}`);
      const buffer = await response.arrayBuffer(); if (disposed) throw new Error("Scene disposed");
      const gltf = await loader.parseAsync(buffer, url.slice(0, url.lastIndexOf("/") + 1));
      if (disposed) { disposeRoots([gltf.scene]); throw new Error("Scene disposed"); }
      roots.add(gltf.scene); gltf.scene.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } }); return gltf.scene;
    };
    void Promise.all(DRIVERS.map(async id => {
      const model = await loadModel(`/models/tesla-roadster/roadster_${id === "red" ? "02_red" : "03_blue"}.glb`); if (disposed) return;
      const car = new THREE.Group(); car.add(model); group.add(car); cars[id] = car;
      const glow = new THREE.Mesh(new THREE.RingGeometry(1.8, 1.94, 40), new THREE.MeshBasicMaterial({ color: COLORS[id], transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })); glow.rotation.x = -Math.PI / 2; group.add(glow); auras[id] = glow;
    })).then(() => { if (!disposed) setStatus("ready"); }).catch(() => { if (!disposed) fail(); });
    void loadModel("/roadster-circuit/props/water_barrier.glb").then(model => { if (!disposed) { barrierModel = model; refreshGates(); } }).catch(() => {});

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)"); let reducedMotion = motionPreference.matches;
    const onMotionPreference = () => { reducedMotion = motionPreference.matches; activeKey = ""; }; motionPreference.addEventListener("change", onMotionPreference);
    let previousView: View | undefined, previousPhase = "", directorSeconds = 0, activeKey = "", cameraReady = false;
    let activeShot: CameraShot = { key: "grid", kind: "grid", label: "STARTING GRID" };
    const trackingHeadings = [NaN, NaN];
    const resize = () => { const rect = canvas.getBoundingClientRect(); width = Math.max(1, rect.width); height = Math.max(1, rect.height); renderer.setSize(width, height, false); };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const handleContextLost = (event: Event) => { event.preventDefault(); lostContext = true; cancelAnimationFrame(frame); fail(); }; canvas.addEventListener("webglcontextlost", handleContextLost);
    let measureStart = 0, intervals: number[] = [], slowWindows = 0, fastWindows = 0;
    const draw = (timestamp: number) => {
      if (disposed || lostContext) return;
      frame = requestAnimationFrame(draw);
      if (document.hidden) { previousFrame = 0; intervals = []; measureStart = 0; return; }
      const interval = previousFrame ? timestamp - previousFrame : 0;
      const dt = Math.min(interval / 1000, 0.1); previousFrame = timestamp;
      // Consume buffered authoritative positions at display cadence. React only
      // handles controls and network snapshots, never the animation clock.
      const current = sampleRef.current?.(timestamp) ?? latest.current;
      const positions = DRIVERS.map(id => ({ ...circuitPosition(current.players[id].progress, current.players[id].lane, course.length, course, current.players[id].routeChoices), speed: current.players[id].speed }));
      DRIVERS.forEach((id, index) => {
        const p = positions[index], car = cars[id], player = current.players[id];
        if (car) { car.position.set(p.x, p.y + 0.08, p.z); car.rotation.set(0, Math.PI - p.heading, -p.slope, "YXZ"); }
        const aura = auras[id];
        if (aura) { aura.position.set(p.x, p.y + 0.09, p.z); (aura.material as THREE.MeshBasicMaterial).opacity = current.phase === "racing" && player.slowedUntil > (current.now ?? current.updatedAt) ? 0.95 : 0.45; }
      });
      const selectedView = viewRef.current;
      if (previousPhase !== current.phase || previousView !== selectedView) { directorSeconds = 0; activeKey = ""; previousPhase = current.phase; previousView = selectedView; }
      directorSeconds += dt;
      let nextShot: CameraShot;
      if (selectedView === "auto" && !reducedMotion) nextShot = selectAutoShot(current.phase, directorSeconds, positions, DRIVERS.map(id => current.players[id].progress));
      else if (selectedView === "red" || selectedView === "blue") nextShot = { key: selectedView, kind: "chase", focus: selectedView === "red" ? 0 : 1, label: `${selectedView === "red" ? "SCARLET" : "COBALT"} 追従` };
      else nextShot = { key: "overview", kind: "overview", label: reducedMotion && selectedView === "auto" ? "コース全体 · 動きを抑制" : "コース全体" };
      // Keep a battle shot stable for its slot even as cars change order or separate.
      const inBattleSlot = current.phase === "racing" && directorSeconds % 40 >= 15 && directorSeconds % 40 < 22;
      if (inBattleSlot && activeKey.startsWith("battle:")) nextShot = activeShot;
      const key = `${inBattleSlot && selectedView === "auto" && !reducedMotion ? "battle:" : ""}${nextShot.key}`;
      if (activeKey !== key) {
        activeKey = key; activeShot = nextShot;
        if (stageRef.current) stageRef.current.dataset.cameraShot = activeShot.key;
        if (shotLabelRef.current) shotLabelRef.current.textContent = `${selectedView === "auto" ? "AUTO" : "MANUAL"} · ${activeShot.label}`;
      }
      const moving = !reducedMotion && current.phase === "racing";
      const cameraAnchors = positions.map((p, index) => {
        trackingHeadings[index] = reducedMotion ? p.heading : smoothCameraHeading(trackingHeadings[index], p.heading, dt);
        return { ...p, heading: trackingHeadings[index] };
      });
      const pose = cameraPose(activeShot, cameraAnchors, width / height, directorSeconds, moving, bounds);
      // Every frame stays relative to today's car position. World-space lerping can
      // cut through a car on a hairpin or aim between cars during a subject change.
      // Broadcast cuts change subjects; smooth heading and lens changes retain motion.
      eye.set(...pose.eye); target.set(...pose.target);
      camera.fov = !cameraReady || reducedMotion ? pose.fov : camera.fov + (pose.fov - camera.fov) * (1 - Math.exp(-dt * 5)); cameraReady = true;
      camera.aspect = width / height; camera.updateProjectionMatrix(); camera.position.copy(eye); camera.lookAt(target); camera.updateMatrixWorld();
      lightMaterial.color.set(current.phase === "racing" ? 0xb8f065 : 0xff5b4d); lightMaterial.emissive.copy(lightMaterial.color); startLights.forEach(lamp => { lamp.visible = current.phase === "countdown" || current.phase === "racing"; });
      const labelPoints = positions.map(p => projected.set(p.x, p.y + 2.8, p.z).project(camera).clone());
      const close = Math.abs((labelPoints[0].x - labelPoints[1].x) * width / 2) < 100 && Math.abs((labelPoints[0].y - labelPoints[1].y) * height / 2) < 40;
      DRIVERS.forEach((id, index) => {
        const label = labelsRef.current[id]; if (!label) return;
        const p = labelPoints[index], x = (p.x * 0.5 + 0.5) * width, y = (-p.y * 0.5 + 0.5) * height;
        label.style.visibility = cars[id] && p.z > -1 && p.z < 1 && x > 0 && x < width && y > 0 && y < height ? "visible" : "hidden";
        label.style.transform = `translate(${x}px, ${y - (close && index === 1 ? 33 : 0)}px) translate(-50%, -100%)`;
      });
      renderer.render(scene, camera);
      if (!measureStart) measureStart = timestamp;
      if (interval > 0) intervals.push(interval);
      if (timestamp - measureStart >= 2000 && intervals.length) {
        const sorted = [...intervals].sort((a, b) => a - b);
        const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
        const stage = stageRef.current;
        if (stage) {
          stage.dataset.renderFps = (1000 / mean).toFixed(1);
          stage.dataset.frameP50Ms = sorted[Math.floor(sorted.length * 0.5)].toFixed(1);
          stage.dataset.frameP95Ms = sorted[Math.floor(sorted.length * 0.95)].toFixed(1);
          stage.dataset.drawCalls = String(renderer.info.render.calls);
          stage.dataset.triangles = String(renderer.info.render.triangles);
          stage.dataset.pixelRatio = pixelRatio.toFixed(2);
        }
        // Hysteresis prevents resolution flicker; reduce fill-rate on slower GPUs.
        slowWindows = mean > 22 ? slowWindows + 1 : 0;
        fastWindows = mean < 17.5 ? fastWindows + 1 : 0;
        const nextRatio = slowWindows >= 3 ? Math.max(Math.min(1, maxPixelRatio), pixelRatio - 0.25)
          : fastWindows >= 6 ? Math.min(maxPixelRatio, pixelRatio + 0.25) : pixelRatio;
        if (nextRatio !== pixelRatio) { pixelRatio = nextRatio; renderer.setPixelRatio(pixelRatio); resize(); slowWindows = fastWindows = 0; }
        measureStart = timestamp; intervals = [];
      }
    };
    frame = requestAnimationFrame(draw);
    return () => { disposed = true; abort.abort(); cancelAnimationFrame(frame); observer.disconnect(); motionPreference.removeEventListener("change", onMotionPreference); canvas.removeEventListener("webglcontextlost", handleContextLost); sun.shadow.map?.dispose(); disposeRoots(roots); renderer.renderLists.dispose(); renderer.dispose(); };
  }, [courseKey]);

  const chooseView = (next: View) => { viewRef.current = next; setView(next); };
  return <div ref={stageRef} className={`race-circuit-3d${decorative ? " is-decorative" : ""}`} data-renderer="three-dimensional" data-scene-status={status} data-camera-mode={view}>
    <canvas ref={canvasRef} aria-label="赤と青のロードスターが分岐や立体交差を走る3Dレースコース" role="img" />
    <div className="circuit-3d-topline"><span><i />{race.course.layout ? COURSE_NAMES[race.course.layout] : "TOKYO CIRCUIT"} <b>3D</b></span><small>{race.course.junctions?.length ? "2 FORKS · CROSSOVER · 1 LAP" : "3 LANES · 1 LAP"}</small></div>
    {DRIVERS.map(id => <div key={id} ref={element => { labelsRef.current[id] = element; }} className={`circuit-3d-car-label is-${id}`}><i />{id === "red" ? "SCARLET" : "COBALT"}</div>)}
    {status === "loading" && <div className="circuit-3d-loading" role="status"><i />3Dサーキットを準備しています</div>}
    {status === "unavailable" && <div className="circuit-3d-unavailable" role="status">3D表示を読み込めませんでした。ページを再読み込みしてください。</div>}
    {!decorative && <div className="circuit-3d-cameras" role="group" aria-label="観戦カメラ"><span>CAMERA</span><button type="button" className="auto-camera" aria-pressed={view === "auto"} onClick={() => chooseView("auto")}>自動</button><button type="button" aria-pressed={view === "overview"} onClick={() => chooseView("overview")}>コース全体</button><button type="button" className="red-camera" aria-pressed={view === "red"} onClick={() => chooseView("red")}>SCARLET</button><button type="button" className="blue-camera" aria-pressed={view === "blue"} onClick={() => chooseView("blue")}>COBALT</button></div>}
    <div className="circuit-3d-caption"><span ref={shotLabelRef}>{view === "auto" ? "AUTO · STARTING GRID" : "MANUAL · コース全体"}</span><small>LIVE POSITIONS · LIVE ROUTES</small></div>
  </div>;
}

/** Dispose shared cloned meshes exactly once, including texture-backed canvas labels. */
function disposeRoots(roots: Iterable<THREE.Object3D>) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  const instances = new Set<THREE.InstancedMesh>();
  for (const root of roots) root.traverse(object => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line)) return;
    if (object instanceof THREE.InstancedMesh) instances.add(object);
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) { materials.add(material); for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value); }
  });
  instances.forEach(instance => instance.dispose());
  geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
  textures.forEach(texture => { const image = texture.image; texture.dispose(); if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close(); });
}
