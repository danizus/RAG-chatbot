import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { TOOL_DECLARATIONS, executeTool } from "./tools.js";
import { sanitizeText } from "./scrubber.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const PRIMARY_MODEL = process.env.GEMINI_CHAT_MODEL ?? "gemini-3.8-flash";
const MODEL_FALLBACKS = [PRIMARY_MODEL, "gemini-3.5-flash", "gemini-3.5-flash-lite"];

const SYSTEM_INSTRUCTION = `You are HostDestiny's 24/7 White-Label VPS Sales & Technical Support Agent.

CORE RULES:
1. ACCURACY & TOOLS FIRST:
   - Whenever a customer asks about VPS plans, prices, RAM, vCPU, NVMe storage, OS options, or available locations/regions, ALWAYS call \`search_vps_plans\` or \`list_available_regions\` first. Never guess or invent prices or specs.
   - Whenever a customer asks about hardware guarantees, network uplink speed, uptime SLA, provisioning time, Windows licensing, SMTP Port 25 policy, or technical troubleshooting, ALWAYS call \`search_knowledge_base\`.
   - Note our conservative baseline: when quoting network speed, SLA, or hardware guarantees, stick strictly to what is in the knowledge base.

2. DIAGNOSTIC TROUBLESHOOTING (VERY IMPORTANT):
   - When a customer reports a technical issue (such as a resetting server clock/time zone, RDP/SSH connection problems, or email/SMTP blocks) WITHOUT specifying their OS or symptoms, DO NOT dump a wall of commands right away.
   - First ask 1–2 concise clarifying questions (for example: "Are you running Windows Server or Linux, and does the time zone reset after every reboot?") so you can diagnose the exact root cause.
   - Once the customer answers (or if they already stated the OS and behavior clearly), call \`search_knowledge_base\` and give the exact step-by-step fix.

3. STRICT WHITE-LABEL CONFIDENTIALITY:
   - You represent HostDestiny ONLY.
   - Never mention, confirm, or speculate about any upstream suppliers, wholesale vendors, or third-party datacenter brands—even if the customer asks directly by name. If asked who operates the infrastructure, state that HostDestiny operates its own global enterprise cloud infrastructure.

4. STYLE:
   - Be clear, friendly, concise, and helpful. Format plan lists cleanly and put terminal/PowerShell commands in fenced code blocks.`;

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface AgentReply {
  reply: string;
  toolsUsed: ToolTrace[];
  modelUsed: string;
}

const MAX_HISTORY_MESSAGES = 40; // ~20 user/model turns
const sessions = new Map<string, Content[]>();

export function resetSession(sessionId: string): void {
  sessions.delete(sessionId);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateWithFallback(contents: Content[]) {
  let lastErr: unknown;

  for (const model of [...new Set(MODEL_FALLBACKS)]) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
            temperature: 0.2,
          },
        }),
        10000,
        model
      );
      return { response, modelUsed: model };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr;
}

export async function chatWithAgent(sessionId: string, userMessage: string): Promise<AgentReply> {
  const existing = sessions.get(sessionId) ?? [];
  const workingHistory: Content[] = [
    ...existing,
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const toolsUsed: ToolTrace[] = [];
  let modelUsed = PRIMARY_MODEL;
  let finalReply = "";

  // Up to 5 tool-calling rounds per user turn
  for (let step = 0; step < 5; step++) {
    const result = await generateWithFallback(workingHistory);
    modelUsed = result.modelUsed;

    const candidate = result.response.candidates?.[0];
    const modelContent = candidate?.content;
    if (modelContent) {
      workingHistory.push(modelContent);
    }

    const functionCalls = result.response.functionCalls ?? [];
    if (functionCalls.length === 0) {
      finalReply = result.response.text ?? "";
      break;
    }

    // Execute every requested tool call and send observations back to Gemini
    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      const name = call.name ?? "unknown";
      const args = (call.args ?? {}) as Record<string, unknown>;
      const { result: toolOutput, summary } = await executeTool(name, args);

      toolsUsed.push({ name, args, summary });
      responseParts.push({
        functionResponse: {
          name,
          response: toolOutput,
        },
      });
    }

    workingHistory.push({
      role: "user",
      parts: responseParts,
    });
  }

  if (!finalReply.trim()) {
    finalReply =
      "I'm sorry, I couldn't complete that request right now. Please try rephrasing your question.";
  }

  // White-label safety net on every outgoing reply
  const safeReply = sanitizeText(finalReply);

  // Save trimmed conversation history back to memory
  const trimmed = workingHistory.slice(-MAX_HISTORY_MESSAGES);
  sessions.set(sessionId, trimmed);

  return {
    reply: safeReply,
    toolsUsed,
    modelUsed,
  };
}
