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
  html:'html',htm:'html',css:'css',js:'js',jsx:'jsx',ts:'ts',tsx:'tsx',json:'json',py:'py',python:'py',java:'java',c:'c',h:'h',cpp:'cpp',cc:'cpp',cxx:'cpp',cs:'cs',php:'php',rb:'rb',go:'go',rs:'rs',swift:'swift',kt:'kt',kotlin:'kt',sql:'sql',sh:'sh',bash:'sh',zsh:'sh',yaml:'yml',yml:'yml',xml:'xml',svg:'svg',md:'md',markdown:'md',txt:'txt'
};
function normalizeLang(lang){const raw=String(lang||'').trim().toLowerCase().replace(/^language-/,'');return raw;}
function codeFilename(lang, index=1){const key=normalizeLang(lang);const ext=EXTENSIONS[key]||'txt';const base=({html:'velora-page',css:'velora-styles',js:'velora-script',jsx:'velora-component',ts:'velora-script',tsx:'velora-component',json:'velora-data',py:'velora-script',sql:'velora-query',md:'velora-document',svg:'velora-image'}[key]||`velora-code-${index}`);return `${base}.${ext}`;}
function downloadFile(content,name,type='text/plain;charset=utf-8'){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function copyText(text){try{return navigator.clipboard?.writeText(text)}catch{return Promise.resolve();}}
function previewHTML(code){const w=window.open('about:blank','_blank');if(!w){alert('Popup blocked. Allow popups to preview HTML.');return;}w.document.open();w.document.write(code);w.document.close();}
function parseMarkdownBlocks(text){
  const src=String(text||'').replace(/\r\n?/g,'\n');
  const tokens=[];let rest=src;let codeIndex=0;
  const fenceRe=/```([\w+-]*)\n([\s\S]*?)```/;
  while(rest){
    const m=rest.match(fenceRe); if(!m){tokens.push({type:'text',value:rest});break;}
    const start=m.index; if(start>0)tokens.push({type:'text',value:rest.slice(0,start)});
    tokens.push({type:'code',lang:normalizeLang(m[1]),value:m[2].replace(/\n$/,''),index:++codeIndex});
    rest=rest.slice(start+m[0].length);
  }
  return tokens;
}
function inlineMarkdown(raw){
  let s=esc(raw);
  s=s.replace(/`([^`\n]+)`/g,'<code class="md-inline-code">$1</code>');
  s=s.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/__([^_\n]+)__/g,'<strong>$1</strong>');
  s=s.replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
  s=s.replace(/_([^_\n]+)_/g,'<em>$1</em>');
  s=s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');
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
    m=line.match(/^[-*]\s+(.+)$/);if(m){flushPara();if(!list){html+='<ul>';list=true;}html+=`<li>${inlineMarkdown(m[1])}</li>`;continue;}
    m=line.match(/^\d+\.\s+(.+)$/);if(m){flushPara();if(list!=='ol'){closeList();html+='<ol>';list='ol';}html+=`<li>${inlineMarkdown(m[1])}</li>`;continue;}
    if(/^>\s?/.test(line)){flushPara();closeList();html+=`<blockquote>${inlineMarkdown(line.replace(/^>\s?/,''))}</blockquote>`;continue;}
    para.push(line);
  }
  flushPara();closeList();
  return html;
}
function makeCodeBlock(code,lang,index){
  const wrap=document.createElement('div');wrap.className='md-code-block';
  const head=document.createElement('div');head.className='md-code-head';
  const label=document.createElement('span');label.className='md-code-lang';label.textContent=lang||'code';
  const actions=document.createElement('div');actions.className='md-code-actions';
  const copy=document.createElement('button');copy.type='button';copy.className='mini';copy.textContent='Copy code';copy.onclick=()=>copyText(code);
  const file=codeFilename(lang,index);
  const download=document.createElement('button');download.type='button';download.className='mini';download.textContent=`Download .${file.split('.').pop()}`;download.onclick=()=>downloadFile(code,file,mimeForExtension(file));
  actions.append(copy,download);
  if(['html','htm','svg'].includes(normalizeLang(lang))){const preview=document.createElement('button');preview.type='button';preview.className='mini';preview.textContent='Preview';preview.onclick=()=>previewHTML(code);actions.appendChild(preview);}
  head.append(label,actions);
  const pre=document.createElement('pre');const codeEl=document.createElement('code');codeEl.textContent=code;pre.appendChild(codeEl);wrap.append(head,pre);return wrap;
}
function mimeForExtension(file){const ext=String(file).split('.').pop().toLowerCase();return ({html:'text/html',css:'text/css',js:'text/javascript',json:'application/json',md:'text/markdown',xml:'application/xml',svg:'image/svg+xml',py:'text/x-python',sql:'text/plain',yml:'text/yaml',yaml:'text/yaml'}[ext]||'text/plain')+';charset=utf-8';}
function renderAssistantBubble(bubble,text){
  const raw=String(text||'');bubble.classList.add('md-content');bubble.innerHTML='';
  for(const token of parseMarkdownBlocks(raw)){
    if(token.type==='code')bubble.appendChild(makeCodeBlock(token.value,token.lang,token.index));
    else{const holder=document.createElement('div');holder.className='md-prose';holder.innerHTML=textMarkdownHTML(token.value);bubble.appendChild(holder);}
  }
}
window.VeloraRender={renderAssistantBubble,makeCodeBlock};

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
  const stick=isNearBottom()||role==='user';wrap.appendChild(inner);messagesEl.appendChild(wrap);if(stick)requestAnimationFrame(scrollBottom);return bubble;
}
function addHTMLActions(bubble){const host=bubble.parentElement;if(!host||host.querySelector('.md-code-block'))return;}
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
