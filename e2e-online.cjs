const { chromium } = require("playwright");

const URL = process.argv[2] || "http://localhost:4173/";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const A = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const B = await browser.newPage({ viewport: { width: 420, height: 900 } });
  for (const p of [A, B]) {
    p.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));
    p.on("console", (m) => {
      const t = m.text();
      if (t.includes("mailbox") || t.includes("peer") || t.includes("match") || t.includes("fetch") || t.includes("error") || t.includes("Error"))
        console.log(`CONSOLE(${p === A ? "A" : "B"}):`, t.slice(0, 160));
    });
  }
  await A.goto(URL);
  await B.goto(URL);

  const body = async (p) => (await p.locator("body").innerText()).replace(/\n+/g, " | ");
  const FILE = process.env.TEMP + "\\semaphore-light-test\\hello.txt";

  await A.locator("button", { hasText: "Send" }).first().click();
  await A.waitForTimeout(400);
  await A.locator("input[type=file]").setInputFiles(FILE);
  await A.waitForTimeout(400);
  await A.locator("button", { hasText: /Online link/i }).first().click();
  await A.waitForTimeout(2500);

  const aBody = await body(A);
  console.log("A online screen:", aBody.slice(0, 120));
  const m = aBody.match(/([0-9a-f]{16})/);
  if (!m) {
    console.log("FATAL: no link id on A");
    process.exit(1);
  }
  const sid = m[1];
  console.log("sid:", sid);

  const link = URL.split("#")[0] + "#" + sid;
  await B.goto(link);
  await B.waitForTimeout(2500);

  const bBody = await body(B);
  console.log("B opened link:", bBody.slice(0, 160));
  await B.locator("button", { hasText: "These words match" }).first().click();
  await B.waitForTimeout(2000);
  const net = await (await import("https")).default ?? null;
  const peerUrl = `https://semaphore-tau.vercel.app/api/mailbox?route=${sid}&route=peer`;
  const goUrl = `https://semaphore-tau.vercel.app/api/mailbox?route=${sid}&route=go`;
  console.log("peer mailbox:", await (await fetch(peerUrl)).text());
  console.log("go mailbox:", await (await fetch(goUrl)).text());

  let aMatched = false;
  const probe = await A.evaluate(async (sid) => {
    const url = `/api/mailbox?route=${sid}&route=peer`;
    let res = null;
    try {
      const r = await fetch(url);
      res = { status: r.status, body: await r.text() };
    } catch (e) {
      res = { err: String(e) };
    }
    return res;
  }, sid);
  console.log("A-side peer fetch:", JSON.stringify(probe).slice(0, 300));
  for (let i = 0; i < 25 && !aMatched; i++) {
    await A.waitForTimeout(1000);
    if ((await body(A)).includes("It's a match")) aMatched = true;
  }
  console.log("A matched:", aMatched);
  if (!aMatched) process.exit(1);
  await A.locator("button", { hasText: "Start sending" }).first().click();

  for (let i = 0; i < 40; i++) {
    await A.waitForTimeout(1000);
    const b = await body(B);
    const a = await body(A);
    if (i % 3 === 0) console.log(`t+${i + 1}s A:${a.slice(0, 34)} B:${b.slice(0, 44)}`);
    if (/Open file|100%/.test(b) || /Couldn't receive/.test(b)) {
      console.log(`FINAL A:${a.slice(0, 40)} B:${b.slice(0, 60)}`);
      break;
    }
  }
  await browser.close();
})().catch((e) => { console.log("FATAL:", String(e).slice(0, 600)); process.exit(1); });