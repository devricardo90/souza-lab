/**
 * Provider boundary for reading the canonical planning document. The Loop never
 * touches Google directly: a gateway returns structured SOURCE FACTS.
 *
 *   { documentId, googleRevisionId | null, fetchedAt, content }
 *
 * googleRevisionId is transient freshness metadata only. It is NEVER part of
 * plan identity (identity = document_id + plan_version + content_hash).
 *
 * CP-03 ships only the injected-transport gateway (no Google authentication,
 * no network). A production gateway will implement the same `fetchPlan`.
 */

export class PlanSourceUnavailableError extends Error {
  constructor(message, code = "SOURCE_UNAVAILABLE") {
    super(message);
    this.name = "PlanSourceUnavailableError";
    this.code = code;
    this.classification = "TRANSIENT";
    this.retryable = true;
  }
}

export class GooglePlanGateway {
  /** @returns {Promise<{documentId:string, googleRevisionId:string|null, fetchedAt:string, content:string}>} */
  fetchPlan(_request) { throw new Error(`${this.constructor.name}.fetchPlan is not implemented`); }
}

/** Validates whatever the transport returned; any violation means the source is unusable, never partially trusted. */
function toSourceFacts(documentId, raw, clock) {
  if (raw === null || typeof raw !== "object") throw new PlanSourceUnavailableError("transport returned no document", "SOURCE_RESPONSE_INVALID");
  if (typeof raw.content !== "string") throw new PlanSourceUnavailableError("transport response has no text content", "SOURCE_RESPONSE_INVALID");
  if (raw.documentId !== undefined && raw.documentId !== documentId) throw new PlanSourceUnavailableError("transport returned a different document", "SOURCE_RESPONSE_INVALID");
  const fetchedAt = raw.fetchedAt ?? clock();
  if (typeof fetchedAt !== "string" || Number.isNaN(Date.parse(fetchedAt))) throw new PlanSourceUnavailableError("transport returned an invalid fetchedAt", "SOURCE_RESPONSE_INVALID");
  const revision = raw.googleRevisionId ?? raw.revisionId ?? null;
  if (revision !== null && typeof revision !== "string") throw new PlanSourceUnavailableError("transport returned an invalid revision id", "SOURCE_RESPONSE_INVALID");
  return Object.freeze({ documentId, googleRevisionId: revision, fetchedAt: new Date(fetchedAt).toISOString(), content: raw.content });
}

export class InjectedGooglePlanGateway extends GooglePlanGateway {
  /** transport: ({ documentId }) => raw facts | Promise; a throw/reject means the source is unavailable. */
  constructor({ transport, clock = () => new Date().toISOString() } = {}) {
    super();
    if (typeof transport !== "function") throw new TypeError("InjectedGooglePlanGateway requires a transport function");
    this.transport = transport;
    this.clock = clock;
  }

  async fetchPlan({ documentId } = {}) {
    if (typeof documentId !== "string" || documentId.trim() === "") throw new TypeError("documentId is required");
    let raw;
    try { raw = await this.transport({ documentId }); }
    catch (error) {
      if (error instanceof PlanSourceUnavailableError) throw error;
      throw new PlanSourceUnavailableError(`plan source unavailable: ${String(error?.message ?? error).slice(0, 200)}`);
    }
    return toSourceFacts(documentId, raw, this.clock);
  }
}
