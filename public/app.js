const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const messagesEl = $('#messages');
const promptEl = $('#prompt');
const sendBtn = $('#sendBtn');
const providerSelect = $('#providerSelect');
const modelSelect = $('#modelSelect');
const tempRange = $('#tempRange');
const tempValue = $('#tempValue');
const maxTokens = $('#maxTokens');
const reasoning = $('#reasoning');
const providerList = $('#providerList');
const providerCount = $('#providerCount');
const statusDialog = $('#statusDialog');
const statusBody = $('#statusBody');
let history = [];
let providers = [];
let busy = false;
let lastAssistantText = '';

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function getScrollViewport(){return window.matchMedia('(max-width:680px)').matches ? document.scrollingElement : messagesEl;}
function isNearBottom(){const el=getScrollViewport();return !!el && el.scrollTop+el.clientHeight>=el.scrollHeight-220;}
function scrollBottom(){const el=getScrollViewport();if(el)el.scrollTop=el.scrollHeight;}
function setBusy(v){busy=v;sendBtn.disabled=v;promptEl.disabled=false;promptEl.setAttribute('aria-busy',v?'true':'false');}

const EXTENSIONS={
  html:'html',htm:'html',xhtml:'html',css:'css',scss:'scss',sass:'sass',less:'less',
  js:'js',javascript:'js',mjs:'mjs',cjs:'cjs',jsx:'jsx',ts:'ts',typescript:'ts',tsx:'tsx',
  json:'json',jsonc:'json',py:'py',python:'py',pyw:'py',java:'java',c:'c',h:'h',cpp:'cpp',cc:'cpp',cxx:'cpp',cs:'cs',
  php:'php',rb:'rb',ruby:'rb',go:'go',rs:'rs',rust:'rs',swift:'swift',kt:'kt',kotlin:'kt',dart:'dart',
  lua:'lua',r:'r',R:'r',scala:'scala',sh:'sh',bash:'sh',zsh:'sh',fish:'sh',powershell:'ps1',ps:'ps1',
  yaml:'yml',yml:'yml',toml:'toml',xml:'xml',svg:'svg',md:'md',markdown:'md',mdx:'mdx',txt:'txt',
  sql:'sql',graphql:'graphql',gql:'graphql',dockerfile:'dockerfile',text:'txt'
};
const LANG_LABELS={js:'JavaScript',jsx:'JSX',ts:'TypeScript',tsx:'TSX',py:'Python',html:'HTML',css:'CSS',scss:'SCSS',json:'JSON',md:'Markdown',sql:'SQL',sh:'Shell',yml:'YAML',xml:'XML',svg:'SVG',java:'Java',cpp:'C++',c:'C',cs:'C#',php:'PHP',go:'Go',rs:'Rust',kt:'Kotlin',dart:'Dart',graphql:'GraphQL',dockerfile:'Dockerfile',txt:'Text'};
function normalizeLang(lang){return String(lang||'').trim().toLowerCase().replace(/^language-/,'').replace(/^lang-/,'');}
function looksLikeHTML(code){const s=String(code||'').trim();return /^<!doctype\s+html/i.test(s)||/<html(?:\s|>)/i.test(s)||(/<head(?:\s|>)/i.test(s)&&/<body(?:\s|>)/i.test(s));}
function detectCodeLanguage(code){
  const s=String(code||'').trim();
  if(!s)return 'txt';
  if(looksLikeHTML(s))return 'html';
  try{JSON.parse(s);return 'json';}catch{}
  if(/^<svg(?:\s|>)/i.test(s))return 'svg';
  if(/^(?:@media|[.#]?[\w-]+\s*\{[\s\S]*:\s*[^;]+;)/.test(s) && /\{[\s\S]*\}/.test(s))return 'css';
  if(/^(?:#!\/.*\b(?:bash|sh)|(?:set -e|echo\s+|printf\s+))/.test(s)||/\b(?:apt|npm|git|curl|wget)\s+[\w-]+/.test(s))return 'sh';
  if(/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(s))return 'sql';
  if(/^(?:from\s+\w+\s+import|import\s+\w+|def\s+\w+\s*\(|class\s+\w+.*:)/m.test(s)||/\bprint\s*\(/.test(s))return 'py';
  if(/(?:const|let|var)\s+\w+\s*=|function\s+\w+\s*\(|=>|console\.log\s*\(/.test(s))return 'js';
  if(/^(?:using\s+System|public\s+(?:class|static)|namespace\s+)/m.test(s))return 'cs';
  if(/^(?:package\s+[\w.]+;|import\s+java\.|public\s+class\s+)/m.test(s))return 'java';
  if(/^(?:fn\s+main|use\s+std::|let\s+mut\s+)/m.test(s))return 'rs';
  if(/^(?:func\s+main\s*\(|package\s+main)/m.test(s))return 'go';
  if(/^(?:#\s+[^\n]+\n|[-*]\s+[^\n]+\n)/.test(s))return 'md';
  return 'txt';
}
function resolveLanguage(lang, code){const explicit=normalizeLang(lang);return explicit && explicit!=='text' && explicit!=='code' ? (EXTENSIONS[explicit]?explicit:explicit) : detectCodeLanguage(code);}
function codeFilename(lang,index=1,code=''){
  const key=resolveLanguage(lang,code);const ext=EXTENSIONS[key]||'txt';
  const base=({html:'velora-page',htm:'velora-page',css:'velora-styles',scss:'velora-styles',sass:'velora-styles',js:'velora-script',mjs:'velora-script',cjs:'velora-script',jsx:'velora-component',ts:'velora-script',tsx:'velora-component',json:'velora-data',jsonc:'velora-data',py:'velora-script',java:'velora-script',sql:'velora-query',md:'velora-document',mdx:'velora-document',svg:'velora-image',xml:'velora-document',yml:'velora-config',yaml:'velora-config',sh:'velora-script',graphql:'velora-query',dockerfile:'Dockerfile'}[key]||`velora-code-${index}`);
  return `${base}.${ext}`;
}
function downloadFile(content,name,type='text/plain;charset=utf-8'){
  const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function copyText(text){try{if(navigator.clipboard?.writeText)return await navigator.clipboard.writeText(text);}catch{};const ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch{}ta.remove();}
function previewHTML(code){const w=window.open('about:blank','_blank');if(!w){alert('Popup blocked. Allow popups to preview HTML.');return;}w.document.open();w.document.write(code);w.document.close();}
function parseMarkdownBlocks(text){
  const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n');const tokens=[];let prose=[];let code=null;let codeIndex=0;
  const flushProse=()=>{if(prose.length){tokens.push({type:'text',value:prose.join('\n')});prose=[];}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];const fence=line.match(/^\s*(```+|~~~+)\s*([\w.+#-]*)\s*$/);
    if(!code && fence){flushProse();code={marker:fence[1],lang:fence[2],lines:[],index:++codeIndex};continue;}
    if(code){if(new RegExp(`^\\s*${code.marker}\\s*$`).test(line)){const value=code.lines.join('\n').replace(/\n$/,'');tokens.push({type:'code',lang:resolveLanguage(code.lang,value),value,index:code.index});code=null;}else code.lines.push(line);continue;}
    prose.push(line);
  }
  if(code){const value=code.lines.join('\n').replace(/\n$/,'');tokens.push({type:'code',lang:resolveLanguage(code.lang,value),value,index:code.index});}
  else flushProse();
  return tokens;
}
function inlineMarkdown(raw){
  let s=esc(raw);
  s=s.replace(/`([^`\n]+)`/g,'<code class="md-inline-code">$1</code>');
  s=s.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');s=s.replace(/__([^_\n]+)__/g,'<strong>$1</strong>');
  s=s.replace(/\*([^*\n]+)\*/g,'<em>$1</em>');s=s.replace(/_([^_\n]+)_/g,'<em>$1</em>');
  s=s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}
function textMarkdownHTML(raw){
  const lines=String(raw||'').split('\n');let html='';let list=false;let para=[];
  const flushPara=()=>{if(!para.length)return;html+=`<p>${inlineMarkdown(para.join('\n')).replace(/\n/g,'<br>')}</p>`;para=[];};
  const closeList=()=>{if(list==='ol')html+='</ol>';else if(list)html+='</ul>';list=false;};
  for(const line of lines){
    if(/^\s*$/.test(line)){flushPara();closeList();continue;}
    let m=line.match(/^###\s+(.+)$/);if(m){flushPara();closeList();html+=`<h4>${inlineMarkdown(m[1])}</h4>`;continue;}
    m=line.match(/^##\s+(.+)$/);if(m){flushPara();closeList();html+=`<h3>${inlineMarkdown(m[1])}</h3>`;continue;}
    m=line.match(/^#\s+(.+)$/);if(m){flushPara();closeList();html+=`<h2>${inlineMarkdown(m[1])}</h2>`;continue;}
    m=line.match(/^[-*]\s+(.+)$/);if(m){flushPara();if(!list){html+='<ul>';list='ul';}html+=`<li>${inlineMarkdown(m[1])}</li>`;continue;}
    m=line.match(/^\d+\.\s+(.+)$/);if(m){flushPara();if(list!=='ol'){closeList();html+='<ol>';list='ol';}html+=`<li>${inlineMarkdown(m[1])}</li>`;continue;}
    if(/^>\s?/.test(line)){flushPara();closeList();html+=`<blockquote>${inlineMarkdown(line.replace(/^>\s?/,'') )}</blockquote>`;continue;}
    para.push(line);
  }
  flushPara();closeList();return html;
}
function mimeForExtension(file){const ext=String(file).split('.').pop().toLowerCase();return ({html:'text/html',css:'text/css',scss:'text/x-scss',sass:'text/x-sass',js:'text/javascript',mjs:'text/javascript',cjs:'text/javascript',jsx:'text/javascript',ts:'text/typescript',tsx:'text/typescript',json:'application/json',md:'text/markdown',mdx:'text/markdown',xml:'application/xml',svg:'image/svg+xml',py:'text/x-python',sql:'text/plain',yml:'text/yaml',yaml:'text/yaml',sh:'text/x-shellscript',ps1:'text/plain',java:'text/x-java-source',cs:'text/plain',cpp:'text/x-c++src',rs:'text/rust',go:'text/plain',graphql:'application/graphql'}[ext]||'text/plain')+';charset=utf-8';}
function makeCodeBlock(code,lang,index){
  const resolved=resolveLanguage(lang,code);const file=codeFilename(resolved,index,code);const wrap=document.createElement('div');wrap.className='md-code-block';wrap.dataset.language=resolved;wrap.dataset.filename=file;
  const head=document.createElement('div');head.className='md-code-head';
  const meta=document.createElement('div');meta.className='md-code-meta';
  const label=document.createElement('span');label.className='md-code-lang';label.textContent=LANG_LABELS[resolved]||resolved.toUpperCase()||'Code';
  const filename=document.createElement('span');filename.className='md-code-file';filename.textContent=file;meta.append(label,filename);
  const actions=document.createElement('div');actions.className='md-code-actions';
  const copy=document.createElement('button');copy.type='button';copy.className='mini';copy.textContent='Copy code';copy.onclick=()=>copyText(code);
  const download=document.createElement('button');download.type='button';download.className='mini';download.textContent=`Download ${file}`;download.onclick=()=>downloadFile(code,file,mimeForExtension(file));actions.append(copy,download);
  if(resolved==='html'||resolved==='svg'){const preview=document.createElement('button');preview.type='button';preview.className='mini';preview.textContent='Preview';preview.onclick=()=>previewHTML(code);actions.appendChild(preview);}
  head.append(meta,actions);
  const pre=document.createElement('pre');const codeEl=document.createElement('code');codeEl.textContent=code;pre.appendChild(codeEl);wrap.append(head,pre);return wrap;
}
function renderAssistantBubble(bubble,text){const raw=String(text||'');bubble.classList.add('md-content');bubble.innerHTML='';for(const token of parseMarkdownBlocks(raw)){if(token.type==='code')bubble.appendChild(makeCodeBlock(token.value,token.lang,token.index));else{const holder=document.createElement('div');holder.className='md-prose';holder.innerHTML=textMarkdownHTML(token.value);if(holder.textContent.trim())bubble.appendChild(holder);}}}
window.VeloraRender={renderAssistantBubble,makeCodeBlock,copyText,downloadFile};

function modelOptions(providerId){const p=providers.find(x=>x.id===providerId);modelSelect.innerHTML='<option value="">Provider default</option>';(p?.models||(p?.model?[p.model]:[])).forEach(m=>{modelSelect.innerHTML+=`<option value="${esc(m)}">${esc(m)}</option>`});}
function selectProvider(id){providerSelect.value=id;modelOptions(id);$$('.provider').forEach(x=>x.classList.toggle('active',x.dataset.id===id));}
function makeActions(bubble,text){
  const acts=document.createElement('div');acts.className='bubble-actions';
  const copy=document.createElement('button');copy.className='mini';copy.textContent='Copy answer';copy.onclick=()=>copyText(text);acts.appendChild(copy);
  const save=document.createElement('button');save.className='mini';save.textContent='Save .txt';save.onclick=()=>downloadFile(text,'velora-answer.txt','text/plain;charset=utf-8');acts.appendChild(save);
  return acts;
}
function addMessage(role,text,meta=''){
  document.querySelector('.welcome')?.remove();
  const wrap=document.createElement('div');wrap.className=`message ${role}`;
  const inner=document.createElement('div');inner.className='bubble-wrap';
  const bubble=document.createElement('div');bubble.className='bubble';inner.appendChild(bubble);
  if(role==='assistant'){renderAssistantBubble(bubble,text);inner.appendChild(makeActions(bubble,text));}
  else bubble.textContent=text;
  if(meta){const m=document.createElement('div');m.className='meta';m.textContent=meta;inner.appendChild(m)}
  const stick=isNearBottom();wrap.appendChild(inner);messagesEl.appendChild(wrap);if(stick)requestAnimationFrame(scrollBottom);return bubble;
}
function addHTMLActions(bubble){const host=bubble.parentElement;if(!host||host.querySelector('.md-code-block'))return;}

function escUrl(url){
  try{const u=new URL(String(url));return /^https?:$/.test(u.protocol)?u.href:'';}catch{return '';}
}
function researchLoading(){return '<div class="research-loading"><span class="research-spinner"></span><span>Searching Tavily and synthesizing sources…</span></div>';}
function renderResearchResult(data){
  const box=$('#researchResults');
  if(!box)return;
  box.innerHTML='';
  const answer=document.createElement('div');answer.className='research-answer';
  const answerBody=document.createElement('div');answerBody.className='md-prose';
  if(typeof renderAssistantBubble==='function')renderAssistantBubble(answerBody,String(data.text||'No answer returned.'));else answerBody.textContent=String(data.text||'No answer returned.');
  answer.appendChild(answerBody);

  const actions=document.createElement('div');actions.className='research-actions';
  const copy=document.createElement('button');copy.type='button';copy.className='mini';copy.textContent='Copy answer';copy.onclick=()=>copyText(String(data.text||''));
  const save=document.createElement('button');save.type='button';save.className='mini';save.textContent='Download report';save.onclick=()=>{
    const sources=(data.sources||[]).map((x,i)=>`${i+1}. ${x.title||x.url}\n   ${x.url}`).join('\n');
    const report=`${data.mode==='deep'?'Deep Research Report':'Web Search Report'}\n\n${data.text||''}${sources?`\n\nSources\n${sources}`:''}\n`;
    downloadFile(report,'velora-research.txt','text/plain;charset=utf-8');
  };
  const saveChat=document.createElement('button');saveChat.type='button';saveChat.className='mini';saveChat.textContent='Add to current chat';saveChat.onclick=()=>{
    const sourceText=(data.sources||[]).slice(0,12).map((x,i)=>`- [${x.title||x.url}](${x.url})`).join('\n');
    const content=`${data.text||''}${sourceText?`\n\n### Sources\n${sourceText}`:''}`;
    window.dispatchEvent(new CustomEvent('velora:save-to-chat',{detail:{user:$('#researchPrompt')?.value.trim()||'Web research',assistant:content,meta:`via Tavily + NaraRouter${data.mode==='deep'?' · Deep Research':''}`}}));
    saveChat.textContent='Saved to chat';saveChat.disabled=true;
  };
  actions.append(copy,save,saveChat);answer.appendChild(actions);box.appendChild(answer);

  if(Array.isArray(data.queries)&&data.queries.length){
    const qTitle=document.createElement('div');qTitle.className='meta';qTitle.textContent='Search queries';box.appendChild(qTitle);
    const qWrap=document.createElement('div');qWrap.className='research-queries';
    data.queries.slice(0,8).forEach(q=>{const chip=document.createElement('span');chip.className='research-query';chip.textContent=q;qWrap.appendChild(chip);});
    box.appendChild(qWrap);
  }

  if(Array.isArray(data.sources)&&data.sources.length){
    const title=document.createElement('div');title.className='meta';title.style.marginTop='12px';title.textContent=`Sources (${data.sources.length})`;box.appendChild(title);
    const list=document.createElement('div');list.className='research-sources';
    data.sources.slice(0,20).forEach((src,i)=>{
      const href=escUrl(src.url); if(!href)return;
      const a=document.createElement('a');a.className='research-source';a.href=href;a.target='_blank';a.rel='noopener noreferrer';
      const b=document.createElement('b');b.textContent=`${i+1}. ${src.title||href}`;
      const span=document.createElement('span');span.textContent=href;a.append(b,span);list.appendChild(a);
    });
    box.appendChild(list);
  }
}
async function runResearch(){
  const prompt=$('#researchPrompt')?.value.trim();if(!prompt)return alert('Enter a research question first.');
  const btn=$('#researchBtn');const status=$('#researchStatus');const box=$('#researchResults');
  btn.disabled=true;btn.textContent='Researching…';if(status)status.innerHTML='<span class="research-dot"></span>Searching';if(box)box.innerHTML=researchLoading();
  try{
    const mode=$('#researchMode')?.value||'search';
    const model=$('#researchModel')?.value.trim()||undefined;
    const domain=$('#researchDomain')?.value.trim()||undefined;
    const r=await fetch('/api/research',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:prompt,mode,model,domain})});
    const d=await r.json().catch(()=>({error:'Invalid research response'}));
    if(!r.ok)throw new Error(d.error||'Research failed');
    renderResearchResult(d);
    if(status)status.innerHTML=`<span class="research-dot"></span>${(d.sources||[]).length} sources`;
  }catch(err){
    if(box)box.innerHTML=`<div class="research-empty">${esc(err?.message||'Research failed.')}</div>`;
    if(status)status.innerHTML='<span style="color:var(--bad)">Error</span>';
  }finally{btn.disabled=false;btn.textContent=$('#researchMode')?.value==='deep'?'Start deep research':'Search web';}
}
$('#researchBtn')?.addEventListener('click',runResearch);
$('#researchPrompt')?.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();runResearch();}});
$('#researchMode')?.addEventListener('change',()=>{const btn=$('#researchBtn');if(btn)btn.textContent=$('#researchMode').value==='deep'?'Start deep research':'Search web';});
$('#researchClearBtn')?.addEventListener('click',()=>{const p=$('#researchPrompt');const box=$('#researchResults');if(p)p.value='';if(box)box.innerHTML='<div class="research-empty">Your web-grounded answer and sources will appear here.</div>';const status=$('#researchStatus');if(status)status.innerHTML='<span class="research-dot"></span>Ready';});

async function loadProviders(){
  try{const r=await fetch('/api/health');const d=await r.json();providers=d.providers||[];providerCount.textContent=providers.length;providerList.innerHTML='';providerSelect.innerHTML='<option value="auto">Auto / first available</option>';const mediaProviders=[];providers.forEach(p=>{const row=document.createElement('div');row.className='provider';row.dataset.id=p.id;row.innerHTML=`<span class="dot"></span><span class="name">${esc(p.name)}</span><span class="model">${esc(p.model)}</span>`;row.onclick=()=>selectProvider(p.id);providerList.appendChild(row);if(p.chat)providerSelect.innerHTML+=`<option value="${esc(p.id)}">${esc(p.name)}</option>`;if(p.image||p.video)mediaProviders.push(p);});if(!providers.length)providerList.innerHTML='<div class="muted">No API providers configured.</div>';$('#mediaProvider').innerHTML='<option value="">Auto</option>'+mediaProviders.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');}catch{providerList.innerHTML='<div class="muted">Could not load providers.</div>'}
}
async function streamChat(){
  const text=promptEl.value.trim();if(!text||busy)return;const shouldStick=isNearBottom();addMessage('user',text);history.push({role:'user',content:text});promptEl.value='';promptEl.style.height='auto';setBusy(true);const placeholder=addMessage('assistant','Thinking…');let full='',buf='',raf=0,pending=false,seenData=false,ended=false;const controller=new AbortController();let idleTimer=null;const resetIdle=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>controller.abort(),45000)};const render=()=>{raf=0;pending=false;placeholder.textContent=full;if(shouldStick)scrollBottom()};const scheduleRender=()=>{if(!pending){pending=true;raf=requestAnimationFrame(render);}};const consumeEvent=(event)=>{const lines=event.split(/\r?\n/);let data='';for(const line of lines){if(line.startsWith('data:'))data+=line.slice(5).trim();}if(!data)return;seenData=true;if(data==='[DONE]'){ended=true;return;}try{const j=JSON.parse(data);const delta=j.choices?.[0]?.delta?.content??j.choices?.[0]?.message?.content??'';if(delta){full+=String(delta);scheduleRender();}}catch{}};
  try{const providerId=providerSelect.value;const payload={messages:history,model:modelSelect.value||'',temperature:Number(tempRange.value),max_tokens:Number(maxTokens.value),reasoning_effort:reasoning.value||undefined,stream:true,providerOrder:providerId==='auto'?[]:[providerId]};const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});if(!r.ok){const e=await r.json().catch(()=>({error:'Request failed'}));throw new Error(e.error||'Request failed');}const provider=r.headers.get('X-Velora-Provider');const reader=r.body?.getReader();if(!reader)throw new Error('Streaming response is unavailable.');const decoder=new TextDecoder();resetIdle();while(!ended){const {value,done}=await reader.read();if(done)break;resetIdle();buf+=decoder.decode(value,{stream:true});const events=buf.split(/\r?\n\r?\n/);buf=events.pop()||'';for(const event of events)consumeEvent(event);}if(buf.trim())consumeEvent(buf);clearTimeout(idleTimer);if(raf)cancelAnimationFrame(raf);placeholder.textContent='';renderAssistantBubble(placeholder,full||(!seenData?'No stream data returned.':'No text response returned.'));const acts=makeActions(placeholder,full||'');placeholder.parentElement.appendChild(acts);lastAssistantText=full||'';const m=document.createElement('div');m.className='meta';m.textContent=provider?`via ${provider}`:'via configured provider';placeholder.parentElement.appendChild(m);history.push({role:'assistant',content:full||''});if(shouldStick)requestAnimationFrame(scrollBottom);}catch(err){clearTimeout(idleTimer);if(raf)cancelAnimationFrame(raf);placeholder.textContent=`Error: ${err?.name==='AbortError'?'The response stream timed out. Please send the prompt again.':(err?.message||'Request failed')}`;placeholder.style.color='var(--bad)';history.pop();}finally{setBusy(false);if(!window.matchMedia('(max-width:680px)').matches){try{promptEl.focus({preventScroll:true});}catch{promptEl.focus();}}}
}
$('#composer').addEventListener('submit',e=>{e.preventDefault();streamChat()});
tempRange.addEventListener('input',()=>tempValue.textContent=tempRange.value);
promptEl.addEventListener('input',()=>{promptEl.style.height='auto';promptEl.style.height=Math.min(promptEl.scrollHeight,190)+'px'});
promptEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#composer').requestSubmit()}});
providerSelect.addEventListener('change',()=>{modelOptions(providerSelect.value);selectProviderVisual(providerSelect.value)});
function selectProviderVisual(id){$$('.provider').forEach(x=>x.classList.toggle('active',x.dataset.id===id));}
modelSelect.addEventListener('change',()=>{});
$$('.suggestion').forEach(b=>b.addEventListener('click',()=>{promptEl.value=b.dataset.prompt;promptEl.dispatchEvent(new Event('input'));promptEl.focus()}));
$$('.tab').forEach(t=>t.addEventListener('click',()=>{$$('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');$$('.pane').forEach(p=>p.classList.remove('active'));$(`#${t.dataset.pane}Pane`).classList.add('active')}));
$('#newChatBtn').onclick=()=>{$('#clearBtn').click()};
$('#clearBtn').onclick=()=>{history=[];lastAssistantText='';messagesEl.innerHTML='<div class="welcome"><div class="orb"></div><div class="eyebrow" style="margin-top:18px">VELORA X ONLINE</div><h2>Pick a model. Create.</h2><p>Use the provider and model selectors, then chat.</p></div>'};
$('#copyLastBtn').onclick=async()=>{if(lastAssistantText)await copyText(lastAssistantText)};
$('#statusBtn').onclick=async()=>{statusDialog.showModal();statusBody.innerHTML='<div class="muted">Loading…</div>';try{const r=await fetch('/api/health');const d=await r.json();statusBody.innerHTML=(d.providers||[]).map(p=>`<div class="status-row"><b>${esc(p.name)}</b><span>${esc(p.model)}</span><span>${p.image?'Image ':''}${p.video?'Video':''}${!p.image&&!p.video?'Chat':''}</span></div>`).join('')||'<div class="muted">No providers configured.</div>'}catch{statusBody.innerHTML='<div class="muted">Unable to load status.</div>'}};
$('#closeDialog').onclick=()=>statusDialog.close();
$('#mediaType').addEventListener('change',()=>{const type=$('#mediaType').value;$('#mediaStatus').textContent=type==='image'?'Image mode':'Video mode'});
$('#generateMediaBtn').onclick=async()=>{const btn=$('#generateMediaBtn');const prompt=$('#mediaPrompt').value.trim();if(!prompt)return alert('Enter a media prompt first.');btn.disabled=true;btn.textContent='Generating…';$('#mediaStatus').textContent='Working';try{const body={type:$('#mediaType').value,prompt,providerId:$('#mediaProvider').value,model:$('#mediaModel').value.trim()||undefined,size:$('#mediaSize').value,duration:$('#mediaDuration').value.trim()||undefined,quality:$('#mediaQuality').value};const r=await fetch('/api/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Generation failed');const urls=d.urls||[];const box=$('#mediaResults');box.innerHTML='';if(!urls.length){box.innerHTML='<div class="media-empty">Provider returned no direct media URL. Check the raw provider response or configure a compatible media endpoint.</div>'}else{urls.forEach((url,i)=>{const item=document.createElement('div');item.className='media-item';const media=d.type==='video'?document.createElement('video'):document.createElement('img');if(d.type==='video'){media.src=url;media.controls=true}else{media.src=url;media.alt='Generated media'}item.appendChild(media);const foot=document.createElement('div');foot.className='media-foot';const open=document.createElement('a');open.className='mini';open.href=url;open.target='_blank';open.rel='noreferrer';open.textContent='Open';const dl=document.createElement('a');dl.className='mini';dl.href=url;dl.download=`velora-${d.type}-${i+1}`;dl.textContent='Download';foot.append(open,dl);item.appendChild(foot);box.appendChild(item)})}$('#mediaStatus').textContent=`via ${d.provider||'provider'}`}catch(err){$('#mediaResults').innerHTML=`<div class="media-empty">${esc(err.message)}</div>`;$('#mediaStatus').textContent='Error'}finally{btn.disabled=false;btn.textContent='Generate'}};
function makeProvider(){const id=$('#newProviderId').value.trim()||$('#newProviderName').value.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');const obj={id,name:$('#newProviderName').value.trim(),key:$('#newProviderKey').value,baseUrl:$('#newProviderBase').value.trim(),model:$('#newProviderModel').value.trim()};if($('#newImageUrl').value.trim())obj.imageUrl=$('#newImageUrl').value.trim();if($('#newVideoUrl').value.trim())obj.videoUrl=$('#newVideoUrl').value.trim();$('#providerJsonOut').value=JSON.stringify([obj],null,2);}
$('#buildProviderBtn').onclick=makeProvider;$('#copyProviderBtn').onclick=()=>{navigator.clipboard?.writeText($('#providerJsonOut').value)};
loadProviders();

window.VeloraRender={renderAssistantBubble,copyText,downloadFile};
