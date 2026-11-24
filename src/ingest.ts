import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { GoogleGenAI } from "@google/genai";
import { StagedPlansFileSchema, StagedKbFileSchema, type KbDoc } from "./schemas.js";
import { sanitizeText, assertNoVendorLeaks } from "./scrubber.js";

const STAGED_DIR = path.resolve("data/staged");
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-2";
const EMBEDDING_DIMS = 1024;

const isDryRun = process.argv.includes("--dry-run");

const sql = neon(process.env.DATABASE_URL!);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

interface PreparedChunk {
  category: string;
  content: string;
}

/**
 * Splits a document into overlapping, paragraph-aware chunks with a title header
 * so each chunk remains self-contained during vector retrieval.
 */
function chunkDocument(doc: KbDoc, maxChars = 1400, overlapChars = 200): PreparedChunk[] {
  const header = `${doc.title}\n\n`;
  const cleanBody = sanitizeText(doc.content);
  const cleanTitle = sanitizeText(doc.title);

  assertNoVendorLeaks(cleanTitle, `ingest title`);
  assertNoVendorLeaks(cleanBody, `ingest doc "${cleanTitle}"`);

  if (header.length + cleanBody.length <= maxChars) {
    return [{ category: doc.category, content: `${cleanTitle}\n\n${cleanBody}` }];
  }

  const paragraphs = cleanBody.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: PreparedChunk[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    if (buffer.length > 0 && header.length + buffer.length + 2 + para.length > maxChars) {
      chunks.push({ category: doc.category, content: `${cleanTitle}\n\n${buffer.trim()}` });
      // Keep tail overlap from previous buffer
      const tail = buffer.slice(Math.max(0, buffer.length - overlapChars)).trim();
      buffer = tail ? `${tail}\n\n${para}` : para;
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
  }

  if (buffer.trim()) {
    chunks.push({ category: doc.category, content: `${cleanTitle}\n\n${buffer.trim()}` });
  }

  return chunks;
}

async function embedDocument(text: string, attempt = 1): Promise<string> {
  try {
    const res = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text,
      config: {
        outputDimensionality: EMBEDDING_DIMS,
        taskType: "RETRIEVAL_DOCUMENT",
      },
    });
    const values = res.embeddings?.[0]?.values;
    if (!values || values.length !== EMBEDDING_DIMS) {
      throw new Error(`Expected ${EMBEDDING_DIMS}-dim embedding, got ${values?.length ?? 0}`);
    }
    return `[${values.join(",")}]`;
  } catch (err) {
    if (attempt < 3) {
      const delayMs = attempt * 1500;
      console.warn(`  [RETRY ${attempt}] Embedding failed (${(err as Error).message}); waiting ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
      return embedDocument(text, attempt + 1);
    }
    throw err;
  }
}

async function run() {
  console.log(`Reading staged data from ${STAGED_DIR}...`);
  const [plansRaw, kbRaw] = await Promise.all([
    fs.readFile(path.join(STAGED_DIR, "plans.json"), "utf8"),
    fs.readFile(path.join(STAGED_DIR, "kb.json"), "utf8"),
  ]);

  const stagedPlans = StagedPlansFileSchema.parse(JSON.parse(plansRaw));
  const stagedKb = StagedKbFileSchema.parse(JSON.parse(kbRaw));

  // Final white-label verification on all plans
  for (const plan of stagedPlans.plans) {
    assertNoVendorLeaks(JSON.stringify(plan), `staged plan ${plan.plan_name}`);
  }

  // Chunk and verify all KB docs
  const allChunks: PreparedChunk[] = [];
  for (const doc of stagedKb.docs) {
    allChunks.push(...chunkDocument(doc));
  }

  console.log(`Validated ${stagedPlans.plans.length} VPS plan(s) and ${allChunks.length} KB chunk(s).`);

  if (isDryRun) {
    console.log("\n[DRY RUN] Skipping embeddings and database writes.");
    console.log("Sample plans:", stagedPlans.plans.slice(0, 5));
    console.log("Sample chunks:", allChunks.slice(0, 3));
    return;
  }

  // IMPORTANT: Generate ALL embeddings BEFORE touching the database
  // so an API error never leaves your production tables empty.
  console.log(`Generating ${allChunks.length} embeddings with model "${EMBEDDING_MODEL}"...`);
  const embeddedChunks: Array<{ category: string; content: string; vectorStr: string }> = [];
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i]!;
    const vectorStr = await embedDocument(chunk.content);
    embeddedChunks.push({ ...chunk, vectorStr });
    if ((i + 1) % 5 === 0 || i === allChunks.length - 1) {
      console.log(`  Embedded ${i + 1}/${allChunks.length} chunks`);
    }
  }

  console.log("\nWriting to Neon database...");
  await sql`TRUNCATE vps_plans, kb_chunks RESTART IDENTITY`;

  for (const plan of stagedPlans.plans) {
    await sql`
      INSERT INTO vps_plans (plan_name, vcpu, ram_gb, nvme_gb, region, os_options, price_monthly)
      VALUES (
        ${plan.plan_name},
        ${plan.vcpu},
        ${plan.ram_gb},
        ${plan.nvme_gb},
        ${plan.region},
        ${plan.os_options},
        ${plan.price_monthly}
      )
    `;
  }

  for (const chunk of embeddedChunks) {
    await sql`
      INSERT INTO kb_chunks (category, content, embedding)
      VALUES (${chunk.category}, ${chunk.content}, ${chunk.vectorStr}::vector)
    `;
  }

  // Ensure HNSW vector index exists after loading
  await sql`
    CREATE INDEX IF NOT EXISTS idx_kb_embedding
    ON kb_chunks USING hnsw (embedding vector_cosine_ops)
  `;

  console.log(
    `Done! Inserted ${stagedPlans.plans.length} plans into vps_plans and ${embeddedChunks.length} chunks into kb_chunks.`
  );
}

run().catch((err) => {
  console.error("Ingest failed:", err);
  process.exit(1);
});
