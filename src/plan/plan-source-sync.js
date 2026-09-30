import { PlanCompileError, compilePlan } from "./plan-compiler.js";
import { PlanSourceUnavailableError } from "./google-plan-gateway.js";
import { makePlanSnapshot } from "./plan-snapshot.js";
import { PlanStoreError } from "../adapters/sqlite-plan-snapshot-store.js";

/**
 * Pulls the canonical planning document and maintains last-known-good.
 * Deterministic, no model, NO Jira interaction.
 *
 * Result statuses (always with `usable` = a last-known-good snapshot can be used, and `snapshot` = that snapshot):
 *   ACCEPTED           valid new plan persisted; it is now latest-known-good
 *   UNCHANGED          fetched plan equals the latest snapshot (idempotent)
 *   SOURCE_INVALID     source fetched but rejected (compile error / version conflict / regression);
 *                      the previous last-known-good is retained untouched
 *   SOURCE_UNAVAILABLE Google could not be read; previous snapshot (if any) remains usable.
 *                      With no previous snapshot, action is WAIT and usable is false.
 * A valid snapshot is never replaced by invalid input, and in-flight WorkPackages stay bound
 * to the snapshot they were materialized from (see plan-snapshot.js).
 */

export class PlanSourceSynchronizer {
  constructor({ gateway, store, clock = () => new Date().toISOString() } = {}) {
    if (!gateway || !store) throw new TypeError("PlanSourceSynchronizer requires a gateway and a snapshot store");
    Object.assign(this, { gateway, store, clock });
  }

  async refresh({ documentId }) {
    const previous = this.store.latest(documentId);
    const result = (status, extra = {}) => Object.freeze({
      status, documentId, snapshot: extra.snapshot ?? previous, usable: (extra.snapshot ?? previous) !== null,
      action: extra.action ?? (status === "SOURCE_UNAVAILABLE" && previous === null ? "WAIT" : "CONTINUE"),
      ...extra,
    });

    let facts;
    try { facts = await this.gateway.fetchPlan({ documentId }); }
    catch (error) {
      if (error instanceof PlanSourceUnavailableError || error?.retryable === true) {
        return result("SOURCE_UNAVAILABLE", { errorCode: error.code ?? "SOURCE_UNAVAILABLE", detail: String(error.message).slice(0, 300), retryable: true });
      }
      throw error; // programming error / invariant violation: do not disguise it as a source state
    }

    let compiled;
    try { compiled = compilePlan(facts.content); }
    catch (error) {
      if (error instanceof PlanCompileError) return result("SOURCE_INVALID", { errorCode: error.code, detail: error.message, line: error.line });
      throw error;
    }

    const snapshot = makePlanSnapshot({
      documentId, compiled, googleRevisionId: facts.googleRevisionId, fetchedAt: facts.fetchedAt, compiledAt: this.clock(),
    });
    try {
      const { created, snapshot: stored } = this.store.persist(snapshot);
      if (!created && previous && stored.planVersion < previous.planVersion) {
        // an already-stored OLD version re-presented by the document: stale source, not a new plan
        return result("SOURCE_INVALID", { errorCode: "PLAN_VERSION_REGRESSION", detail: `document presents plan_version ${stored.planVersion}, latest known is ${previous.planVersion}` });
      }
      return result(created ? "ACCEPTED" : "UNCHANGED", { snapshot: stored, created, action: "CONTINUE" });
    } catch (error) {
      if (error instanceof PlanStoreError && (error.code === "PLAN_VERSION_CONFLICT" || error.code === "PLAN_VERSION_REGRESSION")) {
        return result("SOURCE_INVALID", { errorCode: error.code, detail: error.message });
      }
      throw error;
    }
  }
}
