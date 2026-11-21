// Run: node --experimental-strip-types --test clients/typescript/turns.test.ts
// (from services/gemini; Node 22.6+). Uses the same cases as the Python tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classify, matchCue, pathTurns, PathError, signedTurnDegrees } from "./turns.ts";
import { GeminiServiceClient, GeminiServiceError } from "./landmarkClient.ts";

const casesUrl = new URL("../../fixtures/turn_cases.json", import.meta.url);
const { cases } = JSON.parse(readFileSync(fileURLToPath(casesUrl), "utf8")) as {
  cases: { name: string; points: [number, number, number][]; expect: [string, string | null, number, number][] }[];
};

for (const c of cases) {
  test(`shared case: ${c.name}`, () => {
    const got = pathTurns(c.points).map(t => [t.maneuver, t.side, t.index, t.distanceFromStart]);
    assert.deepEqual(got, c.expect);
  });
}

test("left is positive with +Y up", () => {
  assert.equal(Math.round(signedTurnDegrees([0, -1], [-1, 0])), 90);
  assert.equal(Math.round(signedTurnDegrees([0, -1], [1, 0])), -90);
  assert.equal(classify(19.9), "straight");
  assert.equal(classify(150.1), "u_turn");
});

test("instructions and headings", () => {
  const [stairs] = pathTurns([[0, 0, 0], [0, 0, -8], [-3, -1.8, -8]]);
  assert.equal(stairs!.instruction, "Turn left and take the stairs down");
  const [left] = pathTurns([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -4 }, { x: -3, y: 0, z: -4 }]);
  assert.deepEqual(left!.incomingHeading, { x: 0, z: -1 });
  assert.deepEqual(left!.outgoingHeading, { x: -1, z: 0 });
  assert.equal(left!.angleDegrees, 90);
});

test("bad paths throw PathError", () => {
  for (const bad of [[], [[0, 0, 0]], [[0, 0, 0], [0, 3, 0]], [[0, 0, 0], [Infinity, 0, 1]]]) {
    assert.throws(() => pathTurns(bad as [number, number, number][]), PathError);
  }
});

test("cue matching respects direction, distance and maneuver", () => {
  const [turn] = pathTurns([[0, 0, 0], [0, 0, -4], [-3, 0, -4]]);
  const cue = { maneuver: "left" as const, position: { x: 0.3, y: 0, z: -4.2 }, incomingHeading: { x: 0, z: -1 }, approvedText: "Turn left at the black door." };
  assert.equal(matchCue(turn!, [cue])?.approvedText, "Turn left at the black door.");
  assert.equal(matchCue(turn!, [{ ...cue, incomingHeading: { x: 0, z: 1 } }]), null);
  assert.equal(matchCue(turn!, [{ ...cue, position: { x: 5, y: 0, z: -4 } }]), null);
  assert.equal(matchCue(turn!, [{ ...cue, maneuver: "right" as const }]), null);
});

test("service client sends base64 photos and the token, and maps errors", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies = [
    new Response(JSON.stringify({ category: "CANDIDATES", candidates: [] }), { status: 200 }),
    new Response(JSON.stringify({ error: { code: "GEMINI_RATE_LIMITED", message: "busy" } }), { status: 503 }),
  ];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return replies.shift()!; }) as unknown as typeof fetch;
  const client = new GeminiServiceClient({ baseUrl: "http://svc:8090/", token: "t".repeat(30), fetchImpl });
  const request = {
    requestId: "r1", scanRevisionId: "rev", routeSegmentId: "turn-1", approachDirectionId: "a",
    verifiedMovement: { maneuver: "left" as const },
    frames: [
      { frameId: "f1", role: "approach" as const, mimeType: "image/jpeg" as const, image: new Uint8Array([255, 216, 255]) },
      { frameId: "f2", role: "junction" as const, mimeType: "image/jpeg" as const, image: new Uint8Array([1, 2]) },
    ],
  };
  const ok = await client.proposeLandmarks(request);
  assert.equal(ok.category, "CANDIDATES");
  assert.equal(calls[0]!.url, "http://svc:8090/v1/landmarks");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer " + "t".repeat(30));
  const sent = JSON.parse(calls[0]!.init.body as string);
  assert.equal(sent.frames[0].imageBase64, "/9j/");
  assert.equal(sent.frames[0].image, undefined);
  await assert.rejects(client.proposeLandmarks(request), (e: unknown) =>
    e instanceof GeminiServiceError && e.code === "GEMINI_RATE_LIMITED" && e.retryable);
});
