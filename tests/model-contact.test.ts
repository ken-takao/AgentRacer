import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { modelGroundingOffset, modelSupportPoints, roadModelSupport, surfaceFrame } from "../lib/model-contact.ts";
import { circuitAtProgress, circuitSurfaceFrame } from "../lib/circuit-geometry.ts";
import { createCourseFeatures, type CourseLayout } from "../lib/race-course.ts";

const near = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`);
const vector = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.y, v.z);

test("grounding is measured per asset, preserving its size and centering its footprint", () => {
  assert.deepEqual(modelGroundingOffset({ min: { x: -2, y: -3, z: 4 }, max: { x: 6, y: 9, z: 8 } }), { x: -2, y: 3, z: -6 });
  assert.throws(() => modelGroundingOffset({ min: { x: 0, y: Infinity, z: 0 }, max: { x: 1, y: 2, z: 3 } }), RangeError);
  assert.throws(() => modelGroundingOffset({ min: { x: 0, y: 3, z: 0 }, max: { x: 1, y: 2, z: 3 } }), RangeError);
});

test("banked/sloped road frames and spin remain orthonormal around the road normal", () => {
  for (const heading of [-Math.PI, -.8, 0, 1.7, Math.PI]) for (const slope of [-.45, 0, .38]) for (const spin of [0, .4, Math.PI / 2, Math.PI, Math.PI * 5.7]) {
    const frame = surfaceFrame({ heading, slope }, spin);
    const x = vector(frame.forward), y = vector(frame.normal), z = vector(frame.right);
    near(x.length(), 1, "unit forward"); near(y.length(), 1, "unit normal"); near(z.length(), 1, "unit right");
    near(x.dot(y), 0, "forward tangent to road"); near(z.dot(y), 0, "right tangent to road");
    near(x.clone().cross(y).distanceTo(z), 0, "right-handed basis");
    const original = surfaceFrame({ heading, slope });
    near(y.distanceTo(vector(original.normal)), 0, "spin preserves road normal");
  }
  const frame = surfaceFrame({ heading: 0, slope: 0, normal: { x: 0, y: 2, z: 1 }, forward: { x: 2, y: .1, z: 0 } });
  near(vector(frame.forward).dot(vector(frame.normal)), 0, "exact ribbon normal overrides horizontal fallback");
  assert.throws(() => surfaceFrame({ heading: NaN, slope: 0 }), RangeError);
  assert.throws(() => surfaceFrame({ heading: 0, slope: 0, normal: { x: 0, y: 0, z: 0 } }), RangeError);
});

test("both actual Roadsters and every obstacle GLB rest on the road plane, including during slope spins", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/roadster-circuit/props/manifest.json", import.meta.url), "utf8")) as { kind: string; glb: string }[];
  const files = [
    { file: "models/tesla-roadster/roadster_02_red.glb", prop: false },
    { file: "models/tesla-roadster/roadster_03_blue.glb", prop: false },
    ...manifest.filter(asset => asset.kind === "obstacle").map(asset => ({ file: `roadster-circuit/props/${asset.glb}`, prop: true })),
  ];
  const measuredBottoms = new Set<number>();
  for (const { file, prop } of files) {
    const bytes = await readFile(new URL(`../public/${file}`, import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const { scene: model } = await new GLTFLoader().parseAsync(buffer, "");
    if (prop) { model.scale.setScalar(1.55); model.rotation.y = Math.PI / 2; }
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model, true);
    const originalSize = bounds.getSize(new THREE.Vector3());
    measuredBottoms.add(Math.round(bounds.min.y * 1e6));
    model.position.add(vector(modelGroundingOffset(bounds)));
    model.updateMatrixWorld(true);
    const grounded = new THREE.Box3().setFromObject(model, true);
    near(grounded.min.y, 0, `${file} local bottom`);
    near(grounded.getCenter(new THREE.Vector3()).x, 0, `${file} footprint X`);
    near(grounded.getCenter(new THREE.Vector3()).z, 0, `${file} footprint Z`);
    near(grounded.getSize(new THREE.Vector3()).distanceTo(originalSize), 0, `${file} scale unchanged`);
    const vertices: THREE.Vector3[] = [];
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const attribute = object.geometry.getAttribute("position");
      for (let i = 0; i < attribute.count; i++) vertices.push(new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld));
    });
    assert.ok(vertices.length > 0, `${file} has measurable mesh vertices`);
    for (const slope of [-.35, 0, .45]) for (const yawOffset of [prop ? 0 : Math.PI, 1.2, 4.7]) {
      const frame = surfaceFrame({ heading: .74, slope }, yawOffset);
      const matrix = new THREE.Matrix4().makeBasis(vector(frame.forward), vector(frame.normal), vector(frame.right));
      const roadPosition = new THREE.Vector3(30, 14.02, -21);
      matrix.setPosition(roadPosition);
      const normal = vector(frame.normal);
      let nearest = Infinity;
      for (const local of vertices) {
        const distance = local.clone().applyMatrix4(matrix).sub(roadPosition).dot(normal);
        assert.ok(distance >= -1e-6, `${file} vertex cannot bury into sloped road: ${distance}`);
        nearest = Math.min(nearest, distance);
      }
      near(nearest, 0, `${file} lowest geometry contacts sloped road`);
      if (!prop && yawOffset === Math.PI) {
        const authoredNose = new THREE.Vector3(-1, 0, 0).transformDirection(matrix);
        const forward = vector(surfaceFrame({ heading: .74, slope }).forward);
        near(authoredNose.distanceTo(forward), 0, `${file} nose follows increasing progress`);
      }
    }
  }
  assert.ok(measuredBottoms.size >= 6, "the real assets have different origins, so a shared height offset cannot ground them");
});

test("curved-road support comes from the local surface and preserves flat-road height", () => {
  const base = { progress: 50, offset: 0, length: 200, point: { x: 50, y: 0, z: 0 }, frame: surfaceFrame({ heading: 0, slope: 0 }), supportPoints: [{ x: -2, y: 0, z: -1 }, { x: 2, y: 0, z: 1 }] };
  near(roadModelSupport({ ...base, sampleSurface: (p, o) => ({ x: p, y: 0, z: o }) }), 0, "flat road needs no arbitrary lift");
  near(roadModelSupport({ ...base, sampleSurface: (p, o) => ({ x: p, y: (p - 50) ** 2 * .005, z: o }) }), .02, "curvature-derived clearance");
  assert.equal(modelSupportPoints([]).length, 0);
});

test("rigid Roadster and obstacle support matches every fork and crossover surface", async (t) => {
  const manifest = JSON.parse(await readFile(new URL("../public/roadster-circuit/props/manifest.json", import.meta.url), "utf8")) as { kind: string; glb: string }[];
  const files = ["models/tesla-roadster/roadster_02_red.glb", "models/tesla-roadster/roadster_03_blue.glb", ...manifest.filter(a => a.kind === "obstacle").map(a => `roadster-circuit/props/${a.glb}`)];
  let checkedPlacements = 0, maximumLift = 0, maximumResidual = 0;
  for (const file of files) {
    const bytes = await readFile(new URL(`../public/${file}`, import.meta.url));
    const { scene: model } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    const prop = file.includes("/props/");
    if (prop) { model.scale.setScalar(1.55); model.rotation.y = Math.PI / 2; }
    model.position.add(vector(modelGroundingOffset(new THREE.Box3().setFromObject(model, true))));
    model.updateMatrixWorld(true);
    const unique = new Map<string, THREE.Vector3>();
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const attribute = object.geometry.getAttribute("position");
      for (let i = 0; i < attribute.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld);
        unique.set(`${v.x}:${v.y}:${v.z}`, v);
      }
    });
    const vertices = [...unique.values()], supportPoints = modelSupportPoints(vertices);
    assert.ok(supportPoints.length > 0 && supportPoints.length < vertices.length, `${file} caches a compact support envelope`);
    for (const layout of ["harbor", "alpine", "metro"] as CourseLayout[]) {
      const course = { ...createCourseFeatures("model-contact-regression", 200), layout };
      for (const junction of course.junctions) for (const route of ["left", "right"] as const) {
        const routes = { [junction.id]: route };
        const sampleSurface = (p: number, o: number) => circuitAtProgress(p, o, 200, course, routes);
        const stations = [junction.start - .25, junction.start, junction.start + .25, (junction.start + junction.end) / 2, junction.end - .25, junction.end, junction.end + .25, 32, 136];
        for (const progress of stations) for (const offset of [-4.2, 0, 4.2]) {
          const point = sampleSurface(progress, offset);
          const frame = surfaceFrame({ ...point, ...circuitSurfaceFrame(progress, offset, 200, course, routes) }, prop ? 0 : Math.PI);
          const input = { progress, offset, length: 200, point, frame, sampleSurface, supportPoints };
          const lift = roadModelSupport(input);
          assert.ok(Number.isFinite(lift) && lift >= 0 && lift < .12, `${file}, ${layout}/${junction.id}/${route}/${progress}/${offset}: bounded local support ${lift}`);
          const supportedPoint = { x: point.x + frame.normal.x * lift, y: point.y + frame.normal.y * lift, z: point.z + frame.normal.z * lift };
          const remaining = roadModelSupport({ ...input, point: supportedPoint, supportPoints: vertices });
          assert.ok(remaining < 1e-4, `${file}, ${layout}/${junction.id}/${route}/${progress}/${offset}: full-mesh residual below numerical tolerance, got ${remaining}`);
          checkedPlacements++; maximumLift = Math.max(maximumLift, lift); maximumResidual = Math.max(maximumResidual, remaining);
        }
      }
    }
  }
  t.diagnostic(`${checkedPlacements} asset placements; maximum normal lift ${maximumLift.toFixed(6)}, maximum full-mesh residual ${maximumResidual.toFixed(6)} world units`);
});
