import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

// ===== ENV VARS =====
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

function mustEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

// ===== CORS =====
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function normalizeText(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Exige Authorization
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing Authorization Bearer token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const question: string = body.question;
    const topK: number = Number(body.top_k ?? 5);

    if (!question || typeof question !== "string") {
      return new Response(
        JSON.stringify({ error: "Field 'question' is required and must be a string." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Supabase client com ANON + JWT do usuário => RLS aplicado
    const supabase = createClient(
      mustEnv("SUPABASE_URL", SUPABASE_URL),
      mustEnv("SUPABASE_ANON_KEY", SUPABASE_ANON_KEY),
      {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
      },
    );

    const openai = new OpenAI({
      apiKey: mustEnv("OPENAI_API_KEY", OPENAI_API_KEY),
    });

    // 1) Embedding da pergunta
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: question,
    });

    const queryEmbedding = embeddingResponse.data?.[0]?.embedding;
    if (!queryEmbedding) throw new Error("Failed to generate embedding for the question");

    // 2) Busca semântica (RPC segura por usuário)
    // OBS: esta RPC deve filtrar por auth.uid() internamente
    const { data: matches, error: matchError } = await supabase.rpc(
      "match_documents_for_user",
      {
        query_embedding: queryEmbedding,
        match_count: topK,
      },
    );

    if (matchError) {
      throw new Error(`match_documents_for_user RPC failed: ${matchError.message}`);
    }

    if (!matches || matches.length === 0) {
      return new Response(
        JSON.stringify({
          answer: "Não encontrei informações suficientes nas suas notas para responder.",
          sources: [],
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3) Estrutura de fontes para UI (sem poluir resposta com UUID)
    const sources = matches.map((m: any, index: number) => {
      const raw = String(m.content ?? "");
      const clean = normalizeText(raw);

      const preview = clean.slice(0, 180);
      const titleBase = clean.slice(0, 52);
      const title =
        titleBase.length === 52 ? `${titleBase}…` : titleBase || `Nota ${index + 1}`;

      return {
        rank: index + 1,
        id: m.id,
        similarity: m.similarity,
        title,
        preview,
        content: raw,
      };
    });

    // 4) Contexto para o modelo (somente fontes numeradas, sem id)
    const context = sources
      .map((s) => `Fonte ${s.rank}:\n${normalizeText(s.content).slice(0, 1200)}`)
      .join("\n\n---\n\n");

    // 5) Resposta (sem UUIDs)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Você é um assistente que responde usando APENAS as fontes fornecidas. " +
            "Se não houver informação suficiente, diga claramente que não encontrou nas notas. " +
            "Responda em português, de forma objetiva (2 a 6 frases). " +
            "NÃO inclua seção de fontes, IDs, UUIDs ou links no texto final.",
        },
        {
          role: "user",
          content:
            `Pergunta:\n${question}\n\n` +
            `Fontes:\n${context}\n\n` +
            "Responda somente com a resposta final, sem citar fontes/IDs.",
        },
      ],
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ??
      "Não foi possível gerar uma resposta.";

    return new Response(
      JSON.stringify({
        answer,
        sources: sources.map((s) => ({
          id: s.id,
          similarity: s.similarity,
          title: s.title,
          preview: s.preview,
        })),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("answer-question error:", message);

    return new Response(JSON.stringify({ error: "Internal server error", detail: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
