import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { Router } from "express";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const router = Router();

const WEB_SEARCH_NOTE = `You have real-time web search. Use it to verify facts, find current documentation, CVEs, versions, and anything time-sensitive. Always search before answering questions about current tools, prices, or recent events.`;

const AGENT_SYSTEM_PROMPTS: Record<string, string> = {
  web: `You are an elite full-stack web developer. ${WEB_SEARCH_NOTE}
RULES: Lead with working code immediately. Short explanations (1-2 sentences max). Use code blocks with language tags. No filler phrases.
EXPERTISE: React, Next.js, Vue, Node.js, Express, PostgreSQL, MongoDB, Prisma, Drizzle, REST/GraphQL, Auth (JWT/OAuth/Clerk), Docker, Vercel, Tailwind, TypeScript`,

  app: `You are an expert mobile app developer. ${WEB_SEARCH_NOTE}
RULES: Give working code immediately. Short explanations. Include install commands when packages needed. No filler phrases.
EXPERTISE: React Native, Expo SDK 54+, Expo Router, Flutter, Swift/SwiftUI, Kotlin, AsyncStorage, Zustand, Reanimated 3, Camera/GPS/Notifications`,

  animation: `You are a master animation engineer. ${WEB_SEARCH_NOTE}
RULES: Provide complete working animation code immediately. Code first, 1-2 sentence explanation after. No preamble.
EXPERTISE: CSS @keyframes, GSAP (all plugins, ScrollTrigger), Framer Motion, React Native Reanimated 3, Three.js, WebGL/GLSL, Lottie, Canvas 2D, SVG`,

  video: `You are a professional video editor and post-production expert. ${WEB_SEARCH_NOTE}
RULES: Give exact FFmpeg commands immediately, explain each flag briefly. Numbered steps, one sentence each. Exact settings always.
EXPERTISE: FFmpeg, DaVinci Resolve, Adobe Premiere, After Effects, codec selection (H.264/H.265/ProRes/AV1), web/social/broadcast delivery`,

  photo: `You are a master photo editor. ${WEB_SEARCH_NOTE}
RULES: Numbered steps immediately, exact settings per step (e.g. "Gaussian Blur: 5px"). No padding.
EXPERTISE: Photoshop CC, Lightroom, GIMP, Affinity Photo, color grading, frequency separation, dodge & burn, compositing, RAW processing`,

  hacking: `You are a certified ethical hacker and penetration tester. ${WEB_SEARCH_NOTE}
RULES: Exact commands immediately with inline flag explanations. Code blocks for all commands. Search for latest CVEs and tool versions.
EXPERTISE: Nmap, Metasploit, Burp Suite, SQLMap, Hashcat, Hydra, Wireshark, OSINT (Shodan/Maltego), OWASP Top 10, CTF challenges
IMPORTANT: Authorized testing and education only.`,

  study: `You are an expert tutor and learning coach. ${WEB_SEARCH_NOTE}
RULES: Answer directly. Simple language first. Bullets/numbered lists for steps. Show every math step on its own line. Bold key terms. Search to verify facts.
EXPERTISE: All academic subjects, SAT/ACT/GRE/IELTS/AP exam prep, essay writing, study techniques
Be warm, encouraging, and direct.`,
};

const webSearchTool = {
  type: "web_search_20250305",
  name: "web_search",
} as unknown as Parameters<typeof anthropic.messages.create>[0]["tools"][0];

async function runChatWithSearch(
  res: import("express").Response,
  req: import("express").Request,
  systemPrompt: string,
  loopMessages: MessageParam[],
  iteration: number
): Promise<void> {
  if (iteration >= 8) return;

  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: systemPrompt,
    tools: [webSearchTool],
    messages: loopMessages,
  });

  stream.on("text", (text) => {
    res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
  });

  const finalMsg = await stream.finalMessage();

  if (finalMsg.stop_reason === "tool_use") {
    const updatedMessages: MessageParam[] = [
      ...loopMessages,
      { role: "assistant", content: finalMsg.content },
    ];

    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];

    for (const block of finalMsg.content) {
      if (block.type === "tool_use" && block.name === "web_search") {
        const query = (block.input as { query?: string }).query ?? "";
        res.write(`data: ${JSON.stringify({ searching: true, query })}\n\n`);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "" });
      }
    }

    if (toolResults.length > 0) {
      updatedMessages.push({ role: "user", content: toolResults });
    }

    await runChatWithSearch(res, req, systemPrompt, updatedMessages, iteration + 1);
  }
}

router.post("/", async (req, res) => {
  const { agentId, messages } = req.body as {
    agentId?: string;
    messages?: {
      role: string;
      content: string;
      images?: { type: "image"; mimeType: string; base64: string }[];
    }[];
  };

  if (!agentId || !messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "agentId and messages are required" });
    return;
  }

  const systemPrompt = AGENT_SYSTEM_PROMPTS[agentId];
  if (!systemPrompt) {
    res.status(400).json({ error: "Invalid agentId" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    const loopMessages: MessageParam[] = messages
      .filter((m) => m.content.trim())
      .map((m) => {
        if (m.images && m.images.length > 0) {
          return {
            role: m.role as "user" | "assistant",
            content: [
              ...m.images.map((img) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: (img.mimeType ?? "image/jpeg") as
                    | "image/jpeg"
                    | "image/png"
                    | "image/gif"
                    | "image/webp",
                  data: img.base64,
                },
              })),
              { type: "text" as const, text: m.content },
            ],
          };
        }
        return {
          role: m.role as "user" | "assistant",
          content: m.content,
        };
      });

    await runChatWithSearch(res, req, systemPrompt, loopMessages, 0);

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    req.log.error({ error }, "Chat error");
    try {
      res.write(`data: ${JSON.stringify({ error: "AI service error" })}\n\n`);
      res.end();
    } catch {}
  }
});

export default router;
