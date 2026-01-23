import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

// ===== ENV VARS =====
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

function mustEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

// ===== SERVER =====
serve(async (req) => {
  try {
    // 1️⃣ Parse body
    const body = await req.json().catch(() => ({}));
    const question: string = body.question;
    const topK: number = Number(body.top_k ?? 5);

    if (!question || typeof question !== "string") {
      return new Response(
        JSON.stringify({ error: "Field 'question' is required and must be a string." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2️⃣ Clients
    const supabase = createClient(
      mustEnv("SUPABASE_URL", SUPABASE_URL),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
    );

    const openai = new OpenAI({
      apiKey: mustEnv("OPENAI_API_KEY", OPENAI_API_KEY),
    });

    // 3️⃣ Generate embedding for the question
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small", // 1536 dims
      input: question,
    });

    const queryEmbedding = embeddingResponse.data?.[0]?.embedding;
    if (!queryEmbedding) {
      throw new Error("Failed to generate embedding for the question");
    }

    // 4️⃣ Semantic search (RPC)
    const { data: matches, error: matchError } = await supabase.rpc(
      "match_documents",
      {
        query_embedding: queryEmbedding,
        match_count: topK,
      }
    );

    if (matchError) {
      throw new Error(`match_documents RPC failed: ${matchError.message}`);
    }

    if (!matches || matches.length === 0) {
      return new Response(
        JSON.stringify({
          answer: "Não encontrei informações suficientes nas suas notas para responder.",
          sources: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5️⃣ Build context from matched documents
    const sources = matches.map((m: any, index: number) => ({
      rank: index + 1,
      id: m.id,
      similarity: m.similarity,
      content: m.content,
    }));

    const context = sources
      .map(
        (s) =>
          `Fonte ${s.rank} (id=${s.id}, similaridade=${Number(s.similarity).toFixed(3)}):\n` +
          s.content.slice(0, 1200)
      )
      .join("\n\n---\n\n");

    // 6️⃣ Ask the LLM to answer using ONLY the sources
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Você é um assistente que responde perguntas usando APENAS as fontes fornecidas. " +
            "Se não houver informação suficiente nas fontes, diga claramente que não encontrou. " +
            "Ao final da resposta, liste as fontes utilizadas no formato: Fontes: [id1, id2, ...].",
        },
        {
          role: "user",
          content:
            `Pergunta:\n${question}\n\n` +
            `Fontes disponíveis:\n${context}\n\n` +
            "Responda de forma objetiva e cite as fontes no final.",
        },
      ],
    });

    const answer =
      completion.choices?.[0]?.message?.content ??
      "Não foi possível gerar uma resposta.";

    // 7️⃣ Return response
    return new Response(
      JSON.stringify({
        answer,
        sources: sources.map((s) => ({
          id: s.id,
          similarity: s.similarity,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("answer-question error:", message);

    return new Response(
      JSON.stringify({ error: "Internal server error", detail: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
