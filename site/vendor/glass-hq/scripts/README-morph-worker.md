# Geometry worker

The planner and marching-squares smooth union are the existing MIT Glass-HQ
algorithms in `src/core/morph-path.ts` and `src/core/union.ts`. The cooperative
iterator preserves their arithmetic/traversal and the liquid neck. The sync
`planMorph` export is retained for compatibility and deterministic tests;
production DOM motion uses `requestMorphPlan` from `src/dom/morph-plan.ts`.

`morph-plan.worker.ts` runs the same cooperative trace off the main thread.
Worker creation/runtime failure falls back to timed main-thread slices, never
to the synchronous trace. Cancellation is subscriber-aware for coalesced
requests. Completed local-coordinate plans use a 16-entry LRU cache.

Next may copy a `new URL(worker.ts)` asset without compiling its imports, so
we ship a self-contained ESM JavaScript worker built from the TypeScript source:

```sh
node site/vendor/glass-hq/scripts/bundle-morph-worker.mjs
node site/vendor/glass-hq/scripts/bundle-morph-worker.mjs --check
cd site && node --import tsx --test tests/glass-morph-plan.test.ts
```

`--check` bundles in memory and byte-compares the checked-in worker without
writing it. Tests include a SHA-256 fixture from the original f49abcc planner,
Worker/synchronous equality, cooperative fallback and cancellation, press-plan
reuse, and adjacent-pair motion readiness/reversal. VM worker tests establish
algorithm/protocol behavior; they do not establish iPhone timing or browser
worker asset delivery.
