/**
 * `isomorphic-ws` exposes only a default export in its browser build, while the
 * indexer provider imports `{ WebSocket }` by name. Bundlers resolve that to
 * `undefined`, which breaks the moment a subscription opens. Browsers have a
 * perfectly good WebSocket already, so hand them that.
 */
export const WebSocket = globalThis.WebSocket;
export default globalThis.WebSocket;
