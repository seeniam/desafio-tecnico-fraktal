create or replace function public.enqueue_embedding_job()
returns trigger
language plpgsql
as $$
begin
  insert into public.document_embedding_jobs (document_id)
  values (new.id);
  return new;
end;
$$;

drop trigger if exists documents_after_insert on public.documents;

create trigger documents_after_insert
after insert on public.documents
for each row
execute function public.enqueue_embedding_job();
