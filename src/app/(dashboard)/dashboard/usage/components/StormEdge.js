"use client";

import { useEffect, useRef } from "react";
import { BaseEdge, getBezierPath } from "@xyflow/react";
import { stormBundle, stormPoints, stormPath, STORM_SPARKS } from "./topologyStorm";

// One modest scheduler for the diagram, not a React state update per frame.
const painters = new Set();
let raf = 0;
let lastPaint = 0;
function paintFrame(time) {
  if (time - lastPaint >= 64) {
    lastPaint = time;
    painters.forEach((paint) => paint(time));
  }
  raf = painters.size ? requestAnimationFrame(paintFrame) : 0;
}
function subscribe(paint) {
  painters.add(paint);
  if (!raf) raf = requestAnimationFrame(paintFrame);
  return () => {
    painters.delete(paint);
    if (!painters.size) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

export default function StormEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style = {}, data }) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const guideRef = useRef(null);
  const groupRef = useRef(null);
  const { strands } = stormBundle(data?.count);
  const active = strands > 0;
  const motion = data?.motion;
  const color = data?.color || "#22d3ee";

  useEffect(() => {
    if (!active || !guideRef.current || !groupRef.current) return;
    const guide = guideRef.current;
    const group = groupRef.current;
    const length = guide.getTotalLength();
    const samples = Array.from({ length: 19 }, (_, i) => {
      const point = guide.getPointAtLength(length * i / 18);
      return { x: point.x, y: point.y };
    });
    const seed = Array.from(id).reduce((sum, c) => sum + c.charCodeAt(0), 0);
    const lines = group.querySelectorAll("[data-strand]");
    const heads = group.querySelectorAll("[data-head]");
    const forks = group.querySelectorAll("[data-fork]");
    const sparks = group.querySelectorAll("[data-spark]");
    function paint(time) {
      const frame = Math.floor(time / 64);
      for (let strand = 0; strand < strands; strand++) {
        const points = stormPoints(samples, strand, strands, frame, seed);
        const path = stormPath(points);
        lines[strand * 2].setAttribute("d", path);
        lines[strand * 2 + 1].setAttribute("d", path);
        // White-hot heads ride the jagged strand, never a detached straight line.
        const progress = ((time / (720 + strand * 83) + strand / strands) % 1) * 18;
        const index = Math.min(17, Math.floor(progress));
        const fraction = progress - index;
        const x = points[index].x + (points[index + 1].x - points[index].x) * fraction;
        const y = points[index].y + (points[index + 1].y - points[index].y) * fraction;
        heads[strand].setAttribute("cx", x);
        heads[strand].setAttribute("cy", y);
        // A bounded localized surge, independent of the number of requests.
        heads[strand].setAttribute("r", frame % 17 === strand ? "4" : "2.2");
        if (strand === 0) {
          forks.forEach((fork, i) => {
            const at = 5 + i * 6 + frame % 3;
            const p = points[at];
            const q = points[at + 1];
            const sign = i ? -1 : 1;
            fork.setAttribute("d", stormPath([p, { x: q.x + sign * 9, y: q.y - 8 }, { x: q.x + sign * 17, y: q.y - 17 }]));
            fork.setAttribute("opacity", frame % 4 === i ? ".9" : ".3");
          });
          sparks.forEach((spark, i) => {
            const p = points[3 + (frame + i * 5) % 13];
            spark.setAttribute("cx", p.x + Math.sin(frame + i) * 10);
            spark.setAttribute("cy", p.y + Math.cos(frame + i) * 10);
            spark.setAttribute("opacity", frame % 3 === i ? ".9" : ".15");
          });
        }
      }
    }
    paint(0); // Useful, anchored static strands for reduced motion and hidden tabs.
    if (motion) return subscribe(paint);
  }, [active, strands, edgePath, id, motion]);

  if (!active) return <BaseEdge id={id} path={edgePath} style={style} />;
  return (
    <g ref={groupRef} data-storm-edge={id} data-strands={strands} data-motion={motion ? "running" : "paused"} style={{ pointerEvents: "none" }}>
      <path ref={guideRef} d={edgePath} fill="none" stroke="none" />
      {Array.from({ length: strands }, (_, i) => (
        <g key={i}>
          <path data-strand="glow" d={edgePath} fill="none" stroke={color} strokeWidth="5" strokeOpacity=".2" strokeLinejoin="round" />
          <path data-strand="core" d={edgePath} fill="none" stroke={color} strokeWidth="1.2" strokeOpacity=".95" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
          <circle data-head="" r="2.2" fill="white" visibility={motion ? "visible" : "hidden"} style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
        </g>
      ))}
      {Array.from({ length: 2 }, (_, i) => <path key={i} data-fork="" fill="none" stroke={color} strokeWidth="1" />)}
      {Array.from({ length: STORM_SPARKS }, (_, i) => <circle key={i} data-spark="" r="1.2" fill="white" visibility={motion ? "visible" : "hidden"} />)}
    </g>
  );
}
