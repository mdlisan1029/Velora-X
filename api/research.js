const trimSlash = (value) => String(value || '').replace(/\/+$/, '');

const TAVILY_URL = `${trimSlash(process.env.TAVILY_BASE_URL || 'https://api.tavily.com')}/search`;
const NARA_BASE = trimSlash(process.env.NARA_BASE_URL || 'https://router.bynara.id/v1');
const DEFAULT_NARA_MODEL = process.env.NARA_RESEARCH_MODEL || process.env.NARA_MODEL || 'agnes-2.5-flash';
const UPSTREAM_TIMEOUT_MS = 18000;

function parseDomains(raw) {
  return String(raw || '').split(/[\s,]+/).map(x => x.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')).filter(Boolean).slice(0, 50);
}
function isNewsQuery(text) { return /\b(news|today|tonight|latest|breaking|recent|this week|current|now|price|market)\b/i.test(text); }
function uniqueByUrl(results) {
  const seen = new Set();
  return (Array.isArray(results) ? results : []).filter(item => { const url = String(item?.url || '').trim(); if (!url || seen.has(url)) return false; seen.add(url); return true; });
}
async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (err) { if (err?.name === 'AbortError') throw new Error('Upstream request timed out.'); throw err; }
  finally { clearTimeout(timer); }
}
async function readJsonResponse(upstream) {
  const raw = await upstream.text();
  let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
  return data;
}
async function tavilySearch(query, { advanced = false, domains = [] } = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY is not configured in Vercel.');
  const news = isNewsQuery(query);
  const body = { query, search_depth: advanced ? 'advanced' : 'basic', topic: news ? 'news' : 'general', max_results: advanced ? 6 : 8, include_answer: advanced ? false : 'basic', include_raw_content: false, ...(domains.length ? { include_domains: domains } : {}), ...(news ? { time_range: 'week' } : {}) };
  const upstream = await fetchWithTimeout(TAVILY_URL, { method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  const data = await readJsonResponse(upstream);
  if (!upstream.ok) { const message = data?.detail || data?.message || data?.error || `Tavily search failed (${upstream.status})`; throw new Error(String(message).slice(0, 800)); }
  return { answer:String(data?.answer || ''), results:Array.isArray(data?.results) ? data.results : [], credits:Number(data?.usage?.credits || (advanced ? 2 : 1)) };
}
function buildResearchPrompt(query, results, mode) {
  const instruction = mode === 'deep' ? 'Act as a careful research analyst. Synthesize the supplied web evidence into a structured report. Cross-check claims across sources, prefer primary/authoritative evidence, explicitly note uncertainty or conflicting evidence, and do not invent facts or citations. Include: executive summary, key findings, evidence, caveats, and conclusion.' : 'Answer the user's question using the supplied fresh web search evidence. Prioritize recent and authoritative sources, distinguish facts from inference, and keep the response focused. Do not invent facts or citations.';
  const evidence = results.slice(0, 18).map((r,i) => `SOURCE ${i+1}\nTitle: ${String(r.title||'').trim()}\nURL: ${String(r.url||'').trim()}\nSnippet: ${String(r.content||'').trim()}`).join('\n\n');
  return `${instruction}\n\nUser request:\n${query}\n\nWeb evidence:\n${evidence}`;
}
async function synthesizeWithNara(query, results, mode, fallbackAnswer = '') {
  const key = process.env.NARA_API_KEY;
  if (!key) return fallbackAnswer || 'NARA_API_KEY is not configured in Vercel.';
  const prompt = buildResearchPrompt(query, results, mode);
  const upstream = await fetchWithTimeout(`${NARA_BASE}/chat/completions`, { method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json' }, body:JSON.stringify({ model:DEFAULT_NARA_MODEL, messages:[{role:'system',content:'You are Velora X Research, a source-grounded web research assistant.'},{role:'user',content:prompt}], temperature:mode==='deep'?0.2:0.3, max_tokens:mode==='deep'?5000:2400 }) });
  const data = await readJsonResponse(upstream);
  if (!upstream.ok) { const msg = data?.error?.message || data?.message || `Nara synthesis failed (${upstream.status})`; throw new Error(String(msg).slice(0,800)); }
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  return text || fallbackAnswer || 'No synthesized answer was returned.';
}
function buildDeepQueries(query) { const q=String(query||'').trim(); return [q, `${q} official primary sources`, `${q} latest developments analysis evidence`]; }
function sourcePayload(results) { return results.map(r=>({title:String(r.title||r.url||'Source').trim(),url:String(r.url||'').trim(),snippet:String(r.content||'').trim().slice(0,700),score:Number.isFinite(Number(r.score))?Number(r.score):undefined})).filter(s=>s.url); }

export default async function handler(req,res){
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'Method not allowed'});}
  try{
    if(!process.env.TAVILY_API_KEY)return res.status(503).json({error:'TAVILY_API_KEY is not configured in Vercel.'});
    if(!process.env.NARA_API_KEY)return res.status(503).json({error:'NARA_API_KEY is not configured in Vercel.'});
    const body=req.body||{}; const query=String(body.query||'').trim(); if(!query)return res.status(400).json({error:'query is required'});
    const mode=body.mode==='deep'?'deep':'search'; const domains=parseDomains(body.domain); const model=DEFAULT_NARA_MODEL;
    let results=[],queries=[],tavilyCredits=0,tavilyAnswer='';
    if(mode==='search'){
      const found=await tavilySearch(query,{advanced:false,domains}); results=uniqueByUrl(found.results).slice(0,8); queries=[query]; tavilyCredits+=found.credits; tavilyAnswer=found.answer;
    }else{
      const planned=buildDeepQueries(query); const found=await Promise.all(planned.map(q=>tavilySearch(q,{advanced:true,domains}))); queries=planned; tavilyCredits=found.reduce((s,x)=>s+x.credits,0); results=uniqueByUrl(found.flatMap(x=>x.results)).slice(0,18);
    }
    if(!results.length&&!tavilyAnswer)return res.status(200).json({ok:true,mode,model,text:'Tavily returned no web results for this query.',queries,sources:[],tavilyCredits});
    let text; let synthesisDegraded=false;
    try{text=await synthesizeWithNara(query,results,mode,tavilyAnswer);}catch(err){
      synthesisDegraded=true;
      if(tavilyAnswer) text=`${tavilyAnswer}\n\n_Nara synthesis was temporarily unavailable; this answer uses Tavily's current search summary._`;
      else text=`Web search completed, but AI synthesis is temporarily unavailable.\n\nTop sources are listed below.`;
    }
    return res.status(200).json({ok:true,mode,model,text,queries,sources:sourcePayload(results),tavilyCredits,provider:`Tavily + NaraRouter (${model})`,degraded:synthesisDegraded});
  }catch(err){ return res.status(502).json({error:err?.message||'Web research service failed.'}); }
}
