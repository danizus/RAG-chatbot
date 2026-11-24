import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  VpsPlanSchema,
  VendorSpecSchema,
  StagedPlansFileSchema,
  StagedKbFileSchema,
  type VpsPlan,
  type VendorSpec,
  type KbDoc,
} from "./schemas.js";
import { sanitizeText, assertNoVendorLeaks } from "./scrubber.js";

const RAW_DIR = path.resolve("data/raw");
const STAGED_DIR = path.resolve("data/staged");

const RawHostDestinySchema = z.object({
  scraped_at: z.string(),
  plans: z.array(VpsPlanSchema).min(1),
});

interface MinimumBaseline {
  cpu_floor: string;
  storage_floor: string;
  network_port_gbps: number;
  uptime_sla_percent: number;
  max_provisioning_minutes: number;
  ipv4_included: number;
  ddos_protection: boolean;
  full_root_rdp_access: boolean;
  windows_licensed_on_all_vendors: boolean;
  windows_supported: boolean;
  linux_supported: boolean;
  bandwidth_note: string;
}

/**
 * Deterministic reconciliation:
 * Takes the conservative "minimum guarantee" across both upstream vendors
 * so HostDestiny under-promises and over-delivers regardless of which node fulfills a VPS.
 */
function computeMinimumBaseline(rabisu: VendorSpec, hyonix: VendorSpec): MinimumBaseline {
  return {
    cpu_floor: "High-frequency enterprise AMD x86_64 vCPUs (EPYC / Ryzen class)",
    storage_floor: "Enterprise NVMe SSD storage",
    network_port_gbps: Math.min(rabisu.network_port_gbps, hyonix.network_port_gbps),
    uptime_sla_percent: Math.min(rabisu.uptime_sla_percent, hyonix.uptime_sla_percent),
    // Conservative SLA for delivery time = the slower (larger) provisioning window
    max_provisioning_minutes: Math.max(
      rabisu.max_provisioning_minutes,
      hyonix.max_provisioning_minutes
    ),
    ipv4_included: Math.min(rabisu.ipv4_included, hyonix.ipv4_included),
    ddos_protection: rabisu.ddos_protection && hyonix.ddos_protection,
    full_root_rdp_access: rabisu.full_root_rdp_access && hyonix.full_root_rdp_access,
    windows_licensed_on_all_vendors:
      rabisu.windows_licensed_included && hyonix.windows_licensed_included,
    windows_supported: rabisu.windows_supported || hyonix.windows_supported,
    linux_supported: rabisu.linux_supported || hyonix.linux_supported,
    bandwidth_note:
      "Generous high-speed bandwidth with fair-use network management on sustained heavy utilization to keep latency low for all customers.",
  };
}

function scrubPlan(plan: VpsPlan, index: number): VpsPlan {
  const clean: VpsPlan = {
    plan_name: sanitizeText(plan.plan_name),
    vcpu: plan.vcpu,
    ram_gb: plan.ram_gb,
    nvme_gb: plan.nvme_gb,
    region: sanitizeText(plan.region),
    os_options: plan.os_options.map((os) => sanitizeText(os)),
    price_monthly: Number(plan.price_monthly.toFixed(2)),
  };

  assertNoVendorLeaks(JSON.stringify(clean), `vps_plan[${index}] ${clean.plan_name}`);
  return clean;
}

function buildBaselineKbDocs(
  baseline: MinimumBaseline,
  plans: VpsPlan[],
  vendors: VendorSpec[]
): KbDoc[] {
  const docs: KbDoc[] = [];

  // 1. Guaranteed Infrastructure Baseline (Minimum of Both Vendors)
  docs.push({
    category: "hardware_specs",
    title: "HostDestiny Guaranteed VPS Hardware & Network Specifications",
    content: [
      `All HostDestiny VPS plans meet or exceed our guaranteed infrastructure baseline:`,
      `- Compute: ${baseline.cpu_floor} with dedicated vCPU allocation.`,
      `- Storage: ${baseline.storage_floor} for fast boot times and database I/O.`,
      `- Network Uplink: At least ${baseline.network_port_gbps} Gbps port speed (many locations deliver higher burst/uplink capacity). ${baseline.bandwidth_note}`,
      `- IPv4: Includes at least ${baseline.ipv4_included} dedicated IPv4 address per VPS.`,
      `- Access: ${baseline.full_root_rdp_access ? "Full root SSH access (Linux) and full Administrator RDP access (Windows) are included on every VPS." : "Administrative access is provided via SSH or RDP."}`,
      `- DDoS Protection: ${baseline.ddos_protection ? "Built-in DDoS mitigation is included on all VPS nodes." : "Network-level DDoS protection is available depending on location."}`,
    ].join("\n"),
  });

  // 2. SLA & Provisioning Guarantee
  docs.push({
    category: "sla_support",
    title: "HostDestiny Uptime SLA, Provisioning Time & OS Support",
    content: [
      `HostDestiny commits to a minimum ${baseline.uptime_sla_percent}% network uptime SLA across our VPS locations.`,
      `Standard VPS deployment is automated and completes within ${baseline.max_provisioning_minutes} minute(s) after payment confirmation (most deployments complete in under 60 seconds).`,
      `Supported Operating Systems: ${[
        baseline.linux_supported ? "Linux distributions (Ubuntu, Debian, AlmaLinux, etc.)" : "",
        baseline.windows_supported ? "Windows Server (RDP)" : "",
      ]
        .filter(Boolean)
        .join(" and ")}.`,
      baseline.windows_licensed_on_all_vendors
        ? "Licensed Windows Server is included on Windows VPS plans with no separate license key required."
        : "Windows Server plans include pre-installed Windows Server; check your specific plan tier for whether SPLA/KMS licensing is bundled or bring-your-own-license.",
    ].join("\n"),
  });

  // 3. Locations & Regional Plan Overview (derived from real HostDestiny plans)
  const byRegion = new Map<string, VpsPlan[]>();
  for (const p of plans) {
    const list = byRegion.get(p.region) ?? [];
    list.push(p);
    byRegion.set(p.region, list);
  }
  const regionLines = [...byRegion.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([region, regionPlans]) => {
      const minPrice = Math.min(...regionPlans.map((p) => p.price_monthly));
      const maxPrice = Math.max(...regionPlans.map((p) => p.price_monthly));
      const minRam = Math.min(...regionPlans.map((p) => p.ram_gb));
      const maxRam = Math.max(...regionPlans.map((p) => p.ram_gb));
      return `- ${region}: ${regionPlans.length} plan(s), ${minRam}GB–${maxRam}GB RAM, $${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)}/month`;
    });

  docs.push({
    category: "locations",
    title: "HostDestiny VPS Locations and Regional Pricing Overview",
    content: [
      `HostDestiny currently offers ${plans.length} VPS plans across ${byRegion.size} location(s):`,
      ...regionLines,
      `For exact real-time specs, OS availability, and monthly pricing for a specific tier, query the VPS plans catalog directly.`,
    ].join("\n"),
  });

  // 4. Core Troubleshooting & Network Policy Docs (preserved & white-labeled)
  docs.push(
    {
      category: "troubleshooting",
      title: "Fixing Windows VPS Time Zone Resetting After Reboot",
      content:
        "If your Windows VPS clock resets after a reboot, the hypervisor exposes the hardware clock in UTC while Windows expects local time by default. Fix this by opening PowerShell as Administrator and running: reg add HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation /v RealTimeIsUniversal /t REG_DWORD /d 1 /f and then rebooting the VPS.",
    },
    {
      category: "troubleshooting",
      title: "Setting the Correct Time Zone on a Linux VPS",
      content:
        "To check or fix the time zone on a Linux VPS, run `timedatectl` to inspect the current zone. Set your desired zone with `sudo timedatectl set-timezone Region/City` (for example, `sudo timedatectl set-timezone America/New_York`) and verify that NTP synchronization is active.",
    },
    {
      category: "network_policy",
      title: "Outbound SMTP Port 25 Policy",
      content:
        "Outbound SMTP Port 25 may be restricted by default on new VPS instances to prevent spam and protect IP reputation. Customers can submit a support ticket through the HostDestiny client portal to request Port 25 unblocking after account verification and good standing, or use authenticated SMTP submission ports (587 / 465) via a transactional email relay.",
    }
  );

  // 5. Only include non-conflicting operational/troubleshooting guides from vendors
  // (We intentionally exclude individual vendor hardware/network/SLA/licensing marketing claims
  //  so RAG can NEVER over-promise above the reconciled minimum baseline.)
  const SAFE_VENDOR_GUIDE_CATEGORIES = new Set(["troubleshooting"]);
  const seenTitles = new Set<string>(docs.map((d) => d.title.toLowerCase()));
  for (const vendor of vendors) {
    for (const guide of vendor.guides) {
      if (!SAFE_VENDOR_GUIDE_CATEGORIES.has(guide.category)) continue;

      const cleanTitle = sanitizeText(guide.title);
      const cleanContent = sanitizeText(guide.content);

      assertNoVendorLeaks(cleanTitle, `${vendor.vendor} guide title`);
      assertNoVendorLeaks(cleanContent, `${vendor.vendor} guide "${cleanTitle}"`);

      const key = cleanTitle.toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);

      docs.push({
        category: guide.category,
        title: cleanTitle,
        content: cleanContent,
      });
    }
  }

  return docs;
}

async function main() {
  console.log("Loading extracted files from data/raw/...");
  const [hdRaw, rabisuRaw, hyonixRaw] = await Promise.all([
    fs.readFile(path.join(RAW_DIR, "hostdestiny.extracted.json"), "utf8"),
    fs.readFile(path.join(RAW_DIR, "rabisu.extracted.json"), "utf8"),
    fs.readFile(path.join(RAW_DIR, "hyonix.extracted.json"), "utf8"),
  ]);

  const hd = RawHostDestinySchema.parse(JSON.parse(hdRaw));
  const rabisu = VendorSpecSchema.parse(JSON.parse(rabisuRaw));
  const hyonix = VendorSpecSchema.parse(JSON.parse(hyonixRaw));

  console.log("Computing conservative minimum baseline across both vendors...");
  const baseline = computeMinimumBaseline(rabisu, hyonix);
  console.log("  Minimum Baseline:", baseline);

  const cleanPlans = hd.plans.map((p, idx) => scrubPlan(p, idx));
  const cleanDocs = buildBaselineKbDocs(baseline, cleanPlans, [rabisu, hyonix]);

  // Final leak sweep across every staged doc
  for (const doc of cleanDocs) {
    assertNoVendorLeaks(doc.title, `staged doc title`);
    assertNoVendorLeaks(doc.content, `staged doc "${doc.title}"`);
  }

  await fs.mkdir(STAGED_DIR, { recursive: true });

  const stagedPlans = StagedPlansFileSchema.parse({
    generated_at: new Date().toISOString(),
    source: "https://www.hostdestiny.com/",
    plans: cleanPlans,
  });

  const stagedKb = StagedKbFileSchema.parse({
    generated_at: new Date().toISOString(),
    baseline_summary: baseline as unknown as Record<string, unknown>,
    docs: cleanDocs,
  });

  await fs.writeFile(
    path.join(STAGED_DIR, "plans.json"),
    JSON.stringify(stagedPlans, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(STAGED_DIR, "kb.json"),
    JSON.stringify(stagedKb, null, 2),
    "utf8"
  );

  console.log(
    `\nReconciliation complete!\n  Staged ${stagedPlans.plans.length} VPS plans -> data/staged/plans.json\n  Staged ${stagedKb.docs.length} KB docs -> data/staged/kb.json\n  Zero vendor leaks detected.`
  );
}

main().catch((err) => {
  console.error("Reconcile failed:", err);
  process.exit(1);
});
