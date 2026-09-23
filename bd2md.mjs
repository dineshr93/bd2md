// Usage:
//   node bd2md.mjs <url> [<url> ...]
//   node bd2md.mjs -f urls.txt
// Output: ./md/<slug>.md
// Converter: env HTML2MD (default "html-to-markdown"), reads HTML on stdin, writes MD on stdout.
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
let urls = [];
if (args[0] === "-f") {
  urls = readFileSync(args[1], "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
} else urls = args;
if (!urls.length) { console.error("no urls"); process.exit(1); }

const CONV = (process.env.HTML2MD || "html-to-markdown").split(" ");
const OUT = "md";
mkdirSync(OUT, { recursive: true });

const isContent = (r) => /\/api\/khub\/maps\/[^/]+\/topics\/[^/]+\/content/.test(r.url()) && r.status() === 200;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
});

for (const url of urls) {
  const page = await ctx.newPage();
  try {
    const [res] = await Promise.all([
      page.waitForResponse(isContent, { timeout: 45000 }),
      page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }),
    ]);
    const html = await res.text();
    let title = (await page.title()).replace(/\s*[|\-–]\s*(Black Duck.*|Bridge CLI Guide)$/i, "").trim();

    const r = spawnSync(CONV[0], CONV.slice(1), { input: html, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error("converter failed: " + (r.stderr || r.error));

    const slug = new URL(url).pathname.split("/").pop().replace(/\.html$/, "") || "index";
    const md = `# ${title}\n\nSource: ${url}\n\n${r.stdout.trim()}\n`;
    writeFileSync(`${OUT}/${slug}.md`, md);
    console.log(`ok   ${url} -> ${OUT}/${slug}.md`);
  } catch (e) {
    console.log(`FAIL ${url}: ${e.message}`);
  } finally {
    await page.close();
  }
}
await browser.close();
