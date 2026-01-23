import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

// ===== ENV VARS =====
// tenta SUPABASE_URL e cai para PROJECT_URL
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("PROJECT_URL");
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

function mustEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const text: string = body.text;
    const topK: number = Number(body.top_k ?? 1);
    const minSimilarity: number = Number(body.min_similarity ?? 0.8);

    // texto muito curto => não sugere
    if (!text || typeof text !== "string" || text.trim().length < 10) {
      return new Response(JSON.stringify({ match: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      mustEnv("SUPABASE_URL/PROJECT_URL", SUPABASE_URL),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY/SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY),
    );

    const openai = new OpenAI({
      apiKey: mustEnv("OPENAI_API_KEY", OPENAI_API_KEY),
    });

    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });

    const queryEmbedding = embeddingResponse.data?.[0]?.embedding;
    if (!queryEmbedding) throw new Error("Failed to generate embedding");

    const { data: matches, error } = await supabase.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_count: topK,
    });

    if (error) throw new Error(`match_documents failed: ${error.message}`);

    if (!matches || matches.length === 0) {
      return new Response(JSON.stringify({ match: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const best = matches[0];

    if (best.similarity < minSimilarity) {
      return new Response(JSON.stringify({ match: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        match: {
          id: best.id,
          similarity: best.similarity,
          content: String(best.content ?? "").slice(0, 300),
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("suggest-similar error:", message);

    return new Response(JSON.stringify({ error: "Internal error", detail: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
