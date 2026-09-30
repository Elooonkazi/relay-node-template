// VLESS-over-WebSocket relay node — deploy template for free PaaS platforms.
// Zero dependencies: raw HTTP upgrade + manual WebSocket framing.
//
// Environment:
//   VLESS_UUID  client UUID, dashes optional. If unset, a random UUID is
//               generated at boot and printed to stdout (copy it to your client).
//   WS_PATH     WebSocket path. Default: /api/v1/<first 8 hex chars of UUID>.
//   PORT        listen port (default 8080; most hosts inject this).
//   IP          bind address (default 0.0.0.0).

const http = require("http");
const crypto = require("crypto");
const net = require("net");

function uuidNoDashes(s) {
  return String(s || "").toLowerCase().replace(/-/g, "");
}
function randomUuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  return b.toString("hex");
}
function uuidDashed(hex) {
  return (
    hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) +
    "-" + hex.slice(16, 20) + "-" + hex.slice(20)
  );
}

let VLESS_UUID;
let generated = false;
const envUuid = uuidNoDashes(process.env.VLESS_UUID);
if (envUuid) {
  if (!/^[0-9a-f]{32}$/.test(envUuid)) {
    console.error("[vless] FATAL: VLESS_UUID is not a valid UUID: " + process.env.VLESS_UUID);
    process.exit(1);
  }
  VLESS_UUID = envUuid;
} else {
  VLESS_UUID = randomUuid();
  generated = true;
}

const WS_PATH = process.env.WS_PATH || ("/api/v1/" + VLESS_UUID.slice(0, 8));

const DECOY = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Service Status</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0f14;color:#9fb3c8">
<div style="text-align:center"><div style="font-size:15px;letter-spacing:.2em">SERVICE&nbsp;STATUS</div>
<div style="font-size:42px;color:#3ddc84;margin:12px 0">&#9679;</div>
<div>All systems operational</div></div></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(DECOY);
});

server.on("upgrade", (req, socket) => {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://x").pathname; } catch (_) {}
  const key = req.headers["sec-websocket-key"];
  if (pathname !== WS_PATH || !key) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  handleVless(new WsConn(socket));
});

server.on("clientError", (err, socket) => { try { socket.destroy(); } catch (_) {} });

const LISTEN_PORT = parseInt(process.env.PORT || "8080", 10);
const LISTEN_IP = process.env.IP || "0.0.0.0";
server.listen(LISTEN_PORT, LISTEN_IP, () => {
  console.log("[vless] listening on " + LISTEN_IP + ":" + LISTEN_PORT);
  if (generated) {
    console.log("[vless] no VLESS_UUID provided, generated VLESS_UUID=" + uuidDashed(VLESS_UUID));
  } else {
    console.log("[vless] using VLESS_UUID from environment");
  }
  console.log("[vless] WS_PATH=" + WS_PATH);
});

// ---- minimal WebSocket connection wrapper (server side) ----
class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.onmessage = null;
    this.onclose = null;
    this.dead = false;
    socket.on("data", (d) => this.feed(d));
    socket.on("close", () => this.die());
    socket.on("error", () => this.die());
  }
  die() {
    if (this.dead) return;
    this.dead = true;
    if (this.onclose) { const f = this.onclose; this.onclose = null; try { f(); } catch (_) {} }
  }
  feed(d) {
    if (this.dead) return;
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const hi = this.buf.readUInt32BE(2), lo = this.buf.readUInt32BE(6);
        if (hi > 0x1fffff) { this.close(); return; } // absurd size guard
        len = hi * 0x100000000 + lo; off = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4); off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (masked) {
        const u = Buffer.from(payload);
        for (let i = 0; i < u.length; i++) u[i] ^= mask[i & 3];
        payload = u;
      }
      if (opcode === 0x8) { this.close(); return; }        // close frame
      if (opcode === 0x9) { this.pong(payload); continue; } // ping -> pong
      if (opcode === 0xa) continue;                          // pong, ignore
      if ((opcode === 0x2 || opcode === 0x0) && this.onmessage) {
        try { this.onmessage(payload); } catch (_) { this.close(); return; }
      }
      // other opcodes ignored
    }
  }
  frame(opcode, data) {
    const b = Buffer.from(data);
    let head;
    if (b.length < 126) { head = Buffer.alloc(2); head[0] = 0x80 | opcode; head[1] = b.length; }
    else if (b.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(b.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(b.length), 2); }
    try { this.socket.write(Buffer.concat([head, b])); } catch (_) {}
  }
  send(data) { this.frame(0x2, data); }   // binary
  pong(data) { this.frame(0xa, data || Buffer.alloc(0)); }
  close() {
    if (this.dead) return;
    try { this.frame(0x8, Buffer.alloc(0)); } catch (_) {}
    try { this.socket.end(); } catch (_) {}
    this.die();
  }
}

// ---- VLESS session ----
function handleVless(ws) {
  let remote = null;
  let headerDone = false;
  let closed = false;
  let chain = Promise.resolve();

  const fail = () => {
    if (closed) return;
    closed = true;
    try { if (remote) remote.destroy(); } catch (_) {}
    try { ws.close(); } catch (_) {}
  };
  const toRemote = (bytes) => {
    chain = chain.then(() => new Promise((res, rej) => {
      if (!remote || remote.destroyed) return rej(new Error("no remote"));
      remote.write(bytes, (e) => (e ? rej(e) : res()));
    })).catch(fail);
  };
  const pumpRemote = () => {
    remote.on("data", (chunk) => { if (!closed) ws.send(chunk); });
    remote.on("error", fail);
    remote.on("close", fail);
  };

  ws.onmessage = (payload) => {
    if (closed) return;
    (async () => {
      const bytes = new Uint8Array(payload);
      if (!headerDone) {
        const h = parseVlessHeader(bytes);
        if (!h.ok || h.isUDP) return fail();
        headerDone = true;
        remote = net.connect(h.port, h.addr);
        await new Promise((res, rej) => {
          remote.once("connect", res);
          remote.once("error", rej);
        });
        // VLESS response header goes back to the CLIENT over the WebSocket,
        // never to the remote target.
        ws.send(Buffer.from([h.version, 0]));
        pumpRemote();
        const rest = payload.subarray(h.dataStart);
        if (rest.length > 0) toRemote(rest);
      } else {
        if (!remote) return fail();
        toRemote(payload);
      }
    })().catch(fail);
  };
  ws.onclose = fail;
}

function parseVlessHeader(bytes) {
  if (bytes.byteLength < 26) return { ok: false };
  const version = bytes[0];
  let uuidHex = "";
  for (let i = 1; i < 17; i++) uuidHex += bytes[i].toString(16).padStart(2, "0");
  if (uuidHex !== VLESS_UUID) return { ok: false };

  const addonLen = bytes[17];
  let i = 18 + addonLen;
  if (i + 4 > bytes.byteLength) return { ok: false };
  const cmd = bytes[i++];
  const port = (bytes[i] << 8) | bytes[i + 1];
  i += 2;
  const atyp = bytes[i++];
  let addr = "";

  if (atyp === 1) {
    if (i + 4 > bytes.byteLength) return { ok: false };
    addr = bytes[i] + "." + bytes[i + 1] + "." + bytes[i + 2] + "." + bytes[i + 3];
    i += 4;
  } else if (atyp === 2) {
    const len = bytes[i++];
    if (i + len > bytes.byteLength) return { ok: false };
    addr = Buffer.from(bytes.subarray(i, i + len)).toString("utf8");
    i += len;
  } else if (atyp === 3) {
    if (i + 16 > bytes.byteLength) return { ok: false };
    const parts = [];
    for (let k = 0; k < 8; k++) {
      parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
      i += 2;
    }
    addr = parts.join(":");
  } else {
    return { ok: false };
  }

  if (cmd !== 1 && cmd !== 2) return { ok: false };
  return { ok: true, version, addr, port, isUDP: cmd === 2, dataStart: i };
}
