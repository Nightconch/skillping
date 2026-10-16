import { z } from "zod";

export const SEARCH_TIMEOUT_MS = 8_000;
const resultSchema = z.object({ skills: z.array(z.object({
  id: z.string().min(1).max(240).regex(/^[a-zA-Z0-9_.\/-]+$/),
  name: z.string().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/),
  source: z.string().max(160).regex(/^(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+|[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)$/),
  installs: z.number().int().nonnegative(),
})).max(100) });

// Same public search endpoint used by vercel-labs/skills src/find.ts.
// Do not execute downloaded skills or conflate a failed request with zero matches.
export async function searchSkills(query: string, request: typeof fetch = fetch) {
  // Descriptions are model supplied: reject recognizable private details before network I/O.
  if (/(?:[a-z]:[\\/]|\\\\|https?:\/\/|(?:^|\s)[/~][\w.-]+\/|\b[\w.-]+\.(?:csv|xlsx?|docx?|pdf|json|ya?ml|tsx?|py|sql)\b|\b(?:password|passphrase|token|api[_ -]?key|private[_ -]?key)\s*[:=]\s*\S+|\bsk-(?:proj-)?[\w-]{16,}|\b(?:gh[pousr]_|github_pat_)[\w]{20,}|\bAKIA[A-Z0-9]{16}\b|\bxox[baprs]-[\w-]{12,}|-----BEGIN .*PRIVATE KEY-----|(?:密码|私钥|令牌)\s*[:=：是为]\s*\S+)/iu.test(query)) {
    throw new Error("search_query_private");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const url = new URL("https://skills.sh/api/search");
    url.search = new URLSearchParams({ q: query.slice(0, 300), limit: "5" }).toString();
    const response = await request(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error("search_unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) throw new Error("search_response_too_large");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const parsed = resultSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return parsed.skills.slice(0, 5).map(skill => ({ ...skill,
      url: `https://skills.sh/${skill.id.split("/").map(encodeURIComponent).join("/")}`,
    }));
  } finally { clearTimeout(timeout); }
}
