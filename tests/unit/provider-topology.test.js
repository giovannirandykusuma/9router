import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { aggregateTopologyRequests, stormBundle, stormPoints, stormPath, MAX_STORM_STRANDS, STORM_SPARKS } from "../../src/app/(dashboard)/dashboard/usage/components/topologyStorm.js";

const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js", import.meta.url), "utf8");

describe("authoritative topology concurrency", () => {
  it("sums requests, not providers, across models/accounts with normalized IDs", () => {
    const activity = aggregateTopologyRequests([
      { provider: "OpenAI", model: "a", account: "one", count: 1 },
      { provider: " openai ", model: "b", account: "two", count: 4 },
      { provider: "ANTHROPIC", count: 2 },
    ], true);
    expect(activity.counts.get("openai")).toBe(5);
    expect(activity.counts.get("anthropic")).toBe(2);
    expect(activity.total).toBe(7);
    expect(activity.available).toBe(true);
  });

  it("rejects zero, missing, invalid, noninteger and unsafe counts without inventing requests", () => {
    const rows = [0, -1, 1.5, NaN, Infinity, "4", undefined, null, Number.MAX_SAFE_INTEGER + 1]
      .map(count => ({ provider: "openai", count }));
    rows.push({ count: 3 }, null, { provider: 5, count: 3 });
    expect(aggregateTopologyRequests(rows, true)).toEqual({ available: true, counts: new Map(), total: 0 });
    expect(aggregateTopologyRequests(null, true)).toEqual({ available: false, counts: new Map(), total: null });
  });

  it("marks reconnecting counts unavailable and clears all visual activity", () => {
    const rows = [{ provider: "openai", count: 5 }];
    expect(aggregateTopologyRequests(rows, false)).toEqual({ available: false, counts: new Map(), total: null });
    expect(aggregateTopologyRequests(rows, true).total).toBe(5);
  });

  it("retains authoritative long-running requests beyond 60 seconds", () => {
    vi.useFakeTimers();
    try {
      const rows = [{ provider: "openai", count: 5, startedAt: Date.now() }];
      vi.advanceTimersByTime(180000);
      expect(aggregateTopologyRequests(rows, true).total).toBe(5);
      expect(source).not.toMatch(/FE_ACTIVE_TIMEOUT|firstSeen|setInterval/);
    } finally { vi.useRealTimers(); }
  });

  it("uses unavailable rather than a rounded number on sum overflow", () => {
    expect(aggregateTopologyRequests([{ provider: "a", count: Number.MAX_SAFE_INTEGER }, { provider: "b", count: 1 }], true).available).toBe(false);
  });

  it("caps strands but never caps or substitutes the honest count", () => {
    expect(stormBundle(1)).toEqual({ strands: 1, bundled: false });
    expect(stormBundle(4)).toEqual({ strands: 4, bundled: false });
    expect(stormBundle(8)).toEqual({ strands: 8, bundled: false });
    expect(stormBundle(83)).toEqual({ strands: 8, bundled: true });
    for (const count of [-1, NaN, Infinity, "3", 0, 0.5]) expect(stormBundle(count).strands).toBe(0);
    expect(MAX_STORM_STRANDS).toBe(8);
    expect(STORM_SPARKS).toBe(3);
    expect(aggregateTopologyRequests([{ provider: "a", count: 83 }], true).total).toBe(83);
  });

  it("wires availability, totals and bounded badges into the existing graph", () => {
    const usage = readFileSync(new URL("../../src/shared/components/UsageStats.js", import.meta.url), "utf8");
    expect(usage).toMatch(/<ProviderTopology[\s\S]*?live=\{live\}/);
    expect(source).toContain("activeCount: activity.total");
    expect(source).toContain("Count unavailable · reconnecting");
    expect(source).toContain("8 strands");
    expect(source).toContain('media.addEventListener("change", update)');
    expect(source).toContain('document.removeEventListener("visibilitychange", update)');
  });
});

describe("Storm geometry", () => {
  for (const [dx, dy] of [[200, 0], [-200, 0], [0, 200], [0, -200], [170, -95]]) {
    it(`anchors actual bezier samples for handle direction ${dx},${dy}`, () => {
      const samples = Array.from({ length: 19 }, (_, i) => ({ x: dx * i / 18, y: dy * i / 18 + Math.sin(Math.PI * i / 18) * 30 }));
      const points = stormPoints(samples, 7, 8, 21, 14);
      expect(points[0]).toEqual(samples[0]);
      expect(points.at(-1)).toEqual(samples.at(-1));
      expect(points).toEqual(stormPoints(samples, 7, 8, 21, 14));
      expect(points).not.toEqual(stormPoints(samples, 7, 8, 22, 14));
      for (let i = 0; i < points.length; i++) {
        expect(Math.hypot(points[i].x - samples[i].x, points[i].y - samples[i].y)).toBeLessThanOrEqual(30);
      }
      expect(stormPath(points)).not.toMatch(/NaN|Infinity/);
    });
  }
});
