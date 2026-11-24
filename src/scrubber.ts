export interface ScrubRule {
  pattern: RegExp;
  replacement: string;
}

// Ordered from most-specific (URLs/domains/codes) to general brand names.
// Uses word boundaries (\b) so short codes never corrupt unrelated words.
const SCRUB_RULES: ScrubRule[] = [
  // Vendor URLs & portals
  { pattern: /https?:\/\/(www\.|docs\.|panel\.|my\.|howto\.)?rabisu\.com[^\s)"']*/gi, replacement: "https://www.hostdestiny.com" },
  { pattern: /https?:\/\/(www\.|docs\.|panel\.|my\.|howto\.)?hyonix\.com[^\s)"']*/gi, replacement: "https://www.hostdestiny.com" },
  { pattern: /\b(my|howto|docs|panel)\.hyonix\.com\b/gi, replacement: "the HostDestiny client portal" },
  { pattern: /\b(www\.|docs\.|panel\.)?rabisu\.com\b/gi, replacement: "hostdestiny.com" },
  { pattern: /\b(www\.)?hyonix\.com\b/gi, replacement: "hostdestiny.com" },

  // Vendor brand names (including possessive forms)
  { pattern: /\brabisu(?:'s|’s)?\b/gi, replacement: "HostDestiny" },
  { pattern: /\bhyonix(?:'s|’s)?\b/gi, replacement: "HostDestiny" },
  { pattern: /\bupstreamcorp\b/gi, replacement: "our infrastructure" },

  // Legacy placeholder datacenter tags
  { pattern: /\bvendordc-nyc\b/gi, replacement: "US-East" },
  { pattern: /\bvendordc-fra\b/gi, replacement: "EU-Central" },

  // Hyonix internal tier codes (e.g. HS-1, HS-2)
  { pattern: /\bHS-[1-9]\d*\b/g, replacement: "standard Windows VPS tier" },
];

// Strict post-scrub verification: if any of these remain, abort ingestion.
const BANNED_LEAK_PATTERNS: RegExp[] = [
  /\brabisu\b/i,
  /\bhyonix\b/i,
  /\bupstreamcorp\b/i,
  /\bvendordc/i,
  /rabisu\.com/i,
  /hyonix\.com/i,
];

export function sanitizeText(raw: string): string {
  let clean = raw;
  for (const rule of SCRUB_RULES) {
    clean = clean.replace(rule.pattern, rule.replacement);
  }
  // Collapse accidental double spaces created by replacements
  return clean.replace(/[ \t]{2,}/g, " ").trim();
}

export function findVendorLeaks(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of BANNED_LEAK_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      hits.push(match[0]);
    }
  }
  return hits;
}

export function assertNoVendorLeaks(text: string, context: string): void {
  const leaks = findVendorLeaks(text);
  if (leaks.length > 0) {
    throw new Error(
      `White-label leak check FAILED in [${context}]: found restricted term(s): ${leaks.join(", ")}`
    );
  }
}
