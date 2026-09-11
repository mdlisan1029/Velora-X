(() => {
  'use strict';

  const DB_NAME = 'velora-x-db';
  const DB_VERSION = 1;
  const STORE = 'chats';
  const ACTIVE_KEY = 'velora-x-active-chat';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const messagesEl = $('#messages');
  if (!messagesEl) return;

  const state = {
    db: null,
    chats: [],
    activeId: null,
    initialized: false,
    loading: false,
  };

  const css = document.createElement('style');
  css.textContent = `
    .vx-history-card{order:-1}
    .vx-history-toggle{display:none}
    .vx-history-drawer{position:fixed;inset:0 auto 0 0;width:min(330px,86vw);z-index:90;background:#09111d;border-right:1px solid rgba(255,255,255,.1);box-shadow:18px 0 50px rgba(0,0,0,.45);transform:translateX(-105%);transition:transform .18s ease;overflow:auto;padding:12px}
    .vx-history-drawer.open{transform:translateX(0)}
    .vx-history-overlay{display:none;position:fixed;inset:0;z-index:89;background:rgba(0,0,0,.48)}
    .vx-history-overlay.open{display:block}
    .vx-history-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
    .vx-history-list{display:flex;flex-direction:column;gap:6px;max-height:52vh;overflow:auto}
    .vx-history-item{display:flex;align-items:center;gap:6px;padding:8px;border:1px solid rgba(255,255,255,.08);border-radius:11px;background:rgba(255,255,255,.025)}
    .vx-history-open{flex:1;min-width:0;border:0;background:none;color:#d8e3ef;text-align:left;padding:4px;font:inherit;cursor:pointer}
    .vx-history-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:700}
    .vx-history-time{display:block;color:#73849a;font-size:8px;margin-top:2px}
    .vx-history-icon{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#b8c8d8;border-radius:8px;width:30px;height:30px;cursor:pointer}
    .vx-history-empty{color:#718198;font-size:10px;padding:10px 2px}
    .vx-chat-card{margin-bottom:10px}
    .vx-chat-card .head{margin-bottom:8px}
    .vx-chat-count{font-size:9px;color:#718198}
    @media(max-width:680px){
      .vx-history-toggle{display:inline-flex}
      .vx-history-card{display:none!important}
      .vx-history-drawer{display:block}
      .vx-history-list{max-height:none}
    }
  `;
  document.head.appendChild(css);

  const requestIDB = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllChats() {
    if (!state.db) return [];
    const tx = state.db.transaction(STORE, 'readonly');
    return requestIDB(tx.objectStore(STORE).getAll());
  }

  async function putChat(chat) {
    if (!state.db) return;
    const tx = state.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(chat);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }

  async function deleteChat(id) {
    if (!state.db) return;
    const tx = state.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }

  function makeId() { return `chat_${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }
  function titleFrom(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, 48) + (clean.length > 48 ? '…' : '') : 'New chat';
  }
  function formatTime(ts) {
    try { return new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).format(new Date(ts)); }
    catch { return ''; }
  }

  function ensureActive() {
    if (!state.activeId) state.activeId = localStorage.getItem(ACTIVE_KEY) || makeId();
    localStorage.setItem(ACTIVE_KEY, state.activeId);
  }

  function createChatRecord() {
    const now = Date.now();
    return { id: makeId(), title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
  }

  async function currentChat() {
    ensureActive();
    return state.chats.find(c => c.id === state.activeId) || null;
  }

  function renderMessages(chat) {
    const clear = $('#clearBtn');
    if (clear) clear.click();
    messagesEl.innerHTML = '';
    if (!chat?.messages?.length) {
      messagesEl.innerHTML = `<div class="welcome"><div class="orb"></div><div class="eyebrow" style="margin-top:18px">VELORA X ONLINE</div><h2>Pick a model. Create.</h2><p>Use the provider and model selectors, then chat.</p><div class="suggestions"><button class="suggestion" data-prompt="Explain this concept simply with an example: quantum entanglement">Explain a complex topic</button><button class="suggestion" data-prompt="Write a production-ready responsive landing page in HTML and CSS">Generate website code</button><button class="suggestion" data-prompt="Give me 10 realistic product ideas I could build with APIs">Product ideas</button></div></div>`;
      $$('.suggestion', messagesEl).forEach(b => b.addEventListener('click', () => { const p = $('#prompt'); p.value = b.dataset.prompt; p.dispatchEvent(new Event('input')); p.focus(); }));
      return;
    }
    chat.messages.forEach(msg => {
      const wrap = document.createElement('div');
      wrap.className = `message ${msg.role}`;
      const inner = document.createElement('div'); inner.className = 'bubble-wrap';
      const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = msg.content || '';
      inner.appendChild(bubble);
      if (msg.meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = msg.meta; inner.appendChild(m); }
      wrap.appendChild(inner); messagesEl.appendChild(wrap);
    });
    requestAnimationFrame(() => { const sc = document.scrollingElement || document.documentElement; sc.scrollTop = sc.scrollHeight; messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  function renderList(root) {
    const list = $('.vx-history-list', root);
    const count = $('.vx-chat-count', root);
    if (!list) return;
    const chats = [...state.chats].sort((a,b) => b.updatedAt - a.updatedAt);
    if (count) count.textContent = `${chats.length} chat${chats.length === 1 ? '' : 's'}`;
    list.innerHTML = '';
    if (!chats.length) { list.innerHTML = '<div class="vx-history-empty">No saved chats yet.</div>'; return; }
    chats.forEach(chat => {
      const row = document.createElement('div'); row.className = 'vx-history-item';
      const open = document.createElement('button'); open.className = 'vx-history-open';
      open.innerHTML = `<span class="vx-history-title"></span><span class="vx-history-time"></span>`;
      $('.vx-history-title', open).textContent = chat.title || 'New chat';
      $('.vx-history-time', open).textContent = formatTime(chat.updatedAt);
      open.onclick = async () => { state.activeId = chat.id; localStorage.setItem(ACTIVE_KEY, chat.id); renderMessages(chat); closeDrawer(); renderList(root); };
      const rename = document.createElement('button'); rename.className='vx-history-icon'; rename.textContent='✎'; rename.title='Rename';
      rename.onclick = async () => { const name = prompt('Chat name', chat.title || 'New chat'); if (!name?.trim()) return; chat.title = name.trim().slice(0,80); chat.updatedAt = Date.now(); await putChat(chat); state.chats = await getAllChats(); renderList(root); };
      const del = document.createElement('button'); del.className='vx-history-icon'; del.textContent='×'; del.title='Delete';
      del.onclick = async () => { if (!confirm(`Delete “${chat.title}”?`)) return; await deleteChat(chat.id); state.chats = await getAllChats(); if (state.activeId === chat.id) { const fresh=createChatRecord(); state.activeId=fresh.id; await putChat(fresh); state.chats=[...state.chats,fresh]; renderMessages(fresh); } renderList(root); };
      row.append(open, rename, del); list.appendChild(row);
    });
  }

  const drawer = document.createElement('aside'); drawer.className='vx-history-drawer';
  drawer.innerHTML = `<div class="vx-history-head"><strong>Chat history</strong><button class="vx-history-icon" data-close>×</button></div><button class="btn primary" data-new style="width:100%;margin-bottom:10px">+ New chat</button><div class="vx-history-list"></div>`;
  const overlay = document.createElement('div'); overlay.className='vx-history-overlay';
  document.body.append(drawer, overlay);
  const closeDrawer = () => { drawer.classList.remove('open'); overlay.classList.remove('open'); };
  const openDrawer = () => { drawer.classList.add('open'); overlay.classList.add('open'); };
  $('[data-close]', drawer).onclick = closeDrawer;
  overlay.onclick = closeDrawer;
  $('[data-new]', drawer).onclick = () => { $('#newChatBtn')?.click(); closeDrawer(); };

  const desktopCard = document.createElement('section'); desktopCard.className='card vx-history-card';
  desktopCard.innerHTML = `<div class="head"><span>Chat history</span><span class="vx-chat-count">0 chats</span></div><div class="vx-history-list"></div>`;
  const sidebar = $('.sidebar');
  if (sidebar) sidebar.prepend(desktopCard);
  const topActions = $('.top-actions');
  if (topActions) {
    const toggle = document.createElement('button'); toggle.className='btn vx-history-toggle'; toggle.textContent='History'; toggle.type='button'; toggle.onclick=openDrawer; topActions.prepend(toggle);
  }

  async function init() {
    if (state.initialized) return; state.initialized = true;
    try { state.db = await openDB(); } catch { state.db = null; }
    state.chats = state.db ? await getAllChats() : [];
    ensureActive();
    let active = state.chats.find(c => c.id === state.activeId);
    if (!active) { active=createChatRecord(); state.activeId=active.id; state.chats.push(active); await putChat(active); }
    renderList(desktopCard); renderList(drawer);

    const clearBtn = $('#clearBtn');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      const fresh=createChatRecord();
      state.activeId=fresh.id; localStorage.setItem(ACTIVE_KEY, fresh.id);
      state.chats.push(fresh); await putChat(fresh); renderList(desktopCard); renderList(drawer);
    });

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      let isChat = false;
      try { const url = typeof input === 'string' ? input : input?.url || ''; isChat = new URL(url, location.href).pathname === '/api/chat'; } catch {}
      if (!isChat || !init?.body) return originalFetch(input, init);

      let body;
      try { body = JSON.parse(init.body); } catch { return originalFetch(input, init); }
      const activeChat = state.chats.find(c => c.id === state.activeId) || createChatRecord();
      if (body.messages?.length <= 1 && activeChat.messages.length) {
        body.messages = [...activeChat.messages, ...body.messages];
      }
      init.body = JSON.stringify(body);
      const response = await originalFetch(input, init);

      try {
        const clone = response.clone();
        clone.text().then(async raw => {
          let assistant = '';
          if (raw.startsWith('data:') || raw.includes('\ndata:')) {
            for (const event of raw.split(/\r?\n\r?\n/)) {
              for (const line of event.split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                const data=line.slice(5).trim(); if (!data || data === '[DONE]') continue;
                try { const j=JSON.parse(data); assistant += String(j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? ''); } catch {}
              }
            }
          } else { try { const j=JSON.parse(raw); assistant=String(j.data?.choices?.[0]?.message?.content ?? j.choices?.[0]?.message?.content ?? ''); } catch {} }
          const sent = body.messages?.findLast?.(m => m.role === 'user') || [...(body.messages||[])].reverse().find(m => m.role === 'user');
          if (!sent || !assistant.trim()) return;
          const chat = state.chats.find(c => c.id === state.activeId) || activeChat;
          chat.messages = [...(body.messages || []).map(m => ({ role:m.role, content:String(m.content ?? '') })), { role:'assistant', content:assistant, meta: response.headers.get('X-Velora-Provider') ? `via ${response.headers.get('X-Velora-Provider')}` : '' }];
          chat.title = chat.title === 'New chat' ? titleFrom(sent.content) : chat.title;
          chat.updatedAt = Date.now();
          await putChat(chat);
          state.chats = state.chats.filter(c => c.id !== chat.id).concat(chat);
          renderList(desktopCard); renderList(drawer);
        }).catch(()=>{});
      } catch {}
      return response;
    };
  }

  init();
})();
