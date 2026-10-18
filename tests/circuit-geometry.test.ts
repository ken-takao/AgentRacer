import assert from 'node:assert/strict';
import { circuitPosition, circuitAtDistance, circuitAtProgress, CIRCUIT_3D, CIRCUIT_LAP_DISTANCE, circuitRoadEdges, circuitEdgeExposed, circuitSurfaceFrame } from '../lib/circuit-geometry.ts';
import { createCourseFeatures, type CourseLayout, type RouteChoice } from '../lib/race-course.ts';
const near = (a: number, b: number, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
for (const lane of [0, 1, 2]) {
  const start = circuitPosition(0, lane, 200), finish = circuitPosition(200, lane, 200);
  near(start.x, 0); near(start.z, CIRCUIT_3D.radius + (lane - 1) * CIRCUIT_3D.laneWidth);
  near(start.x, finish.x); near(start.z, finish.z); near(start.heading, finish.heading);
  const clamped = circuitPosition(220, lane, 200); near(finish.x, clamped.x); near(finish.z, clamped.z);
}
for (const boundary of [0, CIRCUIT_3D.straight, CIRCUIT_3D.straight + Math.PI * CIRCUIT_3D.radius, 2 * CIRCUIT_3D.straight + Math.PI * CIRCUIT_3D.radius, CIRCUIT_LAP_DISTANCE]) {
  const before = circuitAtDistance(boundary - 1e-6), after = circuitAtDistance(boundary + 1e-6);
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 3e-6);
  assert.ok(Math.abs(Math.sin(after.heading - before.heading)) < 1e-6);
}
for (const progress of [25, 50, 75, 100, 125, 150, 175]) {
  const inner = circuitPosition(progress, 0, 200), outer = circuitPosition(progress, 2, 200), middle = circuitPosition(progress, 1, 200);
  near(Math.hypot(outer.x - inner.x, outer.z - inner.z), 2 * CIRCUIT_3D.laneWidth); near(middle.x, (inner.x + outer.x) / 2); near(middle.z, (inner.z + outer.z) / 2);
}
const signatures: string[] = [];
for (const layout of ['harbor', 'alpine', 'metro'] as CourseLayout[]) {
  const course = { ...createCourseFeatures('geometry-regression', 200), layout };
  signatures.push(JSON.stringify(circuitPosition(41, 1, 200, course)));
  for (const choice of ['left', 'right'] as const) {
    const routes = Object.fromEntries(course.junctions.map(j => [j.id, choice]));
    let previous = circuitPosition(0, 1, 200, course, routes);
    for (let i = 1; i <= 2000; i++) {
      const p = circuitPosition(i / 10, 1, 200, course, routes);
      assert.ok(Object.values(p).every(Number.isFinite));
      assert.ok(Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z) < 1, 'each route must have continuous position');
      assert.ok(Math.abs(Math.sin(p.heading - previous.heading)) < 0.35, 'forks must not make cars spin at joins');
      previous = p;
    }
    const start = circuitPosition(0, 1, 200, course, routes), finish = circuitPosition(200, 1, 200, course, routes);
    near(start.x, finish.x); near(start.z, finish.z); near(start.y, finish.y);
    for (const j of course.junctions) for (const boundary of [j.start, j.end]) {
      const before = circuitPosition(boundary - 1e-5, 1, 200, course, routes), after = circuitPosition(boundary + 1e-5, 1, 200, course, routes);
      assert.ok(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) < 0.001);
      assert.ok(Math.abs(Math.sin(after.heading - before.heading)) < 0.01);
    }
    // Cars and road ribbons use the identical route/lane coordinates, including bridge elevation.
    for (const progress of [0, 32, 68, 145, 180]) for (const lane of [0, 0.4, 1, 2]) {
      assert.deepEqual(circuitPosition(progress, lane, 200, course, routes), circuitAtProgress(progress, (lane - 1) * CIRCUIT_3D.laneWidth, 200, course, routes));
    }
  }
  for (const j of course.junctions) {
    const progress = (j.start + j.end) / 2;
    const left = circuitPosition(progress, 1, 200, course, { [j.id]: 'left' }), right = circuitPosition(progress, 1, 200, course, { [j.id]: 'right' });
    assert.ok(Math.hypot(left.x - right.x, left.z - right.z) > 25, 'opposite branch roads must be visibly separate');
    assert.ok(left.y - right.y > 1.5, 'fork elevation is represented in car placement');
    assert.deepEqual(circuitPosition(progress, 1, 200, course), circuitPosition(progress, 1, 200, course, { [j.id]: j.defaultRoute }));
  }
  // The central self-crossing has enough vertical clearance for both cars.
  const unsplit = { ...course, junctions: [] };
  const central = Array.from({ length: 2000 }, (_, i) => circuitPosition(i / 10, 1, 200, unsplit)).filter(p => Math.hypot(p.x, p.z) < 1);
  assert.ok(central.some(p => p.y > 12)); assert.ok(central.some(p => p.y < 0.1));
}
assert.equal(new Set(signatures).size, 3, 'seeded layouts must be genuinely different geometry');
for (const bad of [NaN, Infinity, -Infinity]) assert.ok(Object.values(circuitPosition(bad, bad, bad)).every(Number.isFinite));
console.log('Legacy, fork-route, bridge-clearance and circuit continuity tests passed');

// The actual full-width road surface must remain oriented forwards, not merely
// its centreline. The old normal-offset forks passed the earlier continuity
// checks despite folding the inner 7.6 m shoulder across itself.
const delta = (a: {x:number;y:number;z:number}, b: {x:number;y:number;z:number}) => ({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const dot = (a: {x:number;y:number;z:number}, b: {x:number;y:number;z:number}) => a.x*b.x+a.y*b.y+a.z*b.z;
const upwardArea = (a: {x:number;z:number}, b: {x:number;z:number}, c: {x:number;z:number}) => (b.z-a.z)*(c.x-a.x)-(b.x-a.x)*(c.z-a.z);
for (const layout of ['harbor', 'alpine', 'metro'] as CourseLayout[]) {
  const course = { ...createCourseFeatures('surface-regression', 200), layout };
  for (const junction of course.junctions) {
    for (const choice of ['left', 'right'] as const) {
      const routes = { [junction.id]: choice };
      for (const boundary of [junction.start, junction.end]) {
        for (const offset of [-7.6, -4.2, 0, 4.2, 7.6]) {
          const h = 0.00001;
          const a = circuitAtProgress(boundary-h, offset, 200, course, routes);
          const p = circuitAtProgress(boundary, offset, 200, course, routes);
          const b = circuitAtProgress(boundary+h, offset, 200, course, routes);
          const left = delta(p,a), right = delta(b,p);
          assert.ok(Math.hypot(left.x-right.x,left.y-right.y,left.z-right.z)/h < 0.0001,
            `${layout} ${junction.id} ${choice}: every lane and shoulder must have a continuous endpoint derivative`);
        }
      }
      for (let i=0; i<240; i++) {
        const p = junction.start+(junction.end-junction.start)*i/240;
        const q = junction.start+(junction.end-junction.start)*(i+1)/240;
        const [low,high] = circuitRoadEdges(p,7.6,200,course,routes);
        const [nextLow,nextHigh] = circuitRoadEdges(q,7.6,200,course,routes);
        const a = circuitAtProgress(p,low,200,course,routes), b = circuitAtProgress(p,high,200,course,routes);
        const c = circuitAtProgress(q,nextLow,200,course,routes), d = circuitAtProgress(q,nextHigh,200,course,routes);
        assert.ok(upwardArea(a,b,c)>0 && upwardArea(b,d,c)>0,
          `${layout} ${junction.id} ${choice} ${p}: road triangles must not fold backwards`);
        for (const offset of [-7.6,0,7.6]) {
          const frame = circuitSurfaceFrame(p,offset,200,course,routes);
          near(dot(frame.forward,frame.normal),0); near(dot(frame.forward,frame.right),0);
          near(dot(frame.normal,frame.right),0); near(dot(frame.normal,frame.normal),1);
          assert.ok(frame.normal.y>0.9,'road normal must point up, including both sides of a fork');
          const tangent = delta(circuitAtProgress(p+0.0001,offset,200,course,routes),circuitAtProgress(p-0.0001,offset,200,course,routes));
          assert.ok(dot(tangent,frame.forward)>0);
          assert.ok(Math.abs(dot(tangent,frame.normal))<0.0000001,'frame follows the actual lane surface');
        }
      }
    }
    for (let i=0;i<=200;i++) {
      const p = junction.start+(junction.end-junction.start)*i/200;
      const leftRoutes = {[junction.id]:'left' as const}, rightRoutes = {[junction.id]:'right' as const};
      const [,leftEdge] = circuitRoadEdges(p,7.6,200,course,leftRoutes);
      const [rightEdge] = circuitRoadEdges(p,7.6,200,course,rightRoutes);
      if (leftEdge<7.6) {
        const left = circuitAtProgress(p,leftEdge,200,course,leftRoutes);
        const right = circuitAtProgress(p,rightEdge,200,course,rightRoutes);
        assert.ok(Math.hypot(left.x-right.x,left.y-right.y,left.z-right.z)<1e-8,
          'split/merge shared edges meet without a gap, vertical step or coplanar overlap');
        assert.equal(circuitEdgeExposed(p,7.6,200,course,leftRoutes),false);
        assert.equal(circuitEdgeExposed(p,-7.6,200,course,rightRoutes),false);
      }
      assert.equal(circuitEdgeExposed(p,-7.6,200,course,leftRoutes),true);
      assert.equal(circuitEdgeExposed(p,7.6,200,course,rightRoutes),true);
    }
    assert.deepEqual(circuitRoadEdges(junction.start,7.6,200,course),[-7.6,7.6],
      'the main road keeps its full-width endpoint while the two branches divide that edge');
  }
  // Test the real lower branch at the overpass, not only an unsplit reference.
  for (const choice of ['left','right'] as const) {
    const upper = Array.from({length:201},(_,i)=>circuitPosition(28+i/10,1,200,course));
    const lower = Array.from({length:281},(_,i)=>circuitPosition(122+i/10,1,200,course,{'fork-2':choice}));
    let nearest = Infinity, clearance = 0;
    for (const a of upper) for (const b of lower) {
      const distance=Math.hypot(a.x-b.x,a.z-b.z);
      if (distance<nearest) {nearest=distance;clearance=a.y-b.y;}
    }
    assert.ok(nearest<0.3 && clearance>12,'actual branch overpasses remain distinct levels');
  }
}
console.log('Full-width fork surfaces, shared edges, lane frames and real overpass clearance tests passed');

// Check actual polygon footprints across unrelated road sections, and the full
// oriented furniture boxes. Checking only each object's centre used to expose
// a kerb tip inside the opposite branch at the second split and merge.
type XZ = {x:number;z:number};
type RoadPolygon = {id:string;progress:number;points:{x:number;y:number;z:number}[];minX:number;maxX:number;minZ:number;maxZ:number;minY:number;maxY:number};
function polygonBounds(points:{x:number;y:number;z:number}[]) {
  return {points,minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x)),minZ:Math.min(...points.map(p=>p.z)),maxZ:Math.max(...points.map(p=>p.z)),minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))};
}
function polygonsOverlap(a:XZ[],b:XZ[]) {
  for (const polygon of [a,b]) for (let i=0;i<polygon.length;i++) {
    const p=polygon[i],q=polygon[(i+1)%polygon.length],nx=-(q.z-p.z),nz=q.x-p.x;
    const first=a.map(v=>v.x*nx+v.z*nz),second=b.map(v=>v.x*nx+v.z*nz);
    if (Math.min(...first)>=Math.max(...second)-1e-7 || Math.min(...second)>=Math.max(...first)-1e-7) return false;
  }
  return true;
}
function boundsOverlap(a:ReturnType<typeof polygonBounds>,b:ReturnType<typeof polygonBounds>) {
  return a.minX<b.maxX && a.maxX>b.minX && a.minZ<b.maxZ && a.maxZ>b.minZ;
}
for (const layout of ['harbor','alpine','metro'] as CourseLayout[]) {
  const course={...createCourseFeatures('surface-footprint-regression',200),layout};
  const sections:{id:string;start:number;end:number;routes:Record<string,RouteChoice>}[]=[];
  let start=0;
  for (const junction of course.junctions) {
    sections.push({id:`main-${start}`,start,end:junction.start,routes:{}});
    for (const choice of ['left','right'] as const) sections.push({id:`${junction.id}-${choice}`,start:junction.start,end:junction.end,routes:{[junction.id]:choice}});
    start=junction.end;
  }
  sections.push({id:`main-${start}`,start,end:200,routes:{}});
  const roadPolygons=(halfWidth:number,step:number) => {
    const polygons:RoadPolygon[]=[];
    for (const section of sections) {
      const count=Math.ceil((section.end-section.start)/step);
      for (let i=0;i<count;i++) {
        const p=section.start+(section.end-section.start)*i/count,q=section.start+(section.end-section.start)*(i+1)/count;
        const [low,high]=circuitRoadEdges(p,halfWidth,200,course,section.routes),[nextLow,nextHigh]=circuitRoadEdges(q,halfWidth,200,course,section.routes);
        const points=[circuitAtProgress(p,low,200,course,section.routes),circuitAtProgress(p,high,200,course,section.routes),circuitAtProgress(q,nextHigh,200,course,section.routes),circuitAtProgress(q,nextLow,200,course,section.routes)];
        polygons.push({id:section.id,progress:p,...polygonBounds(points)});
      }
    }
    return polygons;
  };
  const shoulders=roadPolygons(7.6,.25),asphalt=roadPolygons(6.3,.125);
  for (let i=0;i<shoulders.length;i++) for (let j=i+1;j<shoulders.length;j++) {
    const a=shoulders[i],b=shoulders[j],gap=Math.abs(a.progress-b.progress);
    if (Math.min(gap,200-gap)<1 || !boundsOverlap(a,b) || !polygonsOverlap(a.points,b.points)) continue;
    const verticalClearance=Math.max(a.minY-b.maxY,b.minY-a.maxY,0);
    assert.ok(verticalClearance>8,`${layout}: unrelated roads ${a.id}@${a.progress} and ${b.id}@${b.progress} must not intersect at grade`);
  }
  for (const section of sections) {
    const count=Math.ceil((section.end-section.start)/200*300);
    for (let i=0;i<count;i++) {
      const progress=section.start+(section.end-section.start)*(i+.5)/count;
      for (const [kind,offsetSize,halfLength,halfWidth] of [['kerb',6.9,.8,.325],['rail',8.5,1.15,.125]] as const) {
        if (kind==='rail' && i%2) continue;
        for (const offset of [-offsetSize,offsetSize]) {
          const clearance=Math.hypot(halfLength,halfWidth);
          if (!circuitEdgeExposed(progress,offset,200,course,section.routes,clearance)) continue;
          const p=circuitAtProgress(progress,offset,200,course,section.routes),frame=circuitSurfaceFrame(progress,offset,200,course,section.routes);
          const corners=[[-halfLength,-halfWidth],[-halfLength,halfWidth],[halfLength,halfWidth],[halfLength,-halfWidth]].map(([x,z])=>({
            x:p.x+frame.forward.x*x+frame.right.x*z,y:p.y+frame.forward.y*x+frame.right.y*z,z:p.z+frame.forward.z*x+frame.right.z*z,
          }));
          const box=polygonBounds(corners);
          for (const road of asphalt) {
            if (!boundsOverlap(box,road) || Math.max(road.minY-box.maxY,box.minY-road.maxY,0)>1) continue;
            assert.ok(!polygonsOverlap(corners,road.points),`${layout}: ${kind} ${section.id}@${progress} must keep its full footprint out of ${road.id}`);
          }
        }
      }
    }
  }
  const routes={'fork-2':'left' as const};
  assert.equal(circuitEdgeExposed(131+2/3,6.9,200,course,routes),true,'the old centre-only test exposed the kerb');
  assert.equal(circuitEdgeExposed(131+2/3,6.9,200,course,routes,Math.hypot(.8,.325)),false,'the footprint-aware check removes the obstructing tip');
}
console.log('Nonadjacent road footprints and complete kerb/rail clearance tests passed');
