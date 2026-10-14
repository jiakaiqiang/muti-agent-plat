// Reuses only the isolated production-frontend fixture server; never connects a real Runtime.
process.env.NAVIGATION_MUTATION_TEST = '1';
process.env.NAVIGATION_SAMPLES ??= '2';
await import('./session-navigation-performance-smoke.mjs');
