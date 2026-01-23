import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

type Job = {
  id: string;
  document_id: string;
  status: "pending" | "processing" | "done" | "error";
  attempts: number;
  last_error: string | null;
};

type DocumentRow = {
  id: string;
  content: string | null;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

// Opcional (recomendado): proteja o worker com um segredo próprio
// Defina WORKER_SECRET nos Secrets e envie header X-Worker-Secret no cron
const WORKER_SECRET = Deno.env.get("WORKER_SECRET"); // opcional

const MAX_ATTEMPTS = 3;      // depois disso vira status=error
const BATCH_SIZE = 5;        // quantos jobs processar por execução
const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536 dims

function mustEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

serve(async (req) => {
  try {
    // 0) (Opcional) Autorização simples pra evitar abuso caso a função seja public
    if (WORKER_SECRET) {
      const provided = req.headers.get("X-Worker-Secret");
      if (provided !== WORKER_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 1) Valida secrets
    const supabase = createClient(
      mustEnv("SUPABASE_URL", SUPABASE_URL),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY),
    );

    const openai = new OpenAI({
      apiKey: mustEnv("OPENAI_API_KEY", OPENAI_API_KEY),
    });

    // 2) Buscar jobs pendentes (ordenados)
    const { data: jobs, error: jobsErr } = await supabase
      .from("document_embedding_jobs")
      .select("id, document_id, status, attempts, last_error")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (jobsErr) {
      console.error("Failed to fetch jobs:", jobsErr);
      return new Response(JSON.stringify({ error: "Failed to fetch jobs" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!jobs || jobs.length === 0) {
      return new Response(JSON.stringify({ processed: 0, message: "No pending jobs" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let processed = 0;
    const results: Array<{ job_id: string; status: string; note?: string }> = [];

    // 3) Processar cada job
    for (const job of jobs as Job[]) {
      // 3.1) Marcar como processing (best effort)
      await supabase
        .from("document_embedding_jobs")
        .update({ status: "processing" })
        .eq("id", job.id);

      try {
        // 3.2) Buscar conteúdo do documento
        const { data: doc, error: docErr } = await supabase
          .from("documents")
          .select("id, content")
          .eq("id", job.document_id)
          .maybeSingle();

        if (docErr) throw new Error(`Failed to fetch document: ${docErr.message}`);
        if (!doc) throw new Error("Document not found");
        const document = doc as DocumentRow;

        if (!document.content || document.content.trim().length === 0) {
          throw new Error("Document content is empty");
        }

        // 3.3) Gerar embedding (OpenAI)
        const embResp = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: document.content,
        });

        const embedding = embResp.data?.[0]?.embedding;
        if (!embedding || !Array.isArray(embedding)) {
          throw new Error("OpenAI returned no embedding");
        }

        // 3.4) Atualizar documents.embedding
        const { error: updDocErr } = await supabase
          .from("documents")
          .update({ embedding })
          .eq("id", document.id);

        if (updDocErr) throw new Error(`Failed to update document embedding: ${updDocErr.message}`);

        // 3.5) Marcar job como done
        const { error: doneErr } = await supabase
          .from("document_embedding_jobs")
          .update({ status: "done", last_error: null })
          .eq("id", job.id);

        if (doneErr) throw new Error(`Failed to mark job done: ${doneErr.message}`);

        processed++;
        results.push({ job_id: job.id, status: "done" });
        console.log("Embedding OK for doc:", job.document_id, "job:", job.id);

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const nextAttempts = (job.attempts ?? 0) + 1;
        const finalStatus = nextAttempts >= MAX_ATTEMPTS ? "error" : "pending";

        // 3.6) Em erro: attempts++, last_error, status=error ou volta pra pending
        const { error: updJobErr } = await supabase
          .from("document_embedding_jobs")
          .update({
            attempts: nextAttempts,
            last_error: message.slice(0, 1000),
            status: finalStatus,
          })
          .eq("id", job.id);

        if (updJobErr) {
          console.error("Failed to update job after error:", updJobErr, "original:", message);
        }

        console.error("Job failed:", job.id, "doc:", job.document_id, "attempt:", nextAttempts, message);
        results.push({ job_id: job.id, status: finalStatus, note: message });
      }
    }

    return new Response(JSON.stringify({ processed, batch: jobs.length, results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Worker fatal error:", message);
    return new Response(JSON.stringify({ error: "Internal error", detail: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
