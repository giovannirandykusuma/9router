import { describe, it, expect } from "vitest";
import { extractContextLength } from "../../src/shared/utils/contextLength.js";

describe("extractContextLength", () => {
  const vllm = [
    { id: "other", object: "model", max_model_len: 8192 },
    { id: "my-qwen", object: "model", owned_by: "vllm", max_model_len: 65536 },
  ];

  it("reads vLLM max_model_len for the matching id", () => {
    expect(extractContextLength(vllm, "my-qwen")).toBe(65536);
  });

  it("returns null when model missing", () => {
    expect(extractContextLength(vllm, "nope")).toBeNull();
  });

  it("returns null when field missing", () => {
    expect(extractContextLength([{ id: "x" }], "x")).toBeNull();
  });

  it("returns null for non-numeric / invalid values", () => {
    expect(extractContextLength([{ id: "x", max_model_len: "abc" }], "x")).toBeNull();
    expect(extractContextLength([{ id: "x", max_model_len: -5 }], "x")).toBeNull();
    expect(extractContextLength([{ id: "x", max_model_len: 1.5 }], "x")).toBeNull();
  });

  it("accepts numeric strings", () => {
    expect(extractContextLength([{ id: "x", max_model_len: "32768" }], "x")).toBe(32768);
  });

  it("falls back to context_length then context_window", () => {
    expect(extractContextLength([{ id: "x", context_length: 131072 }], "x")).toBe(131072);
    expect(extractContextLength([{ id: "x", context_window: 200000 }], "x")).toBe(200000);
    expect(extractContextLength([{ id: "x", max_model_len: 4096, context_length: 9999 }], "x")).toBe(4096);
  });

  it("matches on name or model fields", () => {
    expect(extractContextLength([{ name: "n1", context_length: 5000 }], "n1")).toBe(5000);
    expect(extractContextLength([{ model: "m1", context_length: 6000 }], "m1")).toBe(6000);
  });

  it("tolerates garbage input", () => {
    expect(extractContextLength(null, "x")).toBeNull();
    expect(extractContextLength([null, 1, "s"], "x")).toBeNull();
    expect(extractContextLength(vllm, "")).toBeNull();
  });
});
