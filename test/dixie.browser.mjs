// Dixie in a real Chromium, with the page's speechSynthesis replaced by a stand-in that behaves
// like Chrome's (it reports a cancelled sentence as "ended", the case that is easy to get wrong)
// and records what it was asked to say. Run with `npm run test:browser`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve, micBrowser } from "./helpers.mjs";

let site, browser, context;
before(async () => {
  site = await serve();
  ({ browser, context } = await micBrowser([[0.3, 0], [1, 0.5], [3, 0]]));
});
after(async () => { await browser?.close(); site?.close(); });

/** The stand-in: each sentence "takes" `ms`; "never" never ends (Safari's long-sentence bug). */
function fakeSpeech(ms) {
  const fake = {
    said: [], cancels: 0, cur: null, t: null,
    getVoices: () => [{ name: "Ava (Enhanced)", lang: "en-US", localService: true, default: true }],
    addEventListener() {}, removeEventListener() {},
    speak(u) {
      fake.cur = u; fake.said.push({ text: u.text, lang: u.lang, rate: u.rate });
      if (ms !== "never") fake.t = setTimeout(() => { fake.cur = null; u.onend?.({}); }, ms);
    },
    cancel() {
      fake.cancels++; clearTimeout(fake.t);
      const u = fake.cur; fake.cur = null;
      if (u) setTimeout(() => u.onend?.({}), 0);   // Chrome: a cancel looks like an end
    },
  };
  Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
  window.__speech = fake;
}

async function page(ms = 300) {
  const p = await context.newPage();
  await p.addInitScript(fakeSpeech, ms);
  await p.goto(site.url);
  return p;
}

test("speak resolves when she has finished", async () => {
  const p = await page(300);
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    const t = performance.now();
    const during = (() => { const pr = dixie.speak("When does your day start?", { rate: 1.1 }); return { pr, speaking: dixie.speaking() }; })();
    const out = await during.pr;
    return { out, speaking: during.speaking, after: dixie.speaking(), ms: performance.now() - t, said: window.__speech.said };
  });
  assert.equal(r.out, "done");
  assert.equal(r.speaking, true);
  assert.equal(r.after, false);
  assert.ok(r.ms >= 280, `resolved after ${r.ms} ms`);
  assert.equal(r.said.length, 1);
  assert.equal(r.said[0].text, "When does your day start?");
  assert.equal(r.said[0].lang, "en-US");   // the chosen voice's language
  assert.ok(Math.abs(r.said[0].rate - 1.1) < 0.01);
});

test("hush() stops her, and speak resolves \"cancelled\" (even though the browser says \"ended\")", async () => {
  const p = await page(2000);
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    const pr = dixie.speak("A long question about your mornings.");
    await new Promise((x) => setTimeout(x, 100));
    dixie.hush();
    return { out: await pr, speaking: dixie.speaking() };
  });
  assert.deepEqual(r, { out: "cancelled", speaking: false });
});

test("a new sentence cuts off the last one", async () => {
  const p = await page(500);
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    const first = dixie.speak("One.");
    const second = dixie.speak("Two.");
    return [await first, await second];
  });
  assert.deepEqual(r, ["cancelled", "done"]);
});

test("tapping the mic (record) stops her talking", { timeout: 60_000 }, async () => {
  const p = await page(5000);
  const r = await p.evaluate(async () => {
    const { dixie, record } = await import("/dist/browser/index.js");
    const pr = dixie.speak("What would you like help with?");
    const rec = record();
    const said = await pr;
    rec.cancel();
    return { said, cancels: window.__speech.cancels };
  });
  assert.equal(r.said, "cancelled");
  assert.ok(r.cancels >= 1);
});

test("if the browser never says it finished (Safari), it still resolves", { timeout: 20_000 }, async () => {
  const p = await page("never");
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    const t = performance.now();
    return { out: await dixie.speak("Hi."), ms: performance.now() - t };
  });
  assert.equal(r.out, "done");
  assert.ok(r.ms >= 3000 && r.ms < 5000, `${r.ms} ms`);
});

test("empty text is done at once; no speech in the browser is \"unavailable\"", async () => {
  const p = await context.newPage();
  await p.addInitScript(() => { Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true }); delete window.speechSynthesis; });
  await p.goto(site.url);
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    return [await dixie.speak("   "), await dixie.speak("Hello"), dixie.canSpeak()];
  });
  assert.deepEqual(r, ["done", "unavailable", false]);
});

// --- her own voice, from a server endpoint -----------------------------------------------------

import { wav } from "./helpers.mjs";

/** A stand-in voice endpoint: audio of `seconds`, after `delay` ms, or an error status. */
function voiceRoutes(log) {
  const audio = (seconds) => wav([[seconds, 0.3]]);
  const reply = (status, seconds, delay = 0) => async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    log.push({ path: req.url, body: JSON.parse(body || "{}"), session: req.headers["x-session"] ?? null });
    setTimeout(() => {
      if (status !== 200) { res.writeHead(status, { "content-type": "application/json" }); res.end('{"error":"no"}'); return; }
      res.writeHead(200, { "content-type": "audio/wav" }); res.end(audio(seconds));
    }, delay);
  };
  return {
    "POST /speak": reply(200, 0.6),
    "POST /speak-long": reply(200, 5),
    "POST /speak-slow": reply(200, 0.5, 3000),
    "POST /speak-down": reply(503, 0),
  };
}

let voiceSite;
const voiceLog = [];
before(async () => { voiceSite = await serve(voiceRoutes(voiceLog)); });
after(() => voiceSite?.close());

async function voicePage() {
  const p = await context.newPage();
  await p.addInitScript(fakeSpeech, 200);
  await p.goto(voiceSite.url);
  return p;
}

test("with an endpoint, she plays the server's voice and resolves when it ends", { timeout: 30_000 }, async () => {
  voiceLog.length = 0;
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    dixie.configure({ endpoint: "/speak", headers: { "x-session": "s1" } });
    const t = performance.now();
    const out = await dixie.speak("Listen to me.");
    return { out, ms: performance.now() - t, phoneSaid: window.__speech.said.length };
  });
  assert.equal(r.out, "done");
  assert.ok(r.ms >= 550, `resolved after ${r.ms} ms`);
  assert.equal(r.phoneSaid, 0, "the phone's voice wasn't used");
  assert.deepEqual(voiceLog[0], { path: "/speak", body: { text: "Listen to me.", format: "mp3" }, session: "s1" });
});

test("a character's preset goes to the endpoint when one is set (configure, or per call)", { timeout: 30_000 }, async () => {
  voiceLog.length = 0;
  const p = await voicePage();
  await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    dixie.configure({ endpoint: "/speak", preset: "kestrel" });
    await dixie.speak("Objective.");
    await dixie.speak("Hello.", { preset: "hoshi" });
  });
  assert.deepEqual(voiceLog.map((v) => v.body.preset), ["kestrel", "hoshi"]);
});

test("hush() stops the server's voice mid-sentence: \"cancelled\", and the player stops", { timeout: 30_000 }, async () => {
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    dixie.configure({ endpoint: "/speak-long" });
    const pr = dixie.speak("A long one.");
    await new Promise((x) => setTimeout(x, 1200));
    dixie.hush();
    return { out: await pr, speaking: dixie.speaking() };
  });
  assert.deepEqual([r.out, r.speaking], ["cancelled", false]);
});

test("record() stops her too, even while the audio is still on its way", { timeout: 30_000 }, async () => {
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie, record } = await import("/dist/browser/index.js");
    dixie.configure({ endpoint: "/speak-slow" });
    const pr = dixie.speak("Slow to arrive.");
    await new Promise((x) => setTimeout(x, 300));
    const rec = record();
    const out = await pr;
    rec.cancel();
    return { out, phoneSaid: window.__speech.said.length };
  });
  assert.deepEqual(r, { out: "cancelled", phoneSaid: 0 });
});

test("a newer sentence cuts off the server's voice", { timeout: 30_000 }, async () => {
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    dixie.configure({ endpoint: "/speak-long" });
    const first = dixie.speak("One.");
    await new Promise((x) => setTimeout(x, 500));
    const second = dixie.speak("Two.", { endpoint: "/speak" });
    return [await first, await second];
  });
  assert.deepEqual(r, ["cancelled", "done"]);
});

test("the server can't speak (an error, or it's down): the phone's voice says it instead", { timeout: 30_000 }, async () => {
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    const a = await dixie.speak("From the phone.", { endpoint: "/speak-down" });
    const b = await dixie.speak("Also the phone.", { endpoint: "http://127.0.0.1:9/speak" });
    return { a, b, said: window.__speech.said.map((s) => s.text) };
  });
  assert.deepEqual(r, { a: "done", b: "done", said: ["From the phone.", "Also the phone."] });
});

test("too slow: after timeoutMs the phone's voice takes over", { timeout: 30_000 }, async () => {
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    const t = performance.now();
    const out = await dixie.speak("Hurry.", { endpoint: "/speak-slow", timeoutMs: 800 });
    return { out, ms: performance.now() - t, said: window.__speech.said.map((s) => s.text) };
  });
  assert.equal(r.out, "done");
  assert.deepEqual(r.said, ["Hurry."]);
  assert.ok(r.ms < 2500, `${r.ms} ms`);
});

test("endpoint: null uses the phone's voice even when configured", async () => {
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    dixie.configure({ endpoint: "/speak" });
    return { out: await dixie.speak("Local.", { endpoint: null }), said: window.__speech.said.length };
  });
  assert.deepEqual(r, { out: "done", said: 1 });
});

// --- a refused play(), the unlock, and the choice not to fall back -------------------------------

/** Chrome refuses sound no tap began: play() of anything but the silent unlock rejects. */
function refuseUnlessUnlocked() {
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (this.src.startsWith("blob:") && !window.__tapped) return Promise.reject(new DOMException("play() failed: no user gesture", "NotAllowedError"));
    return play.call(this);
  };
}

test("unlock() is safe to call, and says it worked", async () => {
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    return [dixie.unlock(), dixie.unlock(), dixie.lastVoice()];
  });
  assert.deepEqual(r, [true, true, null]);
});

test("a play() the browser refuses is \"blocked\": not the phone's voice; asking again after a tap works", { timeout: 30_000 }, async () => {
  const p = await voicePage();
  await p.addInitScript(refuseUnlessUnlocked);
  await p.goto(voiceSite.url);
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    dixie.configure({ endpoint: "/speak" });
    const first = await dixie.speak("Nobody tapped.");
    const voiceAfterBlock = dixie.lastVoice(), speakingAfter = dixie.speaking(), phoneSaid = window.__speech.said.length;
    window.__tapped = true;
    const second = await dixie.speak("Now they did.");
    return { first, second, voiceAfterBlock, speakingAfter, phoneSaid, voice: dixie.lastVoice(), phoneSaidAfter: window.__speech.said.length };
  });
  assert.deepEqual(r, { first: "blocked", second: "done", voiceAfterBlock: null, speakingAfter: false, phoneSaid: 0, voice: "server", phoneSaidAfter: 0 });
});

test("fallback: false \u2014 when the server can't speak she says nothing instead of switching voice", { timeout: 30_000 }, async () => {
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    const a = await dixie.speak("Not on the phone.", { endpoint: "/speak-down", fallback: false });
    dixie.configure({ fallback: false });
    const b = await dixie.speak("Nor this.", { endpoint: "http://127.0.0.1:9/speak" });
    dixie.configure({ fallback: true });
    const c = await dixie.speak("This one yes.", { endpoint: "/speak-down" });
    return { a, b, c, said: window.__speech.said.map((s) => s.text), voice: dixie.lastVoice() };
  });
  assert.deepEqual(r, { a: "failed", b: "failed", c: "done", said: ["This one yes."], voice: "phone" });
});

test("lastVoice() says which voice spoke", { timeout: 30_000 }, async () => {
  const p = await voicePage();
  const r = await p.evaluate(async () => {
    const { dixie } = await import("/dist/browser/index.js");
    await dixie.speak("Server.", { endpoint: "/speak" });
    const a = dixie.lastVoice();
    await dixie.speak("Phone.", { endpoint: null });
    return [a, dixie.lastVoice()];
  });
  assert.deepEqual(r, ["server", "phone"]);
});
