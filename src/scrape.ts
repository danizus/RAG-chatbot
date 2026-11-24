import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { VpsPlanSchema, VendorSpecSchema, type VpsPlan, type VendorSpec } from "./schemas.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const EXTRACT_MODEL = process.env.GEMINI_EXTRACT_MODEL ?? "gemini-3.5-flash-lite";

const RAW_DIR = path.resolve("data/raw");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchHtml(url: string, timeoutMs = 25000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`  [WARN] ${url} -> HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    const e = err as Error & { cause?: unknown };
    console.warn(`  [WARN] Failed to fetch ${url}: ${e.message}`, e.cause ?? "");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function htmlToReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br|td|th)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const found = new Set<string>();

  const hrefRegex = /(?:href=["']([^"'#]+)["']|<loc>([^<]+)<\/loc>)/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw || raw.startsWith("mailto:") || raw.startsWith("tel:") || raw.startsWith("javascript:")) {
      continue;
    }
    try {
      const resolved = new URL(raw, base);
      if (resolved.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "")) {
        resolved.hash = "";
        if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|pdf|zip)$/i.test(resolved.pathname)) {
          continue;
        }
        found.add(resolved.toString().replace(/\/$/, ""));
      }
    } catch {
      // Ignore malformed URLs
    }
  }
  return [...found];
}

async function discoverHostDestinyVpsUrls(): Promise<string[]> {
  const root = "https://www.hostdestiny.com";
  const candidateUrls = new Set<string>();

  const [homeHtml, sitemapXml] = await Promise.all([
    fetchHtml(root),
    fetchHtml(`${root}/sitemap.xml`),
  ]);

  const allLinks = new Set<string>();
  if (homeHtml) {
    for (const u of extractSameOriginLinks(homeHtml, root)) allLinks.add(u);
  }
  if (sitemapXml) {
    const sitemapLinks = extractSameOriginLinks(sitemapXml, root);
    for (const u of sitemapLinks) {
      if (u.endsWith(".xml")) {
        const subXml = await fetchHtml(u);
        if (subXml) {
          for (const sub of extractSameOriginLinks(subXml, root)) allLinks.add(sub);
        }
      } else {
        allLinks.add(u);
      }
    }
  }

  const vpsRegex = /^\/(vps|linux-vps|windows-vps|rdp|cloud-vps|managed-vps)(\/|$)/i;
  const ignoreRegex = /(wordpress|blog|login|register|cart|checkout|privacy|terms|refund|contact|about|wp-json|feed|author|tag|category)/i;

  for (const link of allLinks) {
    const pathname = new URL(link).pathname;
    if (vpsRegex.test(pathname) && !ignoreRegex.test(pathname)) {
      candidateUrls.add(link);
    }
  }

  const urls = [...candidateUrls].slice(0, 100);
  console.log(`Discovered ${urls.length} HostDestiny VPS URL(s).`);
  return urls;
}

/**
 * Deterministic parser for HostDestiny VPS plan cards.
 * Matches cards of the form:
 *   <Plan Name> From only $<price> USD /mo ... CPU: <n> vCore(s) RAM: <n> GB Storage: <n> GB SSD/NVMe ... Location: <loc> Operating System: <Windows|Linux>
 */
function parseHostDestinyPlansFromText(text: string): VpsPlan[] {
  const flat = text.replace(/\s+/g, " ");
  const plans: VpsPlan[] = [];

  // Capture each plan card deterministically
  const cardRegex =
    /([A-Za-z0-9][A-Za-z0-9 .+\-()]{2,55}?)\s+From only\s+\$([0-9]+(?:\.[0-9]{1,2})?)\s*USD\s*\/mo[\s\S]{0,450}?CPU:\s*([0-9]+)\s*vCores?\s+RAM:\s*([0-9]+(?:\.[0-9]+)?)\s*(GB|MB)\s+Storage:\s*([0-9]+(?:\.[0-9]+)?)\s*(GB|TB)\s*(?:SSD\/NVMe|NVMe|SSD)[\s\S]{0,120}?Location:\s*([A-Za-z][A-Za-z .\-()]{1,40}?)\s+Operating System:\s*(Windows|Linux)/gi;

  let match: RegExpExecArray | null;
  while ((match = cardRegex.exec(flat)) !== null) {
    let rawTitle = (match[1] ?? "").trim();
    // Strip leading marketing badges or location tabs that might precede the card title
    rawTitle = rawTitle
      .replace(/^.*?(?:Most Popular|Locations|Monthly|Annually|Order Now|Operating System:\s*(?:Windows|Linux))\s+/i, "")
      .replace(/^(?:US|UK|PK|CA|AU|IE|NL|DE|SG|JP|HK|FR|SE|GR|MY|NZ|BR|ZA|TR|PT|EG|ID|AE|BG|RO|ES|RU|IN|EE)\s+(?=[A-Z]{2}\s)/, "")
      .trim();

    const price = Number(match[2]);
    const vcpu = Number(match[3]);
    const ramVal = Number(match[4]);
    const ramUnit = (match[5] ?? "GB").toUpperCase();
    const storageVal = Number(match[6]);
    const storageUnit = (match[7] ?? "GB").toUpperCase();
    const region = (match[8] ?? "").trim();
    const osType = (match[9] ?? "").trim();

    const ramGb = ramUnit === "MB" ? Math.max(1, Math.round(ramVal / 1024)) : Math.round(ramVal);
    const nvmeGb = storageUnit === "TB" ? Math.round(storageVal * 1000) : Math.round(storageVal);

    const osOptions =
      osType.toLowerCase() === "windows"
        ? ["Windows Server 2022", "Windows Server 2019"]
        : ["Ubuntu 24.04", "Debian 12", "AlmaLinux 9"];

    // Make plan_name unambiguous across Windows vs Linux
    const planName = rawTitle.toLowerCase().includes(osType.toLowerCase())
      ? rawTitle
      : `${rawTitle} (${osType})`;

    const candidate = VpsPlanSchema.safeParse({
      plan_name: planName,
      vcpu,
      ram_gb: ramGb,
      nvme_gb: nvmeGb,
      region,
      os_options: osOptions,
      price_monthly: price,
    });

    if (candidate.success) {
      plans.push(candidate.data);
    }
  }

  return plans;
}

async function loadLocalFallbackTexts(subfolder: string): Promise<Array<{ source: string; text: string }>> {
  const dir = path.join(RAW_DIR, subfolder);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: Array<{ source: string; text: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(txt|md|html|htm|json)$/i.test(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const content = await fs.readFile(fullPath, "utf8");
      const text = /\.html?$/i.test(entry.name) ? htmlToReadableText(content) : content;
      results.push({ source: fullPath, text });
    }
    return results;
  } catch {
    return [];
  }
}

async function extractJsonWithGemini<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
  const modelsToTry = [
    EXTRACT_MODEL,
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.8-flash",
  ];
  let lastErr: unknown;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`  Calling ${model} (attempt ${attempt}/2)...`);
        const res = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            temperature: 0.1,
          },
        });
        const rawText = res.text;
        if (!rawText) throw new Error("Gemini returned an empty response");
        const parsed = JSON.parse(rawText);
        return schema.parse(parsed);
      } catch (err) {
        lastErr = err;
        const msg = (err as Error).message ?? String(err);
        console.warn(`  [WARN] ${model} failed: ${msg.slice(0, 180)}`);
        const isTransient = /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(msg);
        const isNotFound = /404|NOT_FOUND/i.test(msg);
        if (isNotFound) break;
        if (isTransient && attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        break;
      }
    }
  }

  throw lastErr;
}

async function scrapeHostDestinyPlans(): Promise<VpsPlan[]> {
  console.log("\n=== 1. Scraping HostDestiny VPS Plans (Deterministic Parser) ===");
  const urls = await discoverHostDestinyVpsUrls();
  const allPlans: VpsPlan[] = [];

  const CONCURRENCY = 8;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const slice = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (url) => {
        const html = await fetchHtml(url);
        if (!html) return [];
        const text = htmlToReadableText(html);
        const extracted = parseHostDestinyPlansFromText(text);
        if (extracted.length > 0) {
          console.log(`  ${url} -> ${extracted.length} plan(s)`);
        }
        return extracted;
      })
    );
    for (const list of results) {
      allPlans.push(...list);
    }
  }

  // Deduplicate by (region, os_options[0], vcpu, ram_gb, nvme_gb, price_monthly)
  const uniqueMap = new Map<string, VpsPlan>();
  for (const plan of allPlans) {
    const key = [
      plan.region.toLowerCase().trim(),
      plan.os_options[0]?.toLowerCase() ?? "",
      plan.vcpu,
      plan.ram_gb,
      plan.nvme_gb,
      plan.price_monthly,
    ].join("|");
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, plan);
    }
  }

  const deduped = [...uniqueMap.values()].sort(
    (a, b) => a.region.localeCompare(b.region) || a.price_monthly - b.price_monthly
  );

  console.log(`Total unique HostDestiny plans extracted: ${deduped.length}`);
  if (deduped.length === 0) {
    throw new Error("No HostDestiny VPS plans were parsed. Check page HTML structure.");
  }
  return deduped;
}

async function scrapeVendor(
  vendor: "rabisu" | "hyonix",
  seedUrls: string[]
): Promise<VendorSpec> {
  console.log(`\n=== Scraping Vendor: ${vendor.toUpperCase()} ===`);
  const fetched: Array<{ source: string; text: string }> = [];

  for (const url of seedUrls) {
    const html = await fetchHtml(url);
    if (!html) continue;
    const text = url.endsWith(".txt") ? html : htmlToReadableText(html);
    if (text.length >= 150) {
      fetched.push({ source: url, text: text.slice(0, 10000) });
      console.log(`  Fetched ${url} (${text.length} chars)`);
    }
  }

  const localFallback = await loadLocalFallbackTexts(vendor);
  fetched.push(...localFallback);

  if (fetched.length === 0) {
    throw new Error(
      `Could not fetch any pages for ${vendor}. Save docs into data/raw/${vendor}/ and re-run.`
    );
  }

  const combined = fetched
    .map((f) => `--- SOURCE: ${f.source} ---\n${f.text}`)
    .join("\n\n")
    .slice(0, 22000);

  const prompt = `You are a strict infrastructure analyst extracting VPS vendor capabilities and technical documentation for "${vendor}".

Return ONLY valid JSON matching this exact schema:
{
  "vendor": "${vendor}",
  "source_urls": ${JSON.stringify(fetched.map((f) => f.source))},
  "cpu_family": "string (e.g. 'AMD Ryzen' or 'AMD EPYC')",
  "storage_type": "string (e.g. 'Gen4 NVMe SSD' or 'Pure NVMe SSD')",
  "network_port_gbps": number (conservative guaranteed port speed in Gbps, e.g. 1 or 10 or 100),
  "bandwidth_policy": "string (concise summary of bandwidth / fair-use policy)",
  "uptime_sla_percent": number (between 90 and 100, e.g. 99.9),
  "max_provisioning_minutes": number (e.g. 1 for instant/60s, 15 for manual/standard),
  "ddos_protection": boolean,
  "windows_licensed_included": boolean,
  "linux_supported": boolean,
  "windows_supported": boolean,
  "full_root_rdp_access": boolean,
  "ipv4_included": integer (number of dedicated IPv4 addresses included by default, e.g. 1),
  "locations": ["array of datacenter city/country strings"],
  "guides": [
    {
      "category": "one of: hardware_specs | network_policy | licensing | troubleshooting | sla_support | locations | provisioning",
      "title": "short descriptive title",
      "content": "detailed factual summary (2-4 sentences) based strictly on the provided text"
    }
  ]
}

Rules:
- Base everything strictly on the provided source text.
- If a numeric guarantee (like uptime_sla_percent or network_port_gbps) is not explicitly stated, use a conservative standard value (e.g. 99.9 SLA, 1 Gbps port, 5 minutes provisioning).
- Produce 4 to 6 concise, practical guides covering hardware, network/bandwidth, OS/licensing, provisioning/control panel, and troubleshooting where present.

SOURCES:
${combined}`;

  const spec = await extractJsonWithGemini(prompt, VendorSpecSchema);
  console.log(
    `  Extracted ${vendor}: CPU="${spec.cpu_family}", Port=${spec.network_port_gbps}Gbps, SLA=${spec.uptime_sla_percent}%, Locations=${spec.locations.length}, Guides=${spec.guides.length}`
  );
  return spec;
}

async function main() {
  await fs.mkdir(RAW_DIR, { recursive: true });

  const hostDestinyPlans = await scrapeHostDestinyPlans();
  await fs.writeFile(
    path.join(RAW_DIR, "hostdestiny.extracted.json"),
    JSON.stringify({ scraped_at: new Date().toISOString(), plans: hostDestinyPlans }, null, 2),
    "utf8"
  );

  const rabisuSpec = await scrapeVendor("rabisu", [
    "https://www.rabisu.com/",
    "https://www.rabisu.com/docs/llms.txt",
  ]);
  await fs.writeFile(
    path.join(RAW_DIR, "rabisu.extracted.json"),
    JSON.stringify(rabisuSpec, null, 2),
    "utf8"
  );

  const hyonixSpec = await scrapeVendor("hyonix", [
    "https://hyonix.com/",
    "https://howto.hyonix.com/",
  ]);
  await fs.writeFile(
    path.join(RAW_DIR, "hyonix.extracted.json"),
    JSON.stringify(hyonixSpec, null, 2),
    "utf8"
  );

  console.log("\nScrape complete! Saved extracted files to data/raw/.");
}

main().catch((err) => {
  console.error("Scrape failed:", err);
  process.exit(1);
});
