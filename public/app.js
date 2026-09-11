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
function scrollBottom(){messagesEl.scrollTop=messagesEl.scrollHeight;}
function setBusy(v){busy=v;sendBtn.disabled=v;promptEl.disabled=v;}
function modelOptions(providerId){
  const p=providers.find(x=>x.id===providerId);
  modelSelect.innerHTML='<option value="">Provider default</option>';
  (p?.models || (p?.model ? [p.model] : [])).forEach(m=>{modelSelect.innerHTML += `<option value="${esc(m)}">${esc(m)}</option>`});
}
function selectProvider(id){
  providerSelect.value=id;
  modelOptions(id);
  $$('.provider').forEach(x=>x.classList.toggle('active',x.dataset.id===id));
}
function addMessage(role,text,meta=''){
  document.querySelector('.welcome')?.remove();
  const wrap=document.createElement('div');wrap.className=`message ${role}`;
  const inner=document.createElement('div');inner.className='bubble-wrap';
  const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=text;inner.appendChild(bubble);
  if(meta){const m=document.createElement('div');m.className='meta';m.textContent=meta;inner.appendChild(m)}
  if(role==='assistant'){
    const acts=document.createElement('div');acts.className='bubble-actions';
    const copy=document.createElement('button');copy.className='mini';copy.textContent='Copy';copy.onclick=()=>navigator.clipboard?.writeText(bubble.textContent||'');
    const save=document.createElement('button');save.className='mini';save.textContent='Save .txt';save.onclick=()=>downloadText(bubble.textContent||'answer','velora-answer.txt');
    acts.append(copy,save);inner.appendChild(acts);
  }
  wrap.appendChild(inner);messagesEl.appendChild(wrap);scrollBottom();return bubble;
}
function downloadText(text,name){const blob=new Blob([text],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function loadProviders(){
  try{
    const r=await fetch('/api/health');const d=await r.json();providers=d.providers||[];providerCount.textContent=providers.length;
    providerList.innerHTML='';providerSelect.innerHTML='<option value="auto">Auto / first available</option>';
    const mediaProviders=[];
    providers.forEach(p=>{
      const row=document.createElement('div');row.className='provider';row.dataset.id=p.id;row.innerHTML=`<span class="dot"></span><span class="name">${esc(p.name)}</span><span class="model">${esc(p.model)}</span>`;row.onclick=()=>selectProvider(p.id);providerList.appendChild(row);
      if(p.chat) providerSelect.innerHTML += `<option value="${esc(p.id)}">${esc(p.name)}</option>`;
      if(p.image||p.video) mediaProviders.push(p);
    });
    if(!providers.length) providerList.innerHTML='<div class="muted">No API providers configured.</div>';
    $('#mediaProvider').innerHTML='<option value="">Auto</option>'+mediaProviders.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  }catch{providerList.innerHTML='<div class="muted">Could not load providers.</div>'}
}
async function streamChat(){
  const text=promptEl.value.trim();if(!text||busy)return;
  addMessage('user',text);history.push({role:'user',content:text});promptEl.value='';promptEl.style.height='auto';setBusy(true);
  const placeholder=addMessage('assistant','Thinking…');
  try{
    const providerId=providerSelect.value;const payload={messages:history,model:modelSelect.value||'',temperature:Number(tempRange.value),max_tokens:Number(maxTokens.value),reasoning_effort:reasoning.value||undefined,stream:true,providerOrder:providerId==='auto'?[]:[providerId]};
    const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!r.ok){const e=await r.json().catch(()=>({error:'Request failed'}));throw new Error(e.error||'Request failed')}
    const provider=r.headers.get('X-Velora-Provider');const reader=r.body.getReader();const decoder=new TextDecoder();let buf='',full='';
    while(true){const {value,done}=await reader.read();if(done)break;buf+=decoder.decode(value,{stream:true});const lines=buf.split(/\r?\n/);buf=lines.pop()||'';for(const line of lines){const t=line.trim();if(!t.startsWith('data:'))continue;const x=t.slice(5).trim();if(!x||x==='[DONE]')continue;try{const j=JSON.parse(x);const delta=j.choices?.[0]?.delta?.content??'';if(delta){full+=delta;placeholder.textContent=full;scrollBottom()}}catch{}}}
    placeholder.textContent=full||'No text response returned.';lastAssistantText=full;const m=document.createElement('div');m.className='meta';m.textContent=provider?`via ${provider}`:'via configured provider';placeholder.parentElement.appendChild(m);history.push({role:'assistant',content:full||''});
  }catch(err){placeholder.textContent=`Error: ${err.message}`;placeholder.style.color='var(--bad)';history.pop();}
  finally{setBusy(false);promptEl.disabled=false;promptEl.focus();scrollBottom()}
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
$('#copyLastBtn').onclick=async()=>{if(lastAssistantText)await navigator.clipboard?.writeText(lastAssistantText)};
$('#statusBtn').onclick=async()=>{statusDialog.showModal();statusBody.innerHTML='<div class="muted">Loading…</div>';try{const r=await fetch('/api/health');const d=await r.json();statusBody.innerHTML=(d.providers||[]).map(p=>`<div class="status-row"><b>${esc(p.name)}</b><span>${esc(p.model)}</span><span>${p.image?'Image ':''}${p.video?'Video':''}${!p.image&&!p.video?'Chat':''}</span></div>`).join('')||'<div class="muted">No providers configured.</div>'}catch{statusBody.innerHTML='<div class="muted">Unable to load status.</div>'}};
$('#closeDialog').onclick=()=>statusDialog.close();
$('#mediaType').addEventListener('change',()=>{const type=$('#mediaType').value;$('#mediaStatus').textContent=type==='image'?'Image mode':'Video mode'});
$('#generateMediaBtn').onclick=async()=>{
  const btn=$('#generateMediaBtn');const prompt=$('#mediaPrompt').value.trim();if(!prompt)return alert('Enter a media prompt first.');btn.disabled=true;btn.textContent='Generating…';$('#mediaStatus').textContent='Working';
  try{const body={type:$('#mediaType').value,prompt,providerId:$('#mediaProvider').value,model:$('#mediaModel').value.trim()||undefined,size:$('#mediaSize').value,duration:$('#mediaDuration').value.trim()||undefined,quality:$('#mediaQuality').value};const r=await fetch('/api/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Generation failed');const urls=d.urls||[];const box=$('#mediaResults');box.innerHTML='';if(!urls.length){box.innerHTML='<div class="media-empty">Provider returned no direct media URL. Check the raw provider response or configure a compatible media endpoint.</div>'}else{urls.forEach((url,i)=>{const item=document.createElement('div');item.className='media-item';const media=d.type==='video'?document.createElement('video'):document.createElement('img');if(d.type==='video'){media.src=url;media.controls=true}else{media.src=url;media.alt='Generated media'}item.appendChild(media);const foot=document.createElement('div');foot.className='media-foot';const open=document.createElement('a');open.className='mini';open.href=url;open.target='_blank';open.rel='noreferrer';open.textContent='Open';const dl=document.createElement('a');dl.className='mini';dl.href=url;dl.download=`velora-${d.type}-${i+1}`;dl.textContent='Download';foot.append(open,dl);item.appendChild(foot);box.appendChild(item)})}$('#mediaStatus').textContent=`via ${d.provider||'provider'}`}catch(err){$('#mediaResults').innerHTML=`<div class="media-empty">${esc(err.message)}</div>`;$('#mediaStatus').textContent='Error'}finally{btn.disabled=false;btn.textContent='Generate'}};
function makeProvider(){
  const id=$('#newProviderId').value.trim()||$('#newProviderName').value.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const obj={id,name:$('#newProviderName').value.trim(),key:$('#newProviderKey').value,baseUrl:$('#newProviderBase').value.trim(),model:$('#newProviderModel').value.trim()};
  if($('#newImageUrl').value.trim())obj.imageUrl=$('#newImageUrl').value.trim();if($('#newVideoUrl').value.trim())obj.videoUrl=$('#newVideoUrl').value.trim();$('#providerJsonOut').value=JSON.stringify([obj],null,2);
}
$('#buildProviderBtn').onclick=makeProvider;$('#copyProviderBtn').onclick=()=>{navigator.clipboard?.writeText($('#providerJsonOut').value)};
loadProviders();
