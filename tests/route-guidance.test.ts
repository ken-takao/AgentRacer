import assert from "node:assert/strict";
import { test } from "node:test";
import { routeGuidance } from "../lib/route-guidance.ts";
import { createCourseFeatures, selectedRoute, type CourseLayout } from "../lib/race-course.ts";
import { circuitPosition } from "../lib/circuit-geometry.ts";
import { DEFAULT_FIXTURE, routeFixture, readFixtureQuery } from "../app/preview/routes/fixture.ts";

for (const layout of ["harbor", "alpine", "metro"] as CourseLayout[]) {
  for (const junction of [1, 2] as const) {
    for (const route of ["left", "right"] as const) {
      test(`${layout} fork ${junction} ${route}: route guidance follows server state at all boundaries`, () => {
        const fixture = routeFixture({ ...DEFAULT_FIXTURE, layout, junction, red: route, blue: route });
        const fork = fixture.course.junctions![junction - 1];
        assert.equal(fixture.course.layout, layout);
        for (const progress of [fork.start - 6, fork.start, (fork.start + fork.end) / 2, fork.end - .001]) {
          const player = { ...fixture.players.red, progress };
          const guidance = routeGuidance(fixture.course, player);
          assert.equal(guidance.route, route);
          assert.equal(guidance.junction?.id, fork.id);
          assert.equal(guidance.locked, progress >= fork.start);
          assert.equal(guidance.phase, progress >= fork.start ? "branch" : "approach");
          assert.match(guidance.instruction, new RegExp(route === "left" ? "左" : "右"));
          const expected = circuitPosition(progress, player.lane, fixture.course.length, fixture.course, { [fork.id]: selectedRoute(fork, player) });
          assert.deepEqual(circuitPosition(progress, player.lane, fixture.course.length, fixture.course, { [guidance.junction!.id]: guidance.route! }), expected);
        }
        const exited = routeGuidance(fixture.course, { ...fixture.players.red, progress: fork.end });
        assert.equal(exited.currentRoad, "本道");
        assert.equal(exited.phase, junction === 1 ? "approach" : "complete");
      });
    }
  }
}
test("unselected route shows the actual default and is not represented as a manual choice", () => {
  const course = createCourseFeatures("route-guidance", 200);
  for (const fork of course.junctions) {
    const guidance = routeGuidance(course, { progress: fork.start - 10, routeChoices: {} });
    assert.equal(guidance.route, fork.defaultRoute);
    assert.equal(guidance.explicitChoice, false);
    assert.match(guidance.selection, /未操作・既定/);
    assert.equal(guidance.currentRoad, "本道");
  }
});
test("already selected future fork never changes the current fork or physical lane", () => {
  const fixture = routeFixture({ ...DEFAULT_FIXTURE, redLane: 2 });
  const [first, second] = fixture.course.junctions!;
  const driver = { ...fixture.players.red, progress: first.start + 2, routeChoices: { [first.id]: "left" as const, [second.id]: "right" as const } };
  const copy = structuredClone(driver);
  const guidance = routeGuidance(fixture.course, driver);
  assert.equal(guidance.route, "left");
  assert.equal(guidance.junction?.id, first.id);
  assert.deepEqual(driver, copy);
  assert.equal(driver.lane, 2);
});
test("inspection URLs are bounded and cannot invent a route, lane or layout", () => {
  const options = readFixtureQuery(new URLSearchParams("layout=none&red=invalid&blue=left&redLane=12&blueLane=0&progress=999"));
  assert.equal(options.layout, "harbor"); assert.equal(options.red, "left"); assert.equal(options.blue, "left");
  assert.equal(options.redLane, 1); assert.equal(options.blueLane, 0); assert.equal(options.progress, 200);
  for (const layout of ["harbor", "alpine", "metro"] as CourseLayout[]) for (const stage of ["overpass", "underpass"] as const) {
    const fixture = routeFixture({ ...DEFAULT_FIXTURE, layout, stage });
    const player = fixture.players.red;
    const position = circuitPosition(player.progress, 1, fixture.course.length, fixture.course, player.routeChoices);
    assert.ok(stage === "overpass" ? position.y > 8 : position.y < 8);
  }
});
