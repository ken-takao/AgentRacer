"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CIRCUIT_3D, CIRCUIT_ROAD_SURFACE, circuitAtProgress, circuitBounds, circuitPosition, circuitRoadEdges, circuitEdgeExposed, circuitSurfaceFrame } from "../lib/circuit-geometry";
import { COURSE_NAMES, selectedRoute, type CourseFeatures, type RouteChoice } from "../lib/race-course";
import { cameraPose, selectAutoShot, smoothCameraHeading, type CameraShot } from "../lib/race-camera";
import { getObstacleAsset } from "../lib/obstacle-catalog";
import { raceEffectsAt, type RaceEffectState } from "../lib/race-effects";
import { modelGroundingOffset, modelSupportPoints, roadModelSupport, surfaceFrame, type ContactVector } from "../lib/model-contact";
import { RaceRouteStatus } from "./race-route-status";
import "./race-circuit-3d.css";

type DriverId = "red" | "blue";
type View = "auto" | "overview" | DriverId;
type CircuitRace = {
  phase: string;
  updatedAt: number;
  now?: number;
  course: CourseFeatures & { length: number; obstacles: { id: string; progress: number; blockedLane: number; junctionId?: string; route?: RouteChoice; assetId?: string }[] };
  players: Record<DriverId, RaceEffectState & { progress: number; lane: number; speed: number; slowedUntil: number; routeChoices?: Record<string, RouteChoice> }>;
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
  const effectLabelsRef = useRef<Record<DriverId, HTMLSpanElement | null>>({ red: null, blue: null });
  const latest = useRef(race); latest.current = race;
  const sampleRef = useRef(sampleRace); sampleRef.current = sampleRace;
  const unavailableRef = useRef(onUnavailable); unavailableRef.current = onUnavailable;
  const viewRef = useRef<View>(decorative ? "overview" : "auto");
  const [view, setView] = useState<View>(decorative ? "overview" : "auto");
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  // Runtime placements update only their scene nodes, preserving camera state,
  // loaded Roadsters and GPU resources for the unchanged circuit geometry.
  const { obstacles: _obstacles, ...geometry } = race.course;
  const courseKey = JSON.stringify(geometry);

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
    renderer.shadowMap.type = THREE.PCFShadowMap;
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
    const poseBasis = new THREE.Matrix4();
    const basisX = new THREE.Vector3(), basisY = new THREE.Vector3(), basisZ = new THREE.Vector3();
    const orient = (object: THREE.Object3D, point: ReturnType<typeof circuitAtProgress>, exact: ReturnType<typeof circuitSurfaceFrame>, yaw = 0) => {
      const basis = surfaceFrame({ ...point, ...exact }, yaw);
      basisX.set(basis.forward.x, basis.forward.y, basis.forward.z);
      basisY.set(basis.normal.x, basis.normal.y, basis.normal.z);
      basisZ.set(basis.right.x, basis.right.y, basis.right.z);
      poseBasis.makeBasis(basisX, basisY, basisZ); object.quaternion.setFromRotationMatrix(poseBasis);
      return basis;
    };
    const assetSupport = new WeakMap<THREE.Object3D, ContactVector[]>();
    const carSupport: Partial<Record<DriverId, ContactVector[]>> = {};
    const groundAsset = (model: THREE.Group, scale = 1, yaw = 0) => {
      const normalized = new THREE.Group(); model.scale.setScalar(scale); model.rotation.y = yaw; normalized.add(model);
      normalized.updateMatrixWorld(true);
      const adjustment = modelGroundingOffset(new THREE.Box3().setFromObject(normalized, true));
      model.position.add(new THREE.Vector3(adjustment.x, adjustment.y, adjustment.z));
      normalized.updateMatrixWorld(true);
      const vertices: ContactVector[] = [], vertex = new THREE.Vector3();
      normalized.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const positions = object.geometry.getAttribute("position");
        for (let i = 0; i < positions.count; i++) {
          vertex.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
          vertices.push({ x: vertex.x, y: vertex.y, z: vertex.z });
        }
      });
      assetSupport.set(normalized, modelSupportPoints(vertices));
      return normalized;
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
    const ribbon = (section: Section, inner: number, outer: number, elevation: number, mat: THREE.Material, clipWidth = 6.3) => {
      const positions: number[] = [], indices: number[] = [];
      const segments = Math.max(8, Math.ceil((section.end - section.start) / course.length * (complex ? 850 : 400)));
      for (let i = 0; i <= segments; i++) {
        const progress = section.start + (section.end - section.start) * i / segments;
        const edges = circuitRoadEdges(progress, clipWidth, course.length, course, section.routes);
        for (const rawOffset of [inner, outer]) {
          const offset = Math.max(edges[0], Math.min(edges[1], rawOffset));
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
    const marker = (geometry: THREE.BufferGeometry, mat: THREE.Material, p: ReturnType<typeof circuitAtProgress>, height: number, progress: number, offset: number, routes: Record<string, RouteChoice>) => {
      const key = `${geometry.uuid}:${mat.uuid}`;
      let batch = instanceGroups.get(key);
      if (!batch) { batch = { geometry, material: mat, matrices: [] }; instanceGroups.set(key, batch); }
      const transform = new THREE.Object3D(); transform.position.set(p.x, p.y + height, p.z); orient(transform, p, circuitSurfaceFrame(progress, offset, course.length, course, routes)); transform.updateMatrix(); batch.matrices.push(transform.matrix.clone());
    };
    for (const section of sections) {
      if (section.end <= section.start) continue;
      ribbon(section, -7.6, 7.6, -0.18, concrete, 7.6);
      ribbon(section, -6.3, 6.3, CIRCUIT_ROAD_SURFACE, asphalt);
      ribbon(section, -6.32, -6.16, 0.065, white); ribbon(section, 6.16, 6.32, 0.065, white);
      const count = Math.max(2, Math.ceil((section.end - section.start) / course.length * (complex ? 300 : 145)));
      for (let i = 0; i < count; i++) {
        const progress = section.start + (section.end - section.start) * (i + 0.5) / count;
        if (i % 2 === 0) for (const offset of [-2.1, 2.1]) {
          const p = circuitAtProgress(progress, offset, course.length, course, section.routes);
          const edges = circuitRoadEdges(progress, 6.3, course.length, course, section.routes);
          if (offset > edges[0] + .15 && offset < edges[1] - .15) marker(dashGeometry, white, p, 0.08, progress, offset, section.routes);
        }
        for (const offset of [-6.9, 6.9]) {
          if (!circuitEdgeExposed(progress, offset, course.length, course, section.routes, Math.hypot(.8, .325))) continue;
          const p = circuitAtProgress(progress, offset, course.length, course, section.routes);
          marker(curbGeometry, i % 2 ? dark : section.accent, p, 0.10, progress, offset, section.routes);
        }
        // Continuous roadside markers close to the camera provide honest speed cues.
        if (i % 2 === 0) for (const offset of [-8.5, 8.5]) {
          if (!circuitEdgeExposed(progress, offset, course.length, course, section.routes, Math.hypot(1.15, .125))) continue;
          const p = circuitAtProgress(progress, offset, course.length, course, section.routes);
          marker(wallGeometry, i % 8 === 0 ? section.accent : rail, p, 0.35, progress, offset, section.routes);
          if (p.y > 5 && i % 8 === 0 && Math.hypot(p.x, p.z) > 18) box(1.1, p.y, 1.1, concrete, p.x, p.y / 2 - 0.3, p.z);
        }
      }
    }
    for (const batch of instanceGroups.values()) {
      const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
      batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix)); mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true; mesh.castShadow = true; group.add(mesh);
    }
    const highlights: { driver: DriverId; junctionId: string; route: RouteChoice; group: THREE.Group }[] = [];
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(-1.2, -.45); arrowShape.lineTo(.2, -.45); arrowShape.lineTo(.2, -.95); arrowShape.lineTo(1.5, 0); arrowShape.lineTo(.2, .95); arrowShape.lineTo(.2, .45); arrowShape.lineTo(-1.2, .45); arrowShape.closePath();
    const arrowGeometry = new THREE.ShapeGeometry(arrowShape); arrowGeometry.rotateX(-Math.PI / 2); assets.add(new THREE.Mesh(arrowGeometry, white));
    for (const junction of course.junctions ?? []) for (const choice of ["left", "right"] as const) {
      const routes = { [junction.id]: choice }, length = junction.end - junction.start;
      const route = junction.routes[choice];
      for (const fraction of [.3, .7]) {
        const progress = junction.start + length * fraction;
        const p = circuitPosition(progress, 1, course.length, course, routes);
        const bitmap = document.createElement("canvas"); bitmap.width = 1024; bitmap.height = 256;
        const context = bitmap.getContext("2d")!;
        context.textAlign = "center"; context.fillStyle = choice === "left" ? "#ffdda5" : "#c1f7f7";
        context.font = "bold 105px sans-serif"; context.fillText(choice === "left" ? "LEFT / 左ルート" : "RIGHT / 右ルート", 512, 115);
        context.font = "bold 68px sans-serif"; context.fillText(route.name, 512, 215);
        const texture = new THREE.CanvasTexture(bitmap); texture.colorSpace = THREE.SRGBColorSpace;
        const label = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
        label.geometry.rotateX(-Math.PI / 2); label.geometry.rotateY(-Math.PI / 2);
        orient(label, p, circuitSurfaceFrame(progress, 0, course.length, course, routes)); label.position.set(p.x, p.y + .05, p.z); group.add(label);
      }
      for (const id of DRIVERS) {
        const routeGroup = new THREE.Group(); group.add(routeGroup); highlights.push({ driver: id, junctionId: junction.id, route: choice, group: routeGroup });
        const arrowMaterial = new THREE.MeshBasicMaterial({ color: COLORS[id], side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
        for (let fraction = .08; fraction < .95; fraction += .1) {
          const progress = junction.start + length * fraction, offset = id === "red" ? -.85 : .85;
          const p = circuitAtProgress(progress, offset, course.length, course, routes);
          const arrow = new THREE.Mesh(arrowGeometry, arrowMaterial);
          orient(arrow, p, circuitSurfaceFrame(progress, offset, course.length, course, routes)); arrow.position.set(p.x, p.y + .065, p.z); routeGroup.add(arrow);
        }
      }
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
    textPlane(complex ? COURSE_NAMES[course.layout!] : "AgentRacer", 38, "#b5d4c4", 0, -0.35, complex ? -62 : 0);
    scene.add(new THREE.HemisphereLight(0xc5e9ff, 0x354936, 2.3));
    const sun = new THREE.DirectionalLight(0xfff1d4, 3.4); sun.position.set(-45, 115, 60); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -145, right: 145, top: 110, bottom: -110, near: 1, far: 250 }); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05; scene.add(sun);
    const fill = new THREE.DirectionalLight(0x87baff, 1.1); fill.position.set(25, 35, -45); scene.add(fill);

    const cars: Partial<Record<DriverId, THREE.Group>> = {}, auras: Partial<Record<DriverId, THREE.Mesh>> = {}, jets: Partial<Record<DriverId, THREE.Group>> = {};
    const gates = new THREE.Group(); group.add(gates);
    const barrierGeometry = new THREE.BoxGeometry(0.7, 1.1, 3.5); assets.add(new THREE.Mesh(barrierGeometry, orange));
    const loader = new GLTFLoader();
    const loadModel = async (url: string) => {
      const response = await fetch(url, { signal: abort.signal }); if (!response.ok) throw new Error(`Model unavailable: ${response.status}`);
      const buffer = await response.arrayBuffer(); if (disposed) throw new Error("Scene disposed");
      const gltf = await loader.parseAsync(buffer, url.slice(0, url.lastIndexOf("/") + 1));
      if (disposed) { disposeRoots([gltf.scene]); throw new Error("Scene disposed"); }
      roots.add(gltf.scene); gltf.scene.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } }); return gltf.scene;
    };
    const propModels = new Map<string, THREE.Group>();
    const loadingProps = new Set<string>();
    const obstacleNodes = new Map<string, { signature: string; node: THREE.Group; assetId: string; loaded: boolean }>();
    let obstacleSignature = "";
    let obstacleInput: CircuitRace["course"]["obstacles"] | undefined;
    const reconcileObstacles = (obstacles: CircuitRace["course"]["obstacles"]) => {
      if (obstacleInput === obstacles && obstacleSignature) return;
      obstacleInput = obstacles;
      const signature = JSON.stringify(obstacles);
      if (signature === obstacleSignature) return;
      obstacleSignature = signature;
      const wanted = new Set(obstacles.map(o => o.id));
      for (const [id, entry] of obstacleNodes) if (!wanted.has(id)) { gates.remove(entry.node); obstacleNodes.delete(id); }
      for (const obstacle of obstacles) {
        const asset = getObstacleAsset(obstacle.assetId) ?? getObstacleAsset("water_barrier")!;
        const model = propModels.get(asset.id), spec = JSON.stringify(obstacle);
        const existing = obstacleNodes.get(obstacle.id);
        if (existing?.signature === spec && existing.loaded === Boolean(model)) continue;
        if (existing) gates.remove(existing.node);
        const routes = obstacle.junctionId && obstacle.route ? { [obstacle.junctionId]: obstacle.route } : {};
        const p = circuitPosition(obstacle.progress, obstacle.blockedLane, course.length, course, routes);
        const offset = (obstacle.blockedLane - 1) * CIRCUIT_3D.laneWidth;
        const gate = new THREE.Group();
        const basis = orient(gate, p, circuitSurfaceFrame(obstacle.progress, offset, course.length, course, routes));
        const lift = model ? roadModelSupport({ progress: obstacle.progress, offset, length: course.length, point: p, frame: basis, supportPoints: assetSupport.get(model) ?? [], sampleSurface: (progress, lateral) => circuitAtProgress(progress, lateral, course.length, course, routes) }) : 0;
        gate.position.set(p.x + basis.normal.x * lift, p.y + CIRCUIT_ROAD_SURFACE + basis.normal.y * lift, p.z + basis.normal.z * lift);
        if (model) {
          const prop = model.clone(true);
          gate.add(prop);
        } else { const mesh = new THREE.Mesh(barrierGeometry, orange); mesh.position.y = 0.55; mesh.castShadow = true; gate.add(mesh); }
        gates.add(gate); obstacleNodes.set(obstacle.id, { signature: spec, node: gate, assetId: asset.id, loaded: Boolean(model) });
        if (!model && !loadingProps.has(asset.id)) {
          loadingProps.add(asset.id);
          void loadModel(asset.glbUrl).then(loaded => {
            if (disposed) return;
            propModels.set(asset.id, groundAsset(loaded, 1.55, Math.PI / 2));
            // Invalidate only prop reconciliation, never the static scene.
            obstacleSignature = "";
          }).catch(() => { /* Keep the visible collision marker if a prop cannot load. */ });
        }
      }
      if (stageRef.current) stageRef.current.dataset.obstacleCount = String(obstacleNodes.size);
    };
    reconcileObstacles(course.obstacles);
    const jetGeometry = new THREE.ConeGeometry(0.3, 1.3, 8, 1, true);
    const jetMaterial = new THREE.MeshBasicMaterial({ color: 0xb5f5ff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    assets.add(new THREE.Mesh(jetGeometry, jetMaterial));
    void Promise.all(DRIVERS.map(async id => {
      const model = await loadModel(`/models/tesla-roadster/roadster_${id === "red" ? "02_red" : "03_blue"}.glb`); if (disposed) return;
      const car = new THREE.Group(), normalized = groundAsset(model); car.add(normalized); carSupport[id] = assetSupport.get(normalized); group.add(car); cars[id] = car;
      const exhaust = new THREE.Group();
      for (const [x, z] of [[-.75, -1.15], [.75, -1.15], [-.75, 1.15], [.75, 1.15]]) {
        const jet = new THREE.Mesh(jetGeometry, jetMaterial); jet.position.set(x, -.55, z); exhaust.add(jet);
      }
      exhaust.visible = false; car.add(exhaust); jets[id] = exhaust;
      const glow = new THREE.Mesh(new THREE.RingGeometry(1.8, 1.94, 40), new THREE.MeshBasicMaterial({ color: COLORS[id], transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })); glow.rotation.x = -Math.PI / 2; group.add(glow); auras[id] = glow;
    })).then(() => { if (!disposed) setStatus("ready"); }).catch(() => { if (!disposed) fail(); });

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
      reconcileObstacles(current.course.obstacles);
      for (const highlight of highlights) {
        const junction = course.junctions!.find(j => j.id === highlight.junctionId)!;
        highlight.group.visible = selectedRoute(junction, current.players[highlight.driver]) === highlight.route;
      }
      const now = current.now ?? current.updatedAt;
      const effects = DRIVERS.map(id => raceEffectsAt(current.players[id], now, current.phase));
      const positions = DRIVERS.map((id, index) => {
        const ground = circuitPosition(current.players[id].progress, current.players[id].lane, course.length, course, current.players[id].routeChoices);
        return { ...ground, y: ground.y + effects[index].height, speed: effects[index].spinning ? 0 : current.players[id].speed };
      });
      DRIVERS.forEach((id, index) => {
        const p = positions[index], car = cars[id], player = current.players[id], effect = effects[index];
        if (car) {
          const offset = (player.lane - 1) * CIRCUIT_3D.laneWidth;
          const basis = orient(car, p, circuitSurfaceFrame(player.progress, offset, course.length, course, player.routeChoices), Math.PI + effect.spinRadians);
          const lift = roadModelSupport({ progress: player.progress, offset, length: course.length, point: { ...p, y: p.y - effect.height }, frame: basis, supportPoints: carSupport[id] ?? [], sampleSurface: (progress, lateral) => circuitAtProgress(progress, lateral, course.length, course, player.routeChoices) });
          car.position.set(p.x + basis.normal.x * lift, p.y + CIRCUIT_ROAD_SURFACE + basis.normal.y * lift, p.z + basis.normal.z * lift);
        }
        const exhaust = jets[id];
        if (exhaust) { exhaust.visible = effect.airborne; exhaust.scale.y = 0.8 + Math.sin(now * 0.075) * 0.15; }
        const aura = auras[id];
        if (aura) {
          aura.position.set(p.x, p.y - effect.height + 0.06, p.z);
          orient(aura, p, circuitSurfaceFrame(player.progress, (player.lane - 1) * CIRCUIT_3D.laneWidth, course.length, course, player.routeChoices));
          aura.rotateX(-Math.PI / 2);
          aura.scale.setScalar(effect.landing ? 1 + (1 - effect.landing) * 1.8 : effect.spinning ? 1.1 : 1);
          (aura.material as THREE.MeshBasicMaterial).opacity = effect.landing ? effect.landing : effect.spinning || effect.airborne || current.phase === "racing" && player.slowedUntil > now ? 0.95 : 0.45;
        }
        const effectLabel = effectLabelsRef.current[id];
        if (effectLabel) effectLabel.textContent = effect.spinning ? ` ↻ SPIN ${(effect.spinRemainingMs / 1000).toFixed(1)}s` : effect.airborne ? ` ↑ AIR ${(effect.jumpRemainingMs / 1000).toFixed(1)}s` : "";
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
    {!decorative && <div className="circuit-route-overlay"><RaceRouteStatus race={race} compact /></div>}
    {DRIVERS.map(id => <div key={id} ref={element => { labelsRef.current[id] = element; }} className={`circuit-3d-car-label is-${id}`}><i />{id === "red" ? "SCARLET" : "COBALT"}<span ref={element => { effectLabelsRef.current[id] = element; }} /></div>)}
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
