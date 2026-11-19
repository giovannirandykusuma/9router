// Installs the dashboard's custom caps profiles as the customCaps lookup source —
// browser only. Client components also render during SSR; installing there would
// replace the server source (src/lib/customCapsLoader.js) with a static, often empty map.
import { setCustomCapsSource, createMapSource, buildCustomCapsMap } from "open-sse/providers/customCaps.js";

// → true if installed, false on the server.
export function installBrowserCustomCaps(customModels) {
  if (typeof window === "undefined") return false;
  setCustomCapsSource(createMapSource(buildCustomCapsMap(customModels)));
  return true;
}
