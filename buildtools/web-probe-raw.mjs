import net from "node:net";

const port = Number(process.argv[2] ?? 8423);

function send_raw_request(host_header, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host_header}\r\nConnection: close\r\n\r\n`);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(buffer));
  });
}

function status_line_of(response) {
  return response.split("\r\n")[0] ?? "";
}

const wrong_host = await send_raw_request("evil.example", "/api/health");
console.log(`wrong host -> ${status_line_of(wrong_host)}`);

const loopback_host = await send_raw_request(`127.0.0.1:${port}`, "/api/health");
console.log(`loopback host -> ${status_line_of(loopback_host)}`);

const localhost_host = await send_raw_request(`localhost:${port}`, "/api/health");
console.log(`localhost host -> ${status_line_of(localhost_host)}`);

const encoded_traversal = await send_raw_request(`127.0.0.1:${port}`, "/%2e%2e%2fpackage.json");
console.log(`encoded traversal -> ${status_line_of(encoded_traversal)}`);
console.log(`  body starts: ${encoded_traversal.split("\r\n\r\n")[1]?.slice(0, 40)}`);

const index_document = await send_raw_request(`127.0.0.1:${port}`, "/");
console.log(`index -> ${status_line_of(index_document)}`);
console.log(`  bootstrap injected: ${index_document.includes("__LG_WEB_BOOTSTRAP__")}`);
