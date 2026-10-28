import { describe, expect, it } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("Gemini schema keyword-named tool arguments", () => {
  it("preserves properties named items, required, and properties at every nesting level", () => {
    const fields = () => ({
      items: { type: "string" },
      required: { type: "string" },
      properties: { type: "string" },
      safe: { type: "string" },
    });
    const names = Object.keys(fields());
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        ...fields(),
        nested: { type: "object", properties: fields(), required: names },
        list: { type: "array", items: { type: "object", properties: fields(), required: names } },
      },
      required: names,
    });
    for (const name of names) expect(cleaned.properties[name]).toEqual({ type: "string" });
    expect(cleaned.required).toEqual(names);
    expect(cleaned.properties.nested.properties).toEqual(fields());
    expect(cleaned.properties.nested.required).toEqual(names);
    expect(cleaned.properties.list.items.properties).toEqual(fields());
    expect(cleaned.properties.list.items.required).toEqual(names);
  });
});
