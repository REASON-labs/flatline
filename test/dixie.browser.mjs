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
