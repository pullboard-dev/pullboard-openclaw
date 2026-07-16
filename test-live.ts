// Backward-compatible entry point. The authoritative, offline-safe command is
// `npm test`; both paths execute the exact compiled distribution, never TS source.
import "./test/compiled-artifact.test.mjs";
