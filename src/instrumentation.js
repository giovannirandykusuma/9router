export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Hydrate persisted model-context overrides before model metadata is served.
    try {
      const [{ getSettings }, { setContextWindowOverrides }] = await Promise.all([
        import("@/lib/db/repos/settingsRepo.js"),
        import("open-sse/providers/capabilities.js"),
      ]);
      const settings = await getSettings();
      setContextWindowOverrides(settings.contextWindowOverrides || {});
    } catch (error) {
      console.warn("[model-context] Unable to load overrides:", error?.message);
    }
  }
}
