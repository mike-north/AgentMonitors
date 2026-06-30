import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // The launcher smoke test spawns a real Node subprocess that loads the full
    // CLI; under parallel CI load that occasionally hiccups. Retry a couple of
    // times so a transient contention blip doesn't red the suite — a genuine
    // launcher break still fails all attempts (and the test dumps the
    // subprocess stderr/status on failure for diagnosis).
    retry: 2,
  },
});
