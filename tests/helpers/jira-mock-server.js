import http from "node:http";

/**
 * Local Jira REST mock. Runs in its OWN process because the transport under
 * test uses spawnSync (an in-process server would be blocked). Synthetic:
 * nothing here is evidence about real Jira behaviour.
 *
 * Control plane (not under /rest): POST /__control  {override}  queue a one-shot
 * response for the next request matching {method, pathIncludes};
 * POST /__reset; GET /__log.
 */
const state = { status: "In Progress", comments: [], nextCommentId: 10001, overrides: [], log: [], postNoop: false, issues: [], nextIssueNumber: 100, legacySearch: true, createTweak: null };

function reset() {
  Object.assign(state, { status: "In Progress", comments: [], nextCommentId: 10001, overrides: [], log: [], postNoop: false, issues: [], nextIssueNumber: 100, legacySearch: true, createTweak: null });
}

/** Applies a create-issue write (used by the normal route and by the "applied, then response lost" fault). */
function createIssue(raw) {
  const body = JSON.parse(raw);
  const key = `${body.fields.project.key}-${state.nextIssueNumber++}`;
  const fields = { summary: body.fields.summary, description: body.fields.description, issuetype: body.fields.issuetype, status: { name: "To Do" }, issuelinks: [], ...(state.createTweak ?? {}) };
  const created = { id: String(state.nextIssueNumber * 7), key, fields };
  state.issues.push(created);
  return created;
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__control") {
      const body = JSON.parse(raw || "{}");
      if (body.reset) reset();
      if (body.postNoop !== undefined) state.postNoop = body.postNoop;
      if (body.setStatus !== undefined) state.status = body.setStatus;
      if (body.legacySearch !== undefined) state.legacySearch = body.legacySearch;
      if (body.createTweak !== undefined) state.createTweak = body.createTweak; // make created issues deviate from what was requested
      if (body.seedIssue) { state.issues.push(body.seedIssue); }
      if (body.override) state.overrides.push({ times: 1, ...body.override });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__log") return json(res, 200, state.log);
    state.log.push({ method: req.method, path: req.url, authorization: req.headers.authorization ?? null, body: raw || null });

    const idx = state.overrides.findIndex((o) => (!o.method || o.method === req.method) && (!o.pathIncludes || req.url.includes(o.pathIncludes)));
    if (idx >= 0) {
      const o = state.overrides[idx];
      if (--o.times <= 0) state.overrides.splice(idx, 1);
      if (o.fault === "reset") return req.socket.destroy();
      if (o.fault === "applyThenReset") { // write lands, response is lost
        if (req.url.includes("/comment")) state.comments.push({ id: String(state.nextCommentId++), body: JSON.parse(raw).body });
        else createIssue(raw);
        return req.socket.destroy();
      }
      if (o.fault === "hang") return; // never answers; client timeout must fire
      if (o.fault === "premature") {
        res.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
        res.write('{"partial":');
        return setTimeout(() => req.socket.destroy(), 20);
      }
      res.writeHead(o.status ?? 200, { "content-type": "application/json", ...(o.headers ?? {}) });
      return res.end(o.rawBody ?? (o.body === undefined ? "" : JSON.stringify(o.body)));
    }

    const p = url.pathname;
    const comment = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(p);
    const transitions = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/transitions$/.exec(p);
    const issue = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(p);
    if (p === "/rest/api/3/issue" && req.method === "POST") return json(res, 201, (({ id, key }) => ({ id, key }))(createIssue(raw)));
    if (comment && req.method === "GET") return json(res, 200, { comments: state.comments });
    if (comment && req.method === "POST") {
      const created = { id: String(state.nextCommentId++), body: JSON.parse(raw).body };
      state.comments.push(created);
      return json(res, 201, created);
    }
    if (transitions && req.method === "GET") return json(res, 200, { transitions: [{ id: "31", name: "Done" }] });
    if (transitions && req.method === "POST") {
      if (!state.postNoop) state.status = "Done";
      res.writeHead(204);
      return res.end();
    }
    if (issue && req.method === "GET") return json(res, 200, { key: issue[1], fields: { status: { name: state.status } } });
    if (p === "/rest/api/3/search") {
      const description = "Acceptance Criteria\n\n- AC-001: mock condition\n";
      const legacy = state.legacySearch ? [{ key: "LOOP-1", fields: { summary: "Mock", status: { name: state.status }, description, issuelinks: [] } }] : [];
      const all = [...legacy, ...state.issues];
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const maxResults = Number(url.searchParams.get("maxResults") ?? 100);
      return json(res, 200, { total: all.length, startAt, maxResults, issues: all.slice(startAt, startAt + maxResults) });
    }
    return json(res, 404, { errorMessages: ["not found"] });
  });
});

server.listen(0, "127.0.0.1", () => console.log(`PORT=${server.address().port}`));
