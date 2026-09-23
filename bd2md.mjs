// Usage:
//   node bd2md.mjs <url> [<url> ...]
//   node bd2md.mjs -f urls.txt
// Output: ./md/<slug>.md  (+ .debug.html for community pages)
// Converter: env HTML2MD (default "html-to-markdown"), HTML on stdin, MD on stdout.
// Handles: docs.blackduck.com (Fluid Topics API) and community.blackduck.com (Salesforce, DOM scrape).
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const urls = args[0] === "-f"
  ? readFileSync(args[1], "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))
  : args;
if (!urls.length) { console.error("no urls"); process.exit(1); }

const CONV = (process.env.HTML2MD || "html-to-markdown").split(" ");
const OUT = "md";
mkdirSync(OUT, { recursive: true });

const toMd = (html) => {
  const r = spawnSync(CONV[0], CONV.slice(1), { input: html, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("converter failed: " + (r.stderr || r.error));
  return r.stdout.trim();
};

const isContent = (r) =>
  /\/api\/khub\/maps\/[^/]+\/topics\/[^/]+\/content/.test(r.url()) && r.status() === 200;

// ---- docs.blackduck.com ----
async function fetchDocs(page, url) {
  const [res] = await Promise.all([
    page.waitForResponse(isContent, { timeout: 45000 }),
    page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }),
  ]);
  return { html: await res.text(), debug: null };
}

// ---- community.blackduck.com (Salesforce Experience Cloud) ----
async function fetchCommunity(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  try { await page.getByRole("button", { name: /accept all/i }).click({ timeout: 3000 }); } catch {}
  // wait for real article text to appear (shadow DOM aware)
  await page.waitForFunction(() => {
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (/^(LIGHTNING-FORMATTED-RICH-TEXT)$/.test(el.tagName) || el.classList.contains("slds-rich-text-editor__output")) {
          if ((el.textContent || "").trim().length > 200) return true;
        }
        if (el.shadowRoot && walk(el.shadowRoot)) return true;
      }
      return false;
    };
    return walk(document);
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  return await page.evaluate(() => {
    const ser = (n) => {
      if (n.nodeType === 3) return n.textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      if (n.nodeType !== 1) return "";
      const t = n.tagName.toLowerCase();
      if (["script", "style", "link", "svg", "noscript"].includes(t)) return "";
      let attrs = "";
      for (const a of ["href", "src", "alt", "colspan", "rowspan"])
        if (n.hasAttribute(a)) attrs += ` ${a}="${n.getAttribute(a)}"`;
      let inner = n.shadowRoot ? [...n.shadowRoot.childNodes].map(ser).join("") : "";
      inner += [...n.childNodes].map(ser).join("");
      return `<${t}${attrs}>${inner}</${t}>`;
    };
    const all = [];
    const collect = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName === "LIGHTNING-FORMATTED-RICH-TEXT" || el.classList.contains("slds-rich-text-editor__output"))
          all.push(el);
        if (el.shadowRoot) collect(el.shadowRoot);
      }
    };
    collect(document);
    let els = all.filter((e) => (e.textContent || "").trim().length > 50);
    // drop nested duplicates
    els = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
    const h1 = document.querySelector("h1")?.textContent?.trim() || "";
    const body = els.length ? els.map(ser).join("\n") : ser(document.body);
    return { html: body, title: h1, debug: els.length ? null : "no rich-text container found, used full body" };
  });
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  viewport: { width: 1400, height: 1000 },
});

for (const url of urls) {
  const page = await ctx.newPage();
  try {
    const host = new URL(url).hostname;
    const r = host.startsWith("community.") ? await fetchCommunity(page, url) : await fetchDocs(page, url);
    let title = r.title || (await page.title());
    title = title.replace(/\s*[|\-–]\s*(Black Duck.*|Bridge CLI Guide)$/i, "").trim();
    const slug = new URL(url).pathname.split("/").filter(Boolean).pop().replace(/\.html$/, "") || "index";
    if (host.startsWith("community.")) writeFileSync(`${OUT}/${slug}.debug.html`, r.html);
    const md = `# ${title}\n\nSource: ${url}\n\n${toMd(r.html)}\n`;
    writeFileSync(`${OUT}/${slug}.md`, md);
    console.log(`ok   ${url} -> ${OUT}/${slug}.md${r.debug ? "  (WARN: " + r.debug + ")" : ""}`);
  } catch (e) {
    console.log(`FAIL ${url}: ${e.message}`);
  } finally {
    await page.close();
  }
}
await browser.close();
