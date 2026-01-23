# Desafio Técnico – Smart Docs (Supabase + Embeddings + Q&A)

Backend do sistema de notas com busca semântica e chat Q&A, usando Supabase (Postgres + RLS + Triggers + Edge Functions) e OpenAI.

## Visão geral

### Fluxo de embeddings (automático, desacoplado do frontend)
1. O usuário salva uma nota em `documents`.
2. Um **trigger no Postgres** enfileira um job em `document_embedding_jobs`.
3. Uma **Edge Function (worker)** processa jobs `pending`, gera o embedding e atualiza `documents.embedding`.
4. O frontend não roda lógica pesada: só cria a nota e consulta.

### Fluxo de Q&A (Chat)
1. O usuário envia uma pergunta.
2. A Edge Function `answer-question`:
   - gera embedding da pergunta
   - busca notas relevantes via RPC `match_documents`
   - chama o modelo de chat e retorna a resposta
   - retorna também as **fontes** (IDs das notas)

## Estrutura do backend (repo)

- `backend/supabase/migrations/`
  - Criação da fila `document_embedding_jobs`
  - Trigger `documents_after_insert` → enfileira job
  - RLS + policies em `documents`
  - RPC `match_documents` (busca por similaridade usando pgvector)
- `backend/supabase/functions/`
  - `generate-embedding/` → Worker que processa a fila e grava embeddings
  - `answer-question/` → Q&A com fontes usando notas do usuário

## Segurança (RLS)

- `documents` possui RLS habilitado.
- Usuários só acessam suas próprias notas (ou públicas, se aplicável).
- `document_embedding_jobs` é acessada apenas pela service role (Edge Functions).

## Secrets / Variáveis de ambiente (Supabase Cloud)

Configurar em **Supabase Dashboard → Edge Functions → Secrets**:

- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

> Não commitar nenhum `.env*` com segredos.

## Como aplicar no Supabase Cloud (migrations)

Este projeto foi construído e testado no Supabase Cloud. Para reproduzir:

1. Abra **SQL Editor** no Supabase.
2. Execute os arquivos em `backend/supabase/migrations/` na ordem (01 → 04).

## Teste rápido no Supabase Cloud (5 minutos)

### 1) Inserir uma nota
No SQL Editor (use um UUID real de usuário):

```sql
insert into documents (content, user_id)
values ('Minha nota de teste', 'UUID_REAL_DO_USUARIO');
