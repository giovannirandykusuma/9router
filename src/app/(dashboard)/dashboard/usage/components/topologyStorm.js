export const MAX_STORM_STRANDS = 8;
export const STORM_SPARKS = 3;

export function normalizeProviderId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function stormBundle(count) {
  const valid = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return { strands: Math.min(valid, MAX_STORM_STRANDS), bundled: valid > MAX_STORM_STRANDS };
}

// SSE counts are authoritative, including requests running longer than a minute.
// Missing, fractional, negative and nonnumeric counts must never imply activity.
export function aggregateTopologyRequests(requests, live) {
  if (!live || !Array.isArray(requests)) return { available: false, counts: new Map(), total: null };
  const counts = new Map();
  let total = 0;
  for (const row of requests) {
    const provider = normalizeProviderId(row?.provider);
    const count = row?.count;
    if (!provider || !Number.isSafeInteger(count) || count <= 0) continue;
    const sum = (counts.get(provider) || 0) + count;
    // Do not publish a rounded, inexact number if a corrupt payload overflows.
    if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(total + count)) {
      return { available: false, counts: new Map(), total: null };
    }
    counts.set(provider, sum);
    total += count;
  }
  return { available: true, counts, total };
}

function noise(seed) {
  const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
}

// Samples come from ReactFlow's actual SVG bezier, so every handle direction works.
// The envelope pins both ends exactly; the same seed/frame gives the same geometry.
export function stormPoints(samples, strand, strands, frame, seed = 1) {
  return samples.map((point, i) => {
    if (i === 0 || i === samples.length - 1) return { ...point };
    const before = samples[i - 1];
    const after = samples[i + 1];
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1;
    const envelope = Math.sin(Math.PI * i / (samples.length - 1));
    const spread = (strand - (strands - 1) / 2) * 4;
    const offset = envelope * (spread + noise(seed + strand * 73 + i * 13 + frame * 19) * 15);
    return { x: point.x - dy / length * offset, y: point.y + dx / length * offset };
  });
}

export function stormPath(points) {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}
