/**
 * Compatibility re-export barrel.
 *
 * This module used to hold two things at once: the Checklist/auto-match
 * workflow, and the workflow-agnostic primitives every other reporting
 * module imported from it. Those are now separate files:
 *
 *   lib/reporting/kernel.ts               — shared, workflow-agnostic
 *   lib/reporting/checklist-generation.ts — the Checklist workflow itself
 *
 * All first-party importers (both report routes and the four sibling
 * workflow modules) now import from those two modules directly. This barrel
 * is kept so that the module path documented in docs/ARCHITECTURE.md and
 * docs/HANDOVER-2026-08-11-REPORTING-ARCHITECTURE.md still resolves, and so
 * the split is trivially reversible.
 *
 * Remove it in the same change that updates those two documents — no
 * behavior depends on it.
 */

export * from "./kernel.ts";
export * from "./checklist-generation.ts";

