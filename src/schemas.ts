import { z } from "zod";

export const VpsPlanSchema = z.object({
  plan_name: z.string().min(1),
  vcpu: z.number().positive().transform((v) => Math.max(1, Math.round(v))),
  ram_gb: z.number().positive().transform((v) => Math.max(1, Math.round(v))),
  nvme_gb: z.number().positive().transform((v) => Math.max(1, Math.round(v))),
  region: z.string().min(1),
  os_options: z.array(z.string().min(1)).min(1),
  price_monthly: z.number().positive(),
});

export type VpsPlan = z.infer<typeof VpsPlanSchema>;

export const VendorGuideSchema = z.object({
  category: z.enum([
    "hardware_specs",
    "network_policy",
    "licensing",
    "troubleshooting",
    "sla_support",
    "locations",
    "provisioning",
  ]),
  title: z.string().min(1),
  content: z.string().min(20),
});

export const VendorSpecSchema = z.object({
  vendor: z.enum(["rabisu", "hyonix"]),
  source_urls: z.array(z.string()),
  cpu_family: z.string().min(1),
  storage_type: z.string().min(1),
  network_port_gbps: z.number().positive(),
  bandwidth_policy: z.string().min(1),
  uptime_sla_percent: z.number().min(90).max(100),
  max_provisioning_minutes: z.number().positive(),
  ddos_protection: z.boolean(),
  windows_licensed_included: z.boolean(),
  linux_supported: z.boolean(),
  windows_supported: z.boolean(),
  full_root_rdp_access: z.boolean(),
  ipv4_included: z.number().int().nonnegative(),
  locations: z.array(z.string().min(1)),
  guides: z.array(VendorGuideSchema),
});

export type VendorSpec = z.infer<typeof VendorSpecSchema>;

export const KbDocSchema = z.object({
  category: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(20),
});

export type KbDoc = z.infer<typeof KbDocSchema>;

export const StagedPlansFileSchema = z.object({
  generated_at: z.string(),
  source: z.string(),
  plans: z.array(VpsPlanSchema).min(1),
});

export const StagedKbFileSchema = z.object({
  generated_at: z.string(),
  baseline_summary: z.record(z.string(), z.unknown()),
  docs: z.array(KbDocSchema).min(1),
});
