import { describe, it, expect, vi, afterEach } from "vitest";
import { createActiveRequestTracker } from "@/lib/activeRequests.js";
import { createStreamController } from "open-sse/utils/streamHandler.js";

afterEach(() => vi.useRealTimers());
function setup() {
  const pending = { byModel: {}, byAccount: {} };
  const changed = vi.fn(), error = vi.fn();
  return { pending, changed, error, track: createActiveRequestTracker(pending, changed, error) };
}
describe("live concurrency request lifetimes", () => {
  it("counts overlapping requests on the same account/model independently", () => {
    const { pending, track } = setup();
    const first = track("sol", "codex", "account", true);
    const second = track("sol", "codex", "account", true);
    expect(pending.byModel["sol (codex)"]).toBe(2);
    first(); first(); first(true);
    expect(pending.byAccount.account["sol (codex)"]).toBe(1);
    second();
    expect(pending).toEqual({ byModel: {}, byAccount: {} });
  });
  it("does not expire long reasoning requests after a minute", () => {
    vi.useFakeTimers();
    const { track, pending } = setup();
    const finish = track("sol", "codex", "a", true);
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(pending.byModel["sol (codex)"]).toBe(1);
    finish();
    expect(pending.byModel).toEqual({});
  });
  it("aggregates across accounts and preserves unassigned requests", () => {
    const { track, pending } = setup();
    track("sol", "codex", "a", true);
    track("sol", "codex", "b", true);
    track("terra", "codex", null, true);
    expect(pending.byModel).toEqual({ "sol (codex)": 2, "terra (codex)": 1 });
    expect(Object.keys(pending.byAccount)).toHaveLength(2);
  });
  it("does not let a stop before start decrement a sibling", () => {
    const { track, pending, error } = setup();
    track("terra", "codex", "a", false, true);
    expect(pending.byModel).toEqual({});
    expect(error).not.toHaveBeenCalled();
  });
  it.each(["complete", "disconnect", "error", "abort"])("releases only the owned request on %s", (mode) => {
    vi.useFakeTimers();
    const { track, pending, error } = setup();
    const finish = track("sol", "codex", "a", true);
    const sibling = track("sol", "codex", "a", true);
    const controller = createStreamController({
      onComplete: () => finish(), onDisconnect: () => finish(), onError: () => finish(true),
      log: { line: vi.fn(), errorLine: vi.fn() },
    });
    if (mode === "complete") controller.handleComplete();
    if (mode === "disconnect") controller.handleDisconnect();
    if (mode === "error") controller.handleError(new Error("upstream failed"));
    if (mode === "abort") controller.handleError(new DOMException("aborted", "AbortError"));
    controller.handleComplete(); controller.handleError(new Error("duplicate")); finish();
    expect(pending.byModel["sol (codex)"]).toBe(1);
    expect(error).toHaveBeenCalledTimes(["error", "abort"].includes(mode) ? 1 : 0);
    sibling();
    expect(pending).toEqual({ byModel: {}, byAccount: {} });
  });
});
