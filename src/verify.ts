import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { GoogleGenAI } from "@google/genai";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const mode = process.argv[2] ?? "status";

  // 1. Inspect table schemas
  const cols = await sql`
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('vps_plans', 'kb_chunks')
    ORDER BY table_name, ordinal_position
  `;

  console.log("=== Database Schema ===");
  for (const row of cols) {
    console.log(`  ${row.table_name}.${row.column_name} (${row.data_type} / ${row.udt_name})`);
  }

  // 2. Row counts
  const [planCount] = await sql`SELECT count(*)::int AS count FROM vps_plans`;
  const [kbCount] = await sql`SELECT count(*)::int AS count FROM kb_chunks`;
  console.log(`\n=== Row Counts ===`);
  console.log(`  vps_plans: ${planCount?.count ?? 0}`);
  console.log(`  kb_chunks: ${kbCount?.count ?? 0}`);

  if (mode === "schema") return;

  // 3. Sample rows
  const samplePlans = await sql`
    SELECT plan_name, vcpu, ram_gb, nvme_gb, region, os_options, price_monthly
    FROM vps_plans
    ORDER BY price_monthly ASC
    LIMIT 10
  `;
  console.log(`\n=== Sample vps_plans (up to 10) ===`);
  console.table(samplePlans);

  const kbCategories = await sql`
    SELECT category, count(*)::int AS chunks
    FROM kb_chunks
    GROUP BY category
    ORDER BY chunks DESC
  `;
  console.log(`\n=== kb_chunks by Category ===`);
  console.table(kbCategories);

  // 4. Leak check in DB
  const leaks = await sql`
    SELECT id, category, left(content, 120) AS preview
    FROM kb_chunks
    WHERE content ~* '(rabisu|hyonix|upstreamcorp|vendordc)'
  `;
  console.log(`\n=== Vendor Leak Check in kb_chunks ===`);
  if (leaks.length === 0) {
    console.log("  PASS: Zero vendor brand leaks found in kb_chunks.");
  } else {
    console.error(`  FAIL: Found ${leaks.length} leaked rows!`);
    console.table(leaks);
  }

  // 5. Optional semantic search test
  const query = process.argv.slice(2).join(" ").trim();
  if (query && query !== "status" && query !== "schema") {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-2";
    const res = await ai.models.embedContent({
      model: embeddingModel,
      contents: query,
      config: {
        outputDimensionality: 1024,
        taskType: "RETRIEVAL_QUERY",
      },
    });
    const values = res.embeddings?.[0]?.values;
    if (!values) throw new Error("Failed to embed query");
    const vec = `[${values.join(",")}]`;

    const matches = await sql`
      SELECT id, category, round((1 - (embedding <=> ${vec}::vector))::numeric, 4) AS similarity,
             left(content, 200) AS preview
      FROM kb_chunks
      ORDER BY embedding <=> ${vec}::vector
      LIMIT 5
    `;
    console.log(`\n=== Semantic Search: "${query}" ===`);
    console.table(matches);
  }
}

main().catch((err) => {
  console.error("Verify failed:", err);
  process.exit(1);
});
