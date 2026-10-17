// The smallest useful server: POST audio to /transcribe, get { text } back. Your app's real
// endpoint does the same after checking who is asking.
//
//   FLATLINE_URL=http://127.0.0.1:8086 node examples/node-server.mjs
//   curl --data-binary @memo.m4a -H 'content-type: audio/mp4' localhost:3030/transcribe
import { createServer } from "node:http";
import { createTranscriber } from "flatline/server";

const stt = createTranscriber({ url: process.env.FLATLINE_URL });
const MAX = 25 * 1024 * 1024;

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/transcribe") return json(res, 404, { error: "Not found." });
  // Read the body, refusing anything too big before it is all in memory.
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX) return json(res, 413, { error: "That recording is too long." });
    chunks.push(c);
  }
  const r = await stt.transcribe(new Uint8Array(Buffer.concat(chunks)), req.headers["content-type"]);
  if (r.ok) return json(res, 200, { text: r.text });
  const status = { unavailable: 503, timeout: 504, too_large: 413, empty: 400, bad_response: 502 }[r.code] ?? 500;
  json(res, status, { error: r.error });
}).listen(Number(process.env.PORT ?? 3030), "127.0.0.1", () => console.log(`listening on 127.0.0.1:${process.env.PORT ?? 3030}`));
