import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
Deno.serve(async()=>{
  const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const {data:docs,error}=await sb.from('request_documents').select('id,request_id,storage_path').lte('delete_after',new Date().toISOString()).limit(500);if(error)throw error;
  if(!docs?.length)return new Response(JSON.stringify({deleted:0}),{headers:{'Content-Type':'application/json'}});
  await sb.storage.from('notary-documents').remove(docs.map(d=>d.storage_path));
  await sb.from('request_documents').delete().in('id',docs.map(d=>d.id));
  for(const d of docs)await sb.from('audit_log').insert({request_id:d.request_id,action:'document_auto_deleted',details:{document_id:d.id}});
  return new Response(JSON.stringify({deleted:docs.length}),{headers:{'Content-Type':'application/json'}});
});
