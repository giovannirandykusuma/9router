import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "9router-model-context-"));
process.env.DATA_DIR = dataDir;

let GET;
let POST;
let getSettings;

beforeAll(async () => {
  ({ GET, POST } = await import("../../src/app/api/model-context/route.js"));
  ({ getSettings } = await import("../../src/lib/db/repos/settingsRepo.js"));
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function post(body) {
  return POST(new Request("http://localhost/api/model-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("model-context API", () => {
  it("lists registered default and effective values", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    const astra = body.models.find((model) => model.key === "codex/gpt-6-astra");
    expect(astra).toMatchObject({
      defaultContextWindow: 272000,
      effectiveContextWindow: 272000,
      maxOutput: 128000,
    });
  });

  it("rejects unknown keys and invalid context windows", async () => {
    expect((await post({ set: [{ key: "codex/not-real", contextWindow: 800000 }] })).status).toBe(400);
    expect((await post({ set: [{ key: "codex/gpt-6-astra", contextWindow: 1 }] })).status).toBe(400);
    expect((await post({ set: [{ key: "codex/gpt-6-astra", contextWindow: "800000" }] })).status).toBe(400);
  });

  it("persists an exact override and reset deletes it", async () => {
    let response = await post({ set: [{ key: "codex/gpt-6-astra", contextWindow: 800000 }] });
    expect(response.status).toBe(200);
    expect((await getSettings()).contextWindowOverrides).toEqual({ "codex/gpt-6-astra": 800000 });

    let body = await (await GET()).json();
    expect(body.models.find((model) => model.key === "codex/gpt-6-astra").effectiveContextWindow).toBe(800000);

    response = await post({ deleteKeys: ["codex/gpt-6-astra"] });
    expect(response.status).toBe(200);
    expect((await getSettings()).contextWindowOverrides).toEqual({});
    body = await (await GET()).json();
    expect(body.models.find((model) => model.key === "codex/gpt-6-astra").effectiveContextWindow).toBe(272000);
  });
});
