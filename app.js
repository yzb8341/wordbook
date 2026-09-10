'use strict';

/* ============================= helpers ============================= */

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ============================= IndexedDB ============================= */

const DB_NAME = 'wordbook';
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('lists')) {
        d.createObjectStore('lists', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('words')) {
        const ws = d.createObjectStore('words', { keyPath: 'id' });
        ws.createIndex('listId', 'listId', { unique: false });
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function req(store, fn, mode) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode || 'readonly');
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function getAll(store) { return req(store, (s) => s.getAll()); }
function getOne(store, key) { return req(store, (s) => s.get(key)); }
function putOne(store, value) { return req(store, (s) => s.put(value), 'readwrite'); }
function delOne(store, key) { return req(store, (s) => s.delete(key), 'readwrite'); }
function clearStore(store) { return req(store, (s) => s.clear(), 'readwrite'); }

async function getSetting(key, def) {
  const s = await getOne('settings', key);
  return s ? s.value : def;
}
function setSetting(key, value) {
  return putOne('settings', { key, value });
}

/* ============================= dictionary ============================= */

let DICT = null;
async function loadDict() {
  if (DICT) return;
  const res = await fetch('dictionary.json');
  if (!res.ok) throw new Error('dictionary ' + res.status);
  DICT = await res.json();
}

function lookup(word) {
  if (!DICT) return '';
  return DICT[String(word).toLowerCase().trim()] || '';
}

/* ============================= TTS / loop ============================= */

let ttsToken = 0;
let loopMode = null; // 'once' | 'word' | 'list' | null
let loopStop = false;

function allVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices() || [];
}

function voiceIdentifier(v) {
  return v.name || v.voiceURI || '';
}

function isGoogleVoice(v) {
  return /google/i.test(v.name || '') || /google/i.test(v.voiceURI || '');
}

function isNeuralLike(v) {
  return /neural|natural|online/i.test((v.name || '') + ' ' + (v.voiceURI || ''));
}

function bestDefaultVoice(voices) {
  const en = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  const google = en.filter(isGoogleVoice);
  const neural = google.filter(isNeuralLike);
  const pick = (list) =>
    list.find((v) => /en-us/i.test(v.lang)) ||
    list.find((v) => /en-gb/i.test(v.lang)) ||
    list[0];
  return pick(neural) || pick(google) || pick(en) || voices[0] || null;
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = allVoices();
  if (!vs.length) return null;
  if (savedVoiceId) {
    const saved = vs.find((v) => voiceIdentifier(v) === savedVoiceId);
    if (saved) return saved;
  }
  return bestDefaultVoice(vs);
}

function speak(text, rate) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-US'; }
    u.rate = rate;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);
    const fallback = Math.max(1800, (String(text).length + 3) * 900 / Math.max(0.3, rate));
    setTimeout(finish, fallback);
  });
}

function isActive(token) {
  return token === ttsToken && !loopStop;
}

async function spellWord(text, rate, hlFn, token) {
  const letters = String(text).toLowerCase().replace(/[^a-z]/g, '').split('');
  for (let i = 0; i < letters.length; i++) {
    if (!isActive(token)) return false;
    if (hlFn) hlFn(i);
    await speak(letters[i], rate);
  }
  if (!isActive(token)) return false;
  if (hlFn) hlFn(-1);
  await speak(text, rate);
  return isActive(token);
}

function cancelTTS() {
  ttsToken++;
  loopStop = true;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function setLoopMode(m) { loopMode = m; updateLoopButtons(); }

function updateLoopButtons() {
  const running = !!loopMode;
  ['btnOnce', 'btnWord', 'btnList'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.disabled = running;
  });
  const s = document.getElementById('btnStop');
  if (s) s.disabled = !running;
}

function stopAll() {
  cancelTTS();
  setLoopMode(null);
  highlightLetter(-1);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startLoop(mode) {
  cancelTTS();
  const myToken = ttsToken;
  loopStop = false;
  setLoopMode(mode);
  const rate = await getSetting('rate', 1);
  const gap = (await getSetting('intervalSeconds', 2)) * 1000;
  const hl = (i) => highlightLetter(i);
  try {
    if (mode === 'once') {
      const w = currentListenWord();
      if (w) await spellWord(w.word, rate, hl, myToken);
    } else if (mode === 'word') {
      const w = currentListenWord();
      while (w && isActive(myToken)) {
        const ok = await spellWord(w.word, rate, hl, myToken);
        if (!ok) break;
        await sleep(gap);
      }
    } else if (mode === 'list') {
      while (isActive(myToken)) {
        const q = queueWords();
        if (!q.length) break;
        for (const w of q) {
          if (!isActive(myToken)) break;
          setCurrentWord(w.id);
          const ok = await spellWord(w.word, rate, hl, myToken);
          if (!ok) break;
          await sleep(gap);
        }
      }
    }
  } finally {
    if (myToken === ttsToken) {
      setLoopMode(null);
      highlightLetter(-1);
    }
  }
}

async function spellOnce(text) {
  cancelTTS();
  const myToken = ttsToken;
  loopStop = false;
  const rate = await getSetting('rate', 1);
  await spellWord(text, rate, null, myToken);
}

function highlightLetter(i) {
  const spans = document.querySelectorAll('#listenWord .letter');
  spans.forEach((s, idx) => s.classList.toggle('hl', idx === i));
}

/* ============================= state ============================= */

let currentTab = 'lists';
let currentListId = null;
let currentListName = '';
let listWords = [];
let listSearch = '';
let selectMode = false;
let selectedIds = new Set();
let listenWords = [];
let currentWordId = null;
let queueIds = new Set();
let listenGap = 2;
let listenRate = 1;
let savedVoiceId = '';
let reviewMode = 'flash';
let review = null;
let bulkPreview = [];

const RATES = [0.5, 0.75, 1, 1.25, 1.5];

/* ============================= topbar / tabs ============================= */

function setTopbar(title, backFn, actionText, actionFn) {
  document.getElementById('title').textContent = title;
  const back = document.getElementById('backBtn');
  if (backFn) { back.hidden = false; back.onclick = backFn; }
  else { back.hidden = true; back.onclick = null; }
  const act = document.getElementById('topAction');
  if (actionText) { act.hidden = false; act.textContent = actionText; act.onclick = actionFn; }
  else { act.hidden = true; act.onclick = null; }
  document.getElementById('tabbar').hidden = !!backFn;
}

function goTab(tab) {
  currentTab = tab;
  selectMode = false;
  selectedIds = new Set();
  listSearch = '';
  review = null;
  stopAll();
  document.querySelectorAll('#tabbar button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  const titles = { lists: '单词听读', review: '背词', settings: '设置' };
  setTopbar(titles[tab], null);
  if (tab === 'lists') renderLists();
  else if (tab === 'review') renderReview();
  else renderSettings();
}

function goLists() { goTab('lists'); }

/* ============================= lists view ============================= */

async function renderLists() {
  setTopbar('单词听读', null);
  const lists = await getAll('lists');
  lists.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const words = await getAll('words');
  const counts = {};
  words.forEach((w) => { counts[w.listId] = (counts[w.listId] || 0) + 1; });

  let html = '';
  if (!lists.length) {
    html = '<div class="empty">还没有词表，点击下面按钮新建一个</div>';
  }
  for (const l of lists) {
    html += `<div class="list-item" onclick="openList('${l.id}')">
      <div class="main"><div class="name">${esc(l.name)}</div><div class="meta">${counts[l.id] || 0} 个单词</div></div>
      <button class="icon-btn" onclick="event.stopPropagation();deleteList('${l.id}')" aria-label="删除">×</button>
    </div>`;
  }
  html += `<button class="btn block" onclick="newList()">＋ 新建词表</button>`;
  document.getElementById('screen').innerHTML = html;
}

function newList() {
  const name = prompt('词表名称：');
  if (!name || !name.trim()) return;
  putOne('lists', { id: uid(), name: name.trim(), createdAt: Date.now() }).then(() => renderLists());
}

async function deleteList(id) {
  if (!confirm('删除这个词表以及其中的所有单词？')) return;
  await delOne('lists', id);
  const words = await getAll('words');
  for (const w of words) if (w.listId === id) await delOne('words', w.id);
  renderLists();
}

function openList(id) {
  currentListId = id;
  renderListDetail(id);
}

/* ============================= list detail ============================= */

async function renderListDetail(id) {
  stopAll();
  const list = await getOne('lists', id);
  currentListId = id;
  currentListName = list ? list.name : '词表';
  setTopbar(currentListName, goLists, selectMode ? '完成' : '多选', toggleSelectMode);
  listWords = (await getAll('words'))
    .filter((w) => w.listId === id)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  document.getElementById('screen').innerHTML = `
    <input class="search" id="listSearch" placeholder="搜索单词" value="${esc(listSearch)}" oninput="onListSearch(this.value)">
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn ghost" onclick="addWords()">＋ 添加单词</button>
      <button class="btn ghost" onclick="openListen('${id}')">🔊 循环听</button>
    </div>
    <div id="wordListWrap"></div>`;
  refreshWordList();
}

function onListSearch(v) { listSearch = v; refreshWordList(); }

function toggleSelectMode() {
  selectMode = !selectMode;
  if (!selectMode) selectedIds = new Set();
  setTopbar(currentListName, goLists, selectMode ? '完成' : '多选', toggleSelectMode);
  refreshWordList();
}

function refreshWordList() {
  const wrap = document.getElementById('wordListWrap');
  if (!wrap) return;
  const q = listSearch.trim().toLowerCase();
  const filtered = listWords.filter((w) => {
    return !q || w.word.toLowerCase().includes(q) || (w.translation || '').toLowerCase().includes(q);
  });
  let html = '';
  if (selectMode) {
    html += `<div class="btn-row" style="margin-bottom:12px">
      <button class="btn" onclick="listenSelected()" ${selectedIds.size ? '' : 'disabled'}>循环听所选 (${selectedIds.size})</button>
      <button class="btn danger" onclick="deleteSelected()" ${selectedIds.size ? '' : 'disabled'}>删除所选</button>
    </div>`;
  }
  if (!filtered.length) {
    html += '<div class="empty">' + (q ? '没有匹配的单词' : '还没有单词，点“添加单词”开始') + '</div>';
  }
  for (const w of filtered) {
    const ck = selectMode ? `<input type="checkbox" class="check" ${selectedIds.has(w.id) ? 'checked' : ''} onchange="toggleWordSelect('${w.id}', this.checked)">` : '';
    const mainAction = selectMode
      ? `toggleWordSelect('${w.id}', !selectedIds.has('${w.id}'))`
      : `openEditWord('${w.id}')`;
    const speaker = selectMode ? '' : `<button class="speaker" onclick="event.stopPropagation();playWordOnce('${w.id}')">▶</button>`;
    html += `<div class="word-row">
      ${ck}
      <div class="main" onclick="${mainAction}">
        <div class="word">${esc(w.word)}</div>
        <div class="trans">${esc(w.translation || '（无翻译）')}</div>
      </div>
      ${speaker}
    </div>`;
  }
  wrap.innerHTML = html;
}

function toggleWordSelect(id, checked) {
  if (checked) selectedIds.add(id); else selectedIds.delete(id);
  refreshWordList();
}

async function deleteSelected() {
  if (!selectedIds.size) return;
  if (!confirm(`删除所选 ${selectedIds.size} 个单词？`)) return;
  for (const id of selectedIds) await delOne('words', id);
  selectedIds = new Set();
  listWords = (await getAll('words'))
    .filter((w) => w.listId === currentListId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  refreshWordList();
}

async function playWordOnce(id) {
  const w = listWords.find((x) => x.id === id);
  if (w) spellOnce(w.word);
}

/* ============================= add / edit word ============================= */

function addWords() {
  stopAll();
  setTopbar('添加单词', () => renderListDetail(currentListId));
  document.getElementById('screen').innerHTML = `
    <p class="hint">每行一个单词，可以一次粘贴多个：</p>
    <textarea id="bulkWds" placeholder="apple&#10;banana&#10;cherry"></textarea>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn ghost" onclick="renderListDetail(currentListId)">取消</button>
      <button class="btn" onclick="previewBulk()">查询翻译</button>
    </div>`;
}

function previewBulk() {
  const raw = document.getElementById('bulkWds').value;
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) { toast('请先输入单词'); return; }
  bulkPreview = [...new Set(lines)];
  let rows = '';
  bulkPreview.forEach((w, i) => {
    rows += `<div class="word-row">
      <div class="word" style="min-width:88px">${esc(w)}</div>
      <input type="text" id="bulkTrans${i}" value="${esc(lookup(w))}" placeholder="翻译" style="flex:1;border:1px solid var(--line);border-radius:10px;padding:9px 10px">
    </div>`;
  });
  document.getElementById('screen').innerHTML = `
    <h2 style="margin:0 0 4px">核对并保存</h2>
    <p class="hint" style="margin-top:0">已自动带出翻译，可直接修改：</p>
    <div style="max-height:58vh;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:var(--radius)">${rows}</div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn ghost" onclick="addWords()">返回</button>
      <button class="btn" onclick="saveBulk()">保存 ${bulkPreview.length} 个</button>
    </div>`;
}

async function saveBulk() {
  const now = Date.now();
  for (let i = 0; i < bulkPreview.length; i++) {
    const word = bulkPreview[i];
    const trans = document.getElementById('bulkTrans' + i).value.trim();
    await putOne('words', {
      id: uid(),
      listId: currentListId,
      word: word,
      translation: trans || lookup(word) || '',
      createdAt: now + i,
      review: { due: Date.now(), interval: 0, reps: 0, lapses: 0 }
    });
  }
  toast('已保存 ' + bulkPreview.length + ' 个单词');
  renderListDetail(currentListId);
}

async function openEditWord(id) {
  const w = listWords.find((x) => x.id === id) || (await getOne('words', id));
  if (!w) return;
  showModal(`
    <h2>编辑单词</h2>
    <label class="small muted">英文</label>
    <input type="text" id="mWord" value="${esc(w.word)}" style="margin:6px 0 10px;width:100%;padding:10px;border:1px solid var(--line);border-radius:10px">
    <label class="small muted">中文翻译</label>
    <input type="text" id="mTrans" value="${esc(w.translation || '')}" style="margin:6px 0 10px;width:100%;padding:10px;border:1px solid var(--line);border-radius:10px">
    <div class="btn-row">
      <button class="btn ghost" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveWord('${id}')">保存</button>
    </div>`);
}

async function saveWord(id) {
  const w = listWords.find((x) => x.id === id) || (await getOne('words', id));
  if (!w) return;
  const word = document.getElementById('mWord').value.trim();
  const translation = document.getElementById('mTrans').value.trim();
  if (!word) { toast('单词不能为空'); return; }
  w.word = word;
  w.translation = translation;
  await putOne('words', w);
  closeModal();
  renderListDetail(currentListId);
}

function showModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = 'modalOverlay';
  ov.innerHTML = `<div class="sheet">${html}</div>`;
  ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
}

function closeModal() {
  const ov = document.getElementById('modalOverlay');
  if (ov) ov.remove();
}

/* ============================= listen view ============================= */

async function openListen(listId) {
  stopAll();
  setTopbar('循环听', () => renderListDetail(listId));
  listenWords = (await getAll('words'))
    .filter((w) => w.listId === listId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!listenWords.length) {
    toast('这个列表还没有单词');
    renderListDetail(listId);
    return;
  }
  listenGap = await getSetting('intervalSeconds', 2);
  listenRate = await getSetting('rate', 1);
  queueIds = new Set(listenWords.map((w) => w.id));
  currentWordId = listenWords[0].id;
  renderListenBody();
}

async function listenSelected() {
  if (!selectedIds.size) return;
  stopAll();
  setTopbar('循环听（所选）', () => renderListDetail(currentListId));
  listenWords = listWords.filter((w) => selectedIds.has(w.id));
  listenGap = await getSetting('intervalSeconds', 2);
  listenRate = await getSetting('rate', 1);
  queueIds = new Set(listenWords.map((w) => w.id));
  currentWordId = listenWords[0].id;
  renderListenBody();
}

function rateOptionsHtml(sel) {
  return RATES.map((r) => `<option value="${r}" ${Math.abs(r - sel) < 0.001 ? 'selected' : ''}>${r}x</option>`).join('');
}

function renderListenBody() {
  let qHtml = '';
  for (const word of listenWords) {
    qHtml += `<div class="queue-item ${word.id === currentWordId ? 'current' : ''}" data-id="${word.id}" onclick="setCurrentWord('${word.id}')">
      <input type="checkbox" class="check" ${queueIds.has(word.id) ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleQueue('${word.id}', this.checked)">
      <div class="word">${esc(word.word)}</div>
      <div class="small muted" style="max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(word.translation || '')}</div>
    </div>`;
  }
  document.getElementById('screen').innerHTML = `
    <div class="listen-current">
      <div class="listen-word" id="listenWord"></div>
      <div class="listen-trans" id="listenTrans"></div>
    </div>
    <div class="listen-controls">
      <div class="btn-row">
        <button class="btn ghost" id="btnOnce" onclick="listenOnce()">读一次</button>
        <button class="btn ghost" id="btnWord" onclick="listenWordLoop()">单词循环</button>
        <button class="btn ghost" id="btnList" onclick="listenListLoop()">多词循环</button>
        <button class="btn danger" id="btnStop" onclick="stopAll()" disabled>停止</button>
      </div>
      <div class="controls-inline">
        <label>间隔</label>
        <input type="number" id="gapInput" min="0" max="30" step="0.5" value="${listenGap}" onchange="onGapChange(this.value)">
        <label>秒</label>
        <label>速度</label>
        <select id="rateInput" onchange="onRateChange(this.value)">${rateOptionsHtml(listenRate)}</select>
      </div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="small muted" style="margin-bottom:6px">播放队列（勾选要循环的词，点词设为当前）</div>
      ${qHtml}
    </div>`;
  const w = currentListenWord();
  if (w) renderListenWord(w);
  updateLoopButtons();
}

function currentListenWord() {
  return listenWords.find((w) => w.id === currentWordId) || null;
}

function queueWords() {
  return listenWords.filter((w) => queueIds.has(w.id));
}

function renderListenWord(w) {
  if (!w) return;
  const el = document.getElementById('listenWord');
  const letters = w.word.toLowerCase().replace(/[^a-z]/g, '').split('');
  el.innerHTML = letters.map((l) => `<span class="letter">${esc(l)}</span>`).join('');
  document.getElementById('listenTrans').textContent = w.translation || '（无翻译）';
}

function setCurrentWord(id) {
  currentWordId = id;
  const w = currentListenWord();
  if (w) renderListenWord(w);
  document.querySelectorAll('.queue-item').forEach((el) => {
    el.classList.toggle('current', el.dataset.id === id);
  });
}

function toggleQueue(id, checked) {
  if (checked) queueIds.add(id); else queueIds.delete(id);
}

function listenOnce() { startLoop('once'); }
function listenWordLoop() { startLoop('word'); }
function listenListLoop() { startLoop('list'); }

function onGapChange(v) {
  listenGap = Math.max(0, Number(v) || 0);
  setSetting('intervalSeconds', listenGap);
}
function onRateChange(v) {
  listenRate = Number(v) || 1;
  setSetting('rate', listenRate);
}

/* ============================= review ============================= */

function isDue(w) {
  return !w.review || w.review.due <= Date.now();
}

function answerReview(w, correct) {
  const r = w.review || { due: Date.now(), interval: 0, reps: 0, lapses: 0 };
  if (correct) {
    r.reps = (r.reps || 0) + 1;
    r.interval = r.interval === 0 ? 1 : Math.round(r.interval * 2.5);
    r.due = Date.now() + r.interval * 86400000;
  } else {
    r.lapses = (r.lapses || 0) + 1;
    r.reps = 0;
    r.interval = 0;
    r.due = Date.now() + 5 * 60000;
  }
  w.review = r;
}

async function renderReview() {
  setTopbar('背词', null);
  const words = await getAll('words');
  const due = words.filter(isDue).length;
  const mode = reviewMode || 'flash';
  document.getElementById('screen').innerHTML = `
    <div class="review-stat">
      <div class="box"><div class="num">${due}</div><div class="lbl">今日待复习</div></div>
      <div class="box"><div class="num">${words.length}</div><div class="lbl">单词总数</div></div>
    </div>
    <div class="seg">
      <button class="${mode === 'flash' ? 'active' : ''}" onclick="setReviewMode('flash')">闪卡</button>
      <button class="${mode === 'choice' ? 'active' : ''}" onclick="setReviewMode('choice')">选择题</button>
    </div>
    <button class="btn block" onclick="startReview()" ${due ? '' : 'disabled'}>开始复习</button>
    <div class="hint" style="margin-top:14px">复习按记忆曲线安排：答对间隔逐渐拉长，答错很快再见。</div>`;
}

function setReviewMode(m) {
  if (review) return;
  reviewMode = m;
  renderReview();
}

async function startReview() {
  const words = await getAll('words');
  const due = words.filter(isDue).sort((a, b) => (a.review?.due || 0) - (b.review?.due || 0));
  if (!due.length) { toast('没有需要复习的词'); return; }
  review = { mode: reviewMode, queue: due, index: 0, flipped: false, correct: 0, wrong: 0, choices: null };
  renderReviewSession();
}

function buildChoices(w) {
  const correct = w.translation || '（无翻译）';
  const pool = [...new Set(review.queue.map((x) => x.translation).filter((t) => t && t !== correct))];
  shuffle(pool);
  const opts = [correct, ...pool.slice(0, 3)];
  shuffle(opts);
  return opts;
}

function renderReviewSession() {
  review.busy = false;
  setTopbar('复习 ' + (review.index + 1) + '/' + review.queue.length, null, '退出', () => goTab('review'));
  document.getElementById('tabbar').hidden = true;
  const w = review.queue[review.index];
  if (review.mode === 'flash') {
    const flipped = review.flipped;
    document.getElementById('screen').innerHTML = `
      <div class="flashcard" onclick="${flipped ? '' : 'flipCard()'}">
        <div class="fc-word">${esc(w.word)}</div>
        ${flipped ? `<div class="fc-trans">${esc(w.translation || '（无翻译）')}</div>` : '<div class="fc-tip">点击查看翻译</div>'}
      </div>
      ${flipped ? `<div class="btn-row" style="margin-top:14px">
          <button class="btn danger" onclick="flashAnswer(false)">不认识</button>
          <button class="btn" onclick="flashAnswer(true)">认识</button>
        </div>` : ''}`;
  } else {
    review.choices = buildChoices(w);
    document.getElementById('screen').innerHTML = `
      <div class="card" style="text-align:center;margin-bottom:14px">
        <div style="font-size:30px;font-weight:700">${esc(w.word)}</div>
        <div class="small muted" style="margin-top:6px">选择正确的中文意思</div>
      </div>
      <div id="choiceList">
        ${review.choices.map((o, i) => `<button class="choice" onclick="choiceAnswer(${i}, this)">${esc(o)}</button>`).join('')}
      </div>`;
  }
}

function flipCard() {
  review.flipped = true;
  renderReviewSession();
}

async function flashAnswer(correct) {
  if (review.busy) return;
  review.busy = true;
  const w = review.queue[review.index];
  review.correct += correct ? 1 : 0;
  review.wrong += correct ? 0 : 1;
  answerReview(w, correct);
  await putOne('words', w);
  advanceReview();
}

async function choiceAnswer(i, btn) {
  if (review.busy) return;
  review.busy = true;
  const w = review.queue[review.index];
  const opts = review.choices || [];
  const correct = opts[i] === (w.translation || '（无翻译）');
  document.querySelectorAll('#choiceList .choice').forEach((b, idx) => {
    b.disabled = true;
    if (opts[idx] === (w.translation || '（无翻译）')) b.classList.add('correct');
  });
  if (!correct) btn.classList.add('wrong');
  review.correct += correct ? 1 : 0;
  review.wrong += correct ? 0 : 1;
  answerReview(w, correct);
  await putOne('words', w);
  setTimeout(advanceReview, 1000);
}

function advanceReview() {
  if (!review) return;
  review.index++;
  if (review.index >= review.queue.length) {
    const c = review.correct;
    const wr = review.wrong;
    review = null;
    goTab('review');
    toast('完成！答对 ' + c + '，答错 ' + wr);
  } else {
    review.flipped = false;
    renderReviewSession();
  }
}

/* ============================= settings ============================= */

function voiceOptionsHtml(selectedId) {
  const voices = allVoices();
  const groups = new Map();
  for (const v of voices) {
    const lang = v.lang || 'unknown';
    if (!groups.has(lang)) groups.set(lang, []);
    groups.get(lang).push(v);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ae = /^en/i.test(a);
    const be = /^en/i.test(b);
    if (ae !== be) return ae ? -1 : 1;
    return a.localeCompare(b);
  });
  let html = `<option value="" ${selectedId ? '' : 'selected'}>自动（优先 Google 神经语音）</option>`;
  for (const key of keys) {
    html += `<optgroup label="${esc(key)}">`;
    for (const v of groups.get(key)) {
      const id = voiceIdentifier(v);
      html += `<option value="${esc(id)}" ${id === selectedId ? 'selected' : ''}>${esc(v.name || id)} (${esc(v.lang || '')})</option>`;
    }
    html += '</optgroup>';
  }
  return html;
}

function voiceStatusText() {
  const voices = allVoices();
  if (!voices.length) return '设备未列出语音 → 使用系统默认 TTS（Google 语音需在系统设置切换引擎）';
  const eff = pickVoice();
  const effName = eff ? (eff.name + ' · ' + (eff.lang || '')) : '默认英文';
  return '共 ' + voices.length + ' 个语音 · 当前：' + effName;
}

function onVoiceChange(value) {
  savedVoiceId = value || '';
  setSetting('voice', savedVoiceId);
  const st = document.getElementById('voiceStatus');
  if (st) st.textContent = voiceStatusText();
  toast(value ? '已切换声音' : '已切换为自动（优先 Google）');
}

function previewVoice() {
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音'); return; }
  speechSynthesis.cancel();
  setTimeout(() => speak('hello world', 1), 60);
}

function warmUpVoices() {
  if (!('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    u.rate = 1;
    speechSynthesis.speak(u);
    speechSynthesis.cancel();
  } catch (e) {}
}

function refreshVoices() {
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音'); return; }
  warmUpVoices();
  speechSynthesis.getVoices();
  const sel = document.getElementById('setVoice');
  const st = document.getElementById('voiceStatus');
  if (sel) sel.innerHTML = voiceOptionsHtml(savedVoiceId);
  if (st) st.textContent = voiceStatusText();
  toast('已刷新语音列表');
}

async function renderSettings() {
  setTopbar('设置', null);
  const gap = await getSetting('intervalSeconds', 2);
  const rate = await getSetting('rate', 1);
  const voiceId = await getSetting('voice', '');
  savedVoiceId = voiceId;
  document.getElementById('screen').innerHTML = `
    <div class="card">
      <div class="setting-row">
        <div><div class="lbl">朗读间隔</div><div class="sub">循环时两遍之间的停顿</div></div>
        <div><input type="number" id="setGap" min="0" max="30" step="0.5" value="${gap}"><span class="small muted"> 秒</span></div>
      </div>
      <div class="setting-row">
        <div><div class="lbl">朗读速度</div><div class="sub">0.5 慢速 ~ 1.5 快速</div></div>
        <select id="setRate">${rateOptionsHtml(rate)}</select>
      </div>
      <div class="setting-row" style="align-items:flex-start">
        <div><div class="lbl">声音选择</div><div class="sub" id="voiceStatus">${esc(voiceStatusText())}</div></div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
          <select id="setVoice" onchange="onVoiceChange(this.value)" style="width:190px;max-width:50vw">${voiceOptionsHtml(voiceId)}</select>
          <div style="display:flex;gap:6px">
            <button class="btn ghost" style="padding:8px 12px" onclick="refreshVoices()">刷新</button>
            <button class="btn ghost" style="padding:8px 12px" onclick="previewVoice()">试听</button>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="setting-row"><div><div class="lbl">导出词表</div><div class="sub">备份为 JSON 文件</div></div><button class="btn ghost" onclick="exportData()">导出</button></div>
      <div class="setting-row"><div><div class="lbl">导入词表</div><div class="sub">从备份恢复（覆盖当前数据）</div></div><button class="btn ghost" onclick="document.getElementById('importFile').click()">导入</button></div>
      <input type="file" id="importFile" accept="application/json,.json" style="display:none" onchange="importData(this)">
      <div class="setting-row"><div><div class="lbl">清空数据</div><div class="sub">删除所有词表和单词</div></div><button class="btn danger" onclick="clearData()">清空</button></div>
    </div>
    <div class="card small muted">
      使用说明：先在“词表”里建词表、加单词；点🔊进入循环听，可逐字母拼读；在“背词”里做闪卡或选择题复习。本应用可离线使用。
    </div>`;
  document.getElementById('setGap').addEventListener('change', (e) => {
    setSetting('intervalSeconds', Math.max(0, Number(e.target.value) || 0));
  });
  document.getElementById('setRate').addEventListener('change', (e) => {
    setSetting('rate', Number(e.target.value) || 1);
  });
}

async function exportData() {
  const lists = await getAll('lists');
  const words = await getAll('words');
  const settings = await getAll('settings');
  const data = { version: 1, exportedAt: new Date().toISOString(), lists, words, settings };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wordbook-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

async function importData(input) {
  const file = input.files[0];
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('导入失败：不是有效的 JSON');
    input.value = '';
    return;
  }
  input.value = '';
  if (!Array.isArray(data.lists) || !Array.isArray(data.words)) {
    toast('导入失败：文件格式不对');
    return;
  }
  if (!confirm('导入会覆盖当前所有数据，确定继续吗？')) return;
  await clearStore('lists');
  await clearStore('words');
  await clearStore('settings');
  for (const l of data.lists) await putOne('lists', l);
  for (const w of data.words) await putOne('words', w);
  for (const s of (data.settings || [])) await putOne('settings', s);
  toast('导入完成');
  renderSettings();
}

async function clearData() {
  if (!confirm('确定清空所有词表、单词和复习记录吗？此操作不可恢复。')) return;
  await clearStore('lists');
  await clearStore('words');
  await clearStore('settings');
  toast('已清空');
  renderSettings();
}

/* ============================= init ============================= */

async function init() {
  try {
    db = await openDB();
  } catch (e) {
    document.getElementById('screen').innerHTML =
      '<div class="empty">无法打开本地数据库：' + esc(e.message) + '</div>';
    return;
  }
  if ('speechSynthesis' in window) {
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => {
      if (currentTab === 'settings') renderSettings();
    };
  }
  savedVoiceId = await getSetting('voice', '');
  loadDict().catch(() => {});
  document.querySelectorAll('#tabbar button').forEach((b) => {
    b.addEventListener('click', () => goTab(b.dataset.tab));
  });
  goTab('lists');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
