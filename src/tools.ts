import { neon } from "@neondatabase/serverless";
import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";

const sql = neon(process.env.DATABASE_URL!);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-2";
const EMBEDDING_DIMS = 1024;

const REGION_ALIASES: Record<string, string> = {
  us: "United States",
  usa: "United States",
  america: "United States",
  uk: "United Kingdom",
  britain: "United Kingdom",
  england: "United Kingdom",
  pk: "Pakistan",
  de: "Germany",
  nl: "Netherlands",
  holland: "Netherlands",
  sg: "Singapore",
  hk: "Hong Kong",
  fr: "France",
  ca: "Canada",
  au: "Australia",
  ie: "Ireland",
  jp: "Japan",
  se: "Sweden",
  gr: "Greece",
  tr: "Turkey",
  bg: "Bulgaria",
  ro: "Romania",
  es: "Spain",
  ru: "Russia",
  in: "India",
  ee: "Estonia",
};

function normalizeRegion(input?: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const alias = REGION_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "search_vps_plans",
    description:
      "Search HostDestiny VPS plans in the Postgres catalog by region/country, OS (Windows or Linux), minimum RAM, minimum vCPU, or maximum monthly price. Always call this before quoting prices or plan specs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        region: {
          type: Type.STRING,
          description:
            "Country or region name (e.g. 'Germany', 'United States', 'Pakistan', 'United Kingdom', 'Singapore').",
        },
        os: {
          type: Type.STRING,
          description: "Operating system filter: 'Windows' or 'Linux'.",
        },
        min_ram_gb: {
          type: Type.NUMBER,
          description: "Minimum RAM in GB (e.g. 4, 8, 12).",
        },
        min_vcpu: {
          type: Type.INTEGER,
          description: "Minimum number of vCPU cores.",
        },
        max_price_monthly: {
          type: Type.NUMBER,
          description: "Maximum monthly price in USD.",
        },
        limit: {
          type: Type.INTEGER,
          description: "Maximum number of plans to return (default 10, max 25).",
        },
      },
    },
  },
  {
    name: "list_available_regions",
    description:
      "List all VPS regions/countries HostDestiny offers, with plan counts and starting monthly prices per region.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "search_knowledge_base",
    description:
      "Semantic vector search over HostDestiny's white-labeled knowledge base for hardware specs, uptime SLA, network/port policies (e.g. SMTP port 25), licensing, and OS troubleshooting steps (e.g. resetting time zone).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Natural-language search query describing the topic or issue.",
        },
      },
      required: ["query"],
    },
  },
];

async function searchVpsPlans(args: Record<string, unknown>) {
  const region = normalizeRegion(typeof args.region === "string" ? args.region : undefined);
  const os = typeof args.os === "string" ? args.os.trim() : null;
  const minRam = typeof args.min_ram_gb === "number" ? args.min_ram_gb : null;
  const minVcpu = typeof args.min_vcpu === "number" ? Math.round(args.min_vcpu) : null;
  const maxPrice = typeof args.max_price_monthly === "number" ? args.max_price_monthly : null;
  const limit =
    typeof args.limit === "number" ? Math.min(25, Math.max(1, Math.round(args.limit))) : 10;

  const regionPattern = region ? `%${region}%` : null;
  const osPattern = os ? `%${os}%` : null;

  const plans = await sql`
    SELECT plan_name, vcpu, ram_gb, nvme_gb, region, os_options, price_monthly::float AS price_monthly
    FROM vps_plans
    WHERE (${regionPattern}::text IS NULL OR region ILIKE ${regionPattern})
      AND (${osPattern}::text IS NULL OR array_to_string(os_options, ',') ILIKE ${osPattern})
      AND (${minRam}::int IS NULL OR ram_gb >= ${minRam})
      AND (${minVcpu}::int IS NULL OR vcpu >= ${minVcpu})
      AND (${maxPrice}::numeric IS NULL OR price_monthly <= ${maxPrice})
    ORDER BY price_monthly ASC, ram_gb ASC
    LIMIT ${limit}
  `;

  if (plans.length === 0) {
    const regions = await sql`
      SELECT DISTINCT region FROM vps_plans ORDER BY region ASC
    `;
    return {
      matched: 0,
      plans: [],
      available_regions: regions.map((r) => r.region),
      note: "No exact plans matched those filters. Suggest closest available regions or adjust filters.",
    };
  }

  return {
    matched: plans.length,
    plans,
  };
}

async function listAvailableRegions() {
  const rows = await sql`
    SELECT region,
           count(*)::int AS plan_count,
           min(price_monthly)::float AS starting_price_monthly,
           min(ram_gb)::int AS min_ram_gb,
           max(ram_gb)::int AS max_ram_gb
    FROM vps_plans
    GROUP BY region
    ORDER BY region ASC
  `;
  return {
    total_regions: rows.length,
    regions: rows,
  };
}

async function searchKnowledgeBase(args: Record<string, unknown>) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { matches: [], note: "Empty query provided." };
  }

  const res = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: query,
    config: {
      outputDimensionality: EMBEDDING_DIMS,
      taskType: "RETRIEVAL_QUERY",
    },
  });

  const values = res.embeddings?.[0]?.values;
  if (!values || values.length !== EMBEDDING_DIMS) {
    throw new Error("Failed to generate query embedding");
  }
  const vec = `[${values.join(",")}]`;

  const rows = await sql`
    SELECT category,
           content,
           round((1 - (embedding <=> ${vec}::vector))::numeric, 4)::float AS similarity
    FROM kb_chunks
    WHERE (1 - (embedding <=> ${vec}::vector)) >= 0.50
    ORDER BY embedding <=> ${vec}::vector
    LIMIT 3
  `;

  return {
    matched: rows.length,
    matches: rows,
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; summary: string }> {
  switch (name) {
    case "search_vps_plans": {
      const result = await searchVpsPlans(args);
      return {
        result,
        summary: `Found ${result.matched} plan(s)`,
      };
    }
    case "list_available_regions": {
      const result = await listAvailableRegions();
      return {
        result,
        summary: `Listed ${result.total_regions} region(s)`,
      };
    }
    case "search_knowledge_base": {
      const result = await searchKnowledgeBase(args);
      return {
        result,
        summary: `Found ${result.matched ?? 0} KB chunk(s)`,
      };
    }
    default:
      return {
        result: { error: `Unknown tool: ${name}` },
        summary: `Unknown tool ${name}`,
      };
  }
}
