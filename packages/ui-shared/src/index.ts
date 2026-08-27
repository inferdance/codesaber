/**
 * @saber/ui-shared — the frontend-facing data model: wire types, the
 * projection fold, and the WS client. Runtime dependency graph stops at the
 * platform WebSocket; the React hook lives behind the "./hook" export so
 * model-only consumers never pull React.
 */
export * from "./model.js";
export * from "./client.js";
