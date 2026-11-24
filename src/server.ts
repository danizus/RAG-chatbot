import "dotenv/config";
import path from "node:path";
import express from "express";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import { chatWithAgent, resetSession } from "./agent.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const sql = neon(process.env.DATABASE_URL!);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve("public")));

const ChatRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
});

const ResetRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
});

app.get("/api/health", async (_req, res) => {
  try {
    const [plans] = await sql`SELECT count(*)::int AS count FROM vps_plans`;
    const [kb] = await sql`SELECT count(*)::int AS count FROM kb_chunks`;
    res.json({
      ok: true,
      vps_plans: plans?.count ?? 0,
      kb_chunks: kb?.count ?? 0,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post("/api/chat", async (req, res) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request payload",
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const result = await chatWithAgent(parsed.data.sessionId, parsed.data.message);
    res.json(result);
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({
      error: "Failed to generate agent response",
      details: (err as Error).message,
    });
  }
});

app.post("/api/reset", (req, res) => {
  const parsed = ResetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }
  resetSession(parsed.data.sessionId);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`HostDestiny VPS Agent running at http://localhost:${PORT}`);
});
