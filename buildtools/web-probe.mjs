const base = process.argv[2] ?? "http://127.0.0.1:8421";
const credential = process.argv[3] ?? "";

async function show(label, response) {
  const text = await response.text();
  console.log(`${label} -> ${response.status} ${text.slice(0, 200).replace(/\n/g, " ")}`);
}

const health = await fetch(`${base}/api/health`);
await show("health(no session)", health);

const index = await fetch(`${base}/`);
const index_text = await index.text();
console.log(
  `index -> ${index.status} hasBootstrap=${index_text.includes("__LG_WEB_BOOTSTRAP__")} len=${index_text.length}`,
);
console.log(
  `  bootstrap snippet: ${index_text.slice(index_text.indexOf("__LG_WEB_BOOTSTRAP__") - 20, index_text.indexOf("__LG_WEB_BOOTSTRAP__") + 160)}`,
);

const asset = await fetch(
  `${base}/assets/${index_text.match(/assets\/(index-[^"]+\.js)/)?.[1] ?? "missing.js"}`,
);
console.log(
  `asset -> ${asset.status} ${asset.headers.get("content-type")} cache=${asset.headers.get("cache-control")}`,
);

const deep = await fetch(`${base}/agent`);
console.log(`deep link /agent -> ${deep.status} ${deep.headers.get("content-type")}`);

const traversal = await fetch(`${base}/../package.json`);
console.log(`traversal -> ${traversal.status}`);

const bad_host = await fetch(`${base}/api/health`, { headers: { host: "evil.example" } });
await show("bad host", bad_host);

const bad_origin = await fetch(`${base}/api/session/project/snapshot`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://evil.example" },
  body: "{}",
});
await show("bad origin api", bad_origin);

const unauthorized = await fetch(`${base}/api/session/project/snapshot`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
await show("unauthorized api", unauthorized);

const sse = await fetch(`${base}/api/events/stream`);
console.log(`sse(no session) -> ${sse.status}`);

const bad_credential = await fetch(`${base}/api/web/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential: "wrong" }),
});
await show("session wrong credential", bad_credential);

const established = await fetch(`${base}/api/web/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential }),
});
const set_cookie = established.headers.get("set-cookie") ?? "";
console.log(`session establish -> ${established.status} cookie=${set_cookie.slice(0, 60)}...`);
const cookie = set_cookie.split(";")[0] ?? "";

const snapshot = await fetch(`${base}/api/session/project/snapshot`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: "{}",
});
await show("authorized api", snapshot);

const bootstrap = await fetch(`${base}/api/web/bootstrap`);
await show("bootstrap", bootstrap);

const sse_authorized = await fetch(`${base}/api/events/stream`, { headers: { cookie } });
console.log(
  `sse(authorized) -> ${sse_authorized.status} ${sse_authorized.headers.get("content-type")}`,
);
await sse_authorized.body?.cancel();
