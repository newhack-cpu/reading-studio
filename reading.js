'use strict';

(() => {
  const STORAGE_KEY = 'tablet-reading-state-v1';
  const GH_KEY = 'tablet-reading-github-v1';
  const AI_KEY = 'tablet-reading-ai-v1';
  const THEME_KEY = 'tablet-reading-theme-v1';

  const TIER_META = {
    L1: { name: 'L1 四级真题/基础', desc: '基础定位与常规词义' },
    L2: { name: 'L2 六级真题', desc: '高频学术词与同义替换' },
    L3: { name: 'L3 考研英一', desc: '长难句、熟词僻义与逻辑推断' },
    L4: { name: 'L4 外刊拔高', desc: 'Economist/Nature 同源压轴' },
  };
  const LETTERS = ['A', 'B', 'C', 'D'];

  // 1. Register offline PWA Service Worker when served over http/https (skipped safely in file:// standalone HTML)
  if ('serviceWorker' in navigator && /^https?:$/i.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // 2. Phone Screen Guard (Reading stays large-screen only; Listening Studio unlocks on phones)
  function isPhoneDevice() {
    const shortest = Math.min(window.screen?.width || 1024, window.screen?.height || 768);
    const mobileUA = /Android.*Mobile|iPhone|iPod|HarmonyOS.*Phone|Mobile/i.test(navigator.userAgent || '');
    return shortest < 600 || (mobileUA && window.innerWidth < 680);
  }
  const isPhone = isPhoneDevice();

  // 3. Load Offline Dictionary (7,417 words from shared deck.js)
  const deckWords = window.studyDeck?.words || [];
  const wordByKey = new Map();
  for (const w of deckWords) {
    const k = SyncModel.normWord(w.word);
    if (!wordByKey.has(k)) wordByKey.set(k, w);
  }

  // 4. Persistent State
  function loadJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || '') || fallback; }
    catch { return fallback; }
  }

  const rawState = loadJson(STORAGE_KEY, {});
  const state = {
    profile: Object.assign({ examTrack: 'cet6', examDate: '2026-12-12', updatedAt: 0 }, rawState.profile || {}),
    vocab: Object.assign({ cards: {}, days: {}, events: [], personal: [], collectedQueue: [] }, rawState.vocab || {}),
    reading: Object.assign({ attempts: [], highlights: {}, paraNotes: {}, masteredMistakes: {} }, rawState.reading || {}),
    listening: Object.assign({ attempts: [] }, rawState.listening || {}),
    customPassages: Array.isArray(rawState.customPassages) ? rawState.customPassages : [],
    lastAiReport: rawState.lastAiReport || '',
    lastAiAt: rawState.lastAiAt || 0,
  };

  const ghConfig = Object.assign({ repo: '', path: 'sync/study-state.json', token: '', lastSyncAt: 0 }, loadJson(GH_KEY, {}));
  const aiConfig = Object.assign({ key: '', model: 'deepseek-flash' }, loadJson(AI_KEY, {}));

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { toast('本地保存空间不足，请先导出备份'); }
  }
  function saveGh() { localStorage.setItem(GH_KEY, JSON.stringify(ghConfig)); }
  function saveAi() { localStorage.setItem(AI_KEY, JSON.stringify(aiConfig)); }

  // Theme
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';

  // UI Runtime State
  let view = 'library'; // library | studio | mistakes | vocab | analytics
  let libMode = 'passages'; // passages | sets
  let filterTier = 'ALL';
  let filterStatus = 'ALL';
  let libSearch = '';
  let mistakeFilter = 'ACTIVE'; // ACTIVE | WRONG | HESITANT | UNTAGGED | MASTERED | ALL
  let mistakeTier = 'ALL';
  let mistakeType = 'ALL';
  let mistakeTag = 'ALL';
  let vocabFilter = 'ALL'; // ALL | PENDING | SYNCED | WRITING
  let vocabSearch = '';
  let currentPassageId = null;
  let activeDraft = null; // single-passage draft
  let activeSet = null;   // { id, title, difficulty, passageIds, activeIndex, startedAt, timeLimitMin, drafts: {pid: {answers, marks}}, submittedIds: {pid: attemptId}, submitted: bool, totalSec: number }
  let highlightMode = false;
  let showTranslations = false;
  let showStudyPack = false;
  let examLockLookup = localStorage.getItem('reading-exam-lock-v1') === '1';
  let fontSize = 18;
  let timerHandle = null;
  let syncing = false;
  let aiBusy = false;
  let activePopWord = null;
  let editingVocabKey = null;
  let pendingSelection = null; // { phrase, sentence }
  let grammarTab = 'tense';
  const sopProgress = {}; // { [passageId]: { located, studied, collected, synced } }

  const mainEl = document.getElementById('main');
  const toastEl = document.getElementById('toast');
  const wordPop = document.getElementById('word-pop');
  const selBar = document.getElementById('sel-bar');
  const vocabModal = document.getElementById('vocab-modal');
  const grammarModal = document.getElementById('grammar-modal');
  const tourInvite = document.getElementById('tour-invite');
  const tourRoot = document.getElementById('tour-root');
  let toastTimer = null;

  function markSop(key) {
    if (!currentPassageId) return;
    sopProgress[currentPassageId] ||= {};
    sopProgress[currentPassageId][key] = true;
  }

  function hideSelBar() {
    if (selBar) selBar.hidden = true;
    pendingSelection = null;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function allPassages() {
    const builtIn = window.readingBank?.passages || [];
    const custom = Array.isArray(state.customPassages) ? state.customPassages : [];
    const map = new Map();
    for (const p of [...builtIn, ...custom]) map.set(p.id, p);
    return [...map.values()];
  }

  function passageById(id) {
    return allPassages().find(p => p.id === id);
  }

  function attemptsFor(passageId) {
    return (state.reading.attempts || []).filter(a => a.passageId === passageId);
  }

  function activeQueue() {
    return (state.vocab.collectedQueue || []).filter(x => x && !x.deleted);
  }

  function collectedSet() {
    return new Set(activeQueue().map(x => SyncModel.normWord(x.word)));
  }

  // ---- Derive Structured Exam Sets (2+ passages sharing an examSet) ----
  function buildExamSets() {
    const groups = new Map();
    for (const p of allPassages()) {
      const setName = p.examSet || (p.origin === 'official' ? `${p.year} ${p.exam}真题` : '');
      if (!setName) continue;
      if (!groups.has(setName)) {
        groups.set(setName, {
          id: `set:${setName}`,
          title: setName,
          difficulty: p.difficulty,
          exam: p.exam,
          year: p.year,
          passages: [],
        });
      }
      groups.get(setName).passages.push(p);
    }
    const sets = [...groups.values()]
      .filter(s => s.passages.length >= 2)
      .map(s => ({
        ...s,
        passageIds: s.passages.map(p => p.id),
        totalQ: s.passages.reduce((n, p) => n + p.questions.length, 0),
        timeLimitMin: s.passages.reduce((n, p) => n + (p.timeLimitMin || 15), 0),
      }));
    const tierOrder = { L2: 0, L3: 1, L1: 2, L4: 3 };
    sets.sort((a, b) => (tierOrder[a.difficulty] ?? 9) - (tierOrder[b.difficulty] ?? 9) || String(b.year).localeCompare(String(a.year)));
    return sets;
  }

  // ---- Derive Mistakes & Hesitant Questions Notebook ----
  function collectMistakeEntries() {
    // Keep latest attempt per passage so re-doing a passage reflects latest status
    const latestByPassage = new Map();
    for (const att of (state.reading.attempts || [])) {
      if (!latestByPassage.has(att.passageId)) latestByPassage.set(att.passageId, att);
    }
    const list = [];
    for (const att of latestByPassage.values()) {
      const p = passageById(att.passageId);
      if (!p) continue;
      for (const item of (att.items || [])) {
        if (item.correct && item.mark !== 'hesitant') continue;
        const q = p.questions.find(x => x.no === item.no);
        if (!q) continue;
        const key = `${p.id}:${q.no}`;
        const mastered = Boolean(state.reading.masteredMistakes?.[key]);
        list.push({
          key,
          attempt: att,
          passage: p,
          question: q,
          item,
          mastered,
          isWrong: !item.correct,
          isHesitant: item.mark === 'hesitant',
          ts: att.submittedAt || 0,
        });
      }
    }
    list.sort((a, b) => Number(a.mastered) - Number(b.mastered) || b.ts - a.ts);
    return list;
  }

  function updateBadges() {
    const dot = document.getElementById('sync-dot');
    const lbl = document.getElementById('sync-label');
    if (syncing) {
      dot.className = 'dot busy';
      lbl.textContent = '正在同步…';
    } else if (ghConfig.repo && ghConfig.token) {
      dot.className = 'dot ok';
      lbl.textContent = ghConfig.lastSyncAt ? 'GitHub 已连 · 同步' : 'GitHub 同步';
    } else {
      dot.className = 'dot';
      lbl.textContent = 'GitHub 同步';
    }
    const vBadge = document.getElementById('vocab-badge');
    if (vBadge) vBadge.textContent = String(activeQueue().length);
    const mBadge = document.getElementById('mistake-badge');
    if (mBadge) {
      const activeMistakes = collectMistakeEntries().filter(x => !x.mastered).length;
      mBadge.textContent = String(activeMistakes);
    }
    const track = SyncModel.EXAM_TRACKS[state.profile.examTrack] || SyncModel.EXAM_TRACKS.cet6;
    const dl = SyncModel.daysUntil(state.profile.examDate);
    const offlineHint = location.protocol === 'file:' ? '离网单文件模式' : '在线 / PWA 缓存';
    document.getElementById('top-sub').textContent = `${track.label}${dl != null ? ` · 距考 ${dl} 天` : ''} · 题库 ${allPassages().length} 篇 · ${offlineHint}`;
  }

  // ---- UTF-8 safe Base64 for GitHub Contents API ----
  function toBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(bin);
  }

  function fromBase64Utf8(b64) {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function normalizeRepo(raw) {
    return String(raw || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  }

  async function syncWithGitHub(retry = false) {
    if (syncing) return;
    const repo = normalizeRepo(ghConfig.repo);
    const path = (ghConfig.path || 'sync/study-state.json').trim().replace(/^\/+|\/+$/g, '');
    const token = (ghConfig.token || '').trim();
    if (!repo || !token) {
      setView('analytics');
      toast('请先在下方填写 GitHub 私有仓库名与 Fine-grained PAT');
      return;
    }
    syncing = true;
    updateBadges();
    try {
      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const getRes = await fetch(url, { headers, cache: 'no-store' });
      let remote = {};
      let sha = '';
      if (getRes.status === 200) {
        const meta = await getRes.json();
        sha = meta.sha || '';
        if (meta.content) remote = JSON.parse(fromBase64Utf8(meta.content));
      } else if (getRes.status !== 404) {
        throw new Error(`拉取失败（HTTP ${getRes.status}），请检查仓库名和 Token 权限`);
      }

      const localBundle = {
        syncVersion: 1,
        updatedAt: Date.now(),
        devices: { 'tablet-huawei': Date.now() },
        profile: state.profile,
        vocab: state.vocab,
        reading: state.reading,
        listening: state.listening,
      };
      const merged = SyncModel.mergeBundles(localBundle, remote);
      state.profile = merged.profile;
      state.vocab = merged.vocab;
      state.reading = Object.assign({ attempts: [], highlights: {}, paraNotes: {}, masteredMistakes: {} }, merged.reading);
      state.listening = Object.assign({ attempts: [] }, merged.listening);
      saveState();

      const putBody = {
        message: 'sync from Huawei tablet reading studio',
        content: toBase64Utf8(JSON.stringify(merged)),
      };
      if (sha) putBody.sha = sha;
      const putRes = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(putBody),
      });
      if (putRes.status === 409 && !retry) {
        syncing = false;
        return syncWithGitHub(true);
      }
      if (!putRes.ok) throw new Error(`上传失败（HTTP ${putRes.status}），请确认 Token 具备 Contents 读写权限`);
      ghConfig.repo = repo;
      ghConfig.path = path;
      ghConfig.lastSyncAt = Date.now();
      saveGh();
      const cardCount = Object.keys(state.vocab.cards || {}).length;
      toast(`GitHub 双向同步成功 · 词卡 ${cardCount} 条 · 阅读 ${state.reading.attempts.length} 篇 · 听力 ${state.listening.attempts.length} 段`);
    } catch (err) {
      toast(err.message || 'GitHub 同步失败，请检查网络');
    } finally {
      syncing = false;
      updateBadges();
      render();
    }
  }

  // ---- Word Lookup & Speech ----
  function splitGloss(g) {
    const m = /^([a-zA-Z./&\s]{1,14}\.)\s*(.*)$/.exec(String(g || '').trim());
    return m ? { pos: m[1], text: m[2] } : { pos: '', text: String(g || '') };
  }

  function lookupToken(rawWord) {
    const clean = rawWord.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (!clean || clean.length < 2) return null;
    const key = SyncModel.normWord(clean);
    if (wordByKey.has(key)) return { entry: wordByKey.get(key), lemmaNote: '' };
    if (typeof WordLookup !== 'undefined') {
      const formHits = WordLookup.forms(key, wordByKey, splitGloss);
      if (formHits.length) {
        const hit = formHits[0];
        return { entry: hit, lemmaNote: `词形还原：${clean} → ${hit.word}` };
      }
      const nearHits = WordLookup.suggestions(key, wordByKey);
      if (nearHits.length) {
        const hit = nearHits[0];
        return { entry: hit, lemmaNote: `相近词条：${clean} ≈ ${hit.word}` };
      }
    }
    return { entry: { id: `w:${key}`, word: clean, ipa: ['', ''], customOnly: true }, lemmaNote: '未在内置词库命中，仍可直接加入生词队列' };
  }

  function speakWord(text, lang) {
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音合成'); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    speechSynthesis.speak(u);
  }

  function openWordPop(rawWord, sentence) {
    const res = lookupToken(rawWord);
    if (!res) return;
    const { entry, lemmaNote } = res;
    activePopWord = { entry, sentence };
    document.getElementById('pop-word').textContent = entry.word;
    const ipaParts = [];
    if (entry.ipa?.[0]) ipaParts.push(`英 /${entry.ipa[0]}/`);
    if (entry.ipa?.[1]) ipaParts.push(`美 /${entry.ipa[1]}/`);
    document.getElementById('pop-ipa').textContent = ipaParts.join('   ') || '点右侧按钮试听发音';
    const lemmaEl = document.getElementById('pop-lemma');
    lemmaEl.hidden = !lemmaNote;
    lemmaEl.textContent = lemmaNote;

    const body = [];
    const glosses = [
      ...(entry.cetGlosses || []).slice(0, 3).map(g => ({ src: '六级', g })),
      ...(entry.glosses || []).slice(0, 4).map(g => ({ src: '考研', g })),
      ...(entry.cet4Glosses || []).slice(0, 3).map(g => ({ src: '四级', g })),
    ];
    if (glosses.length) {
      const seen = new Set();
      for (const row of glosses) {
        if (seen.has(row.g)) continue;
        seen.add(row.g);
        body.push(`<div class="pop-gloss"><span class="origin-badge">${row.src}</span> ${esc(row.g)}</div>`);
        if (seen.size >= 4) break;
      }
    } else if (entry.examples?.length) {
      for (const ex of entry.examples.slice(0, 3)) body.push(`<div class="pop-gloss">${esc(ex.meaning)}</div>`);
    } else {
      body.push('<div class="pop-gloss">词库暂无释义，加入队列后可在「生词队列」页补充释义。</div>');
    }

    const exList = (entry.examples || []).filter(e => e.en).slice(0, 1).concat((entry.aiExamples || []).slice(0, 1));
    for (const ex of exList.slice(0, 1)) {
      body.push(`<div class="pop-ex">${esc(ex.en)}<small>${esc(ex.zh || '')}</small></div>`);
    }

    const card = state.vocab.cards?.[String(entry.id)];
    if (card) {
      const statusTxt = card.phase === 'known' ? '手机端曾标为熟词跳过'
        : card.lapses > 0 ? `手机端已学（忘过 ${card.lapses} 次）`
        : card.phase === 'queued' ? '已在手机待补学队列' : `手机端复习中（间隔 ${card.ivl || 1} 天）`;
      body.push(`<div style="font-size:12px;color:var(--green)">手机背词状态：${statusTxt}</div>`);
    }
    document.getElementById('pop-body').innerHTML = body.join('');

    const isCollected = collectedSet().has(SyncModel.normWord(entry.word));
    document.getElementById('pop-collect').textContent = isCollected ? '✓ 已在队列（再点移出）' : '+ 加入生词队列';
    wordPop.hidden = false;
  }

  function addWordRecord(word, gloss, sentence = '', writingTag = false) {
    const key = SyncModel.normWord(word);
    const matched = wordByKey.get(key);
    const queue = state.vocab.collectedQueue ||= [];
    const idx = queue.findIndex(x => SyncModel.normWord(x.word) === key);
    const now = Date.now();
    const record = {
      word: matched ? matched.word : word,
      id: matched ? String(matched.id) : `w:${key}`,
      gloss: gloss || matched?.glosses?.[0] || matched?.cetGlosses?.[0] || matched?.cet4Glosses?.[0] || '阅读生词',
      passageId: currentPassageId || '',
      sentence: (sentence || '').slice(0, 220),
      writingTag: Boolean(writingTag || (!queue[idx]?.deleted && queue[idx]?.writingTag)),
      collectedAt: now,
      updatedAt: now,
      consumedOnPhone: false,
      deleted: false,
    };
    if (idx >= 0) queue[idx] = { ...queue[idx], ...record };
    else queue.unshift(record);
    saveState();
    updateBadges();
    return record;
  }

  function collectWord(writingTag = false) {
    if (!activePopWord) return;
    const { entry, sentence } = activePopWord;
    const firstGloss = entry.glosses?.[0] || entry.cetGlosses?.[0] || entry.cet4Glosses?.[0] || entry.examples?.[0]?.meaning || '阅读生词';
    const key = SyncModel.normWord(entry.word);
    const queue = state.vocab.collectedQueue ||= [];
    const idx = queue.findIndex(x => SyncModel.normWord(x.word) === key);
    const now = Date.now();

    if (!writingTag && idx >= 0 && !queue[idx].deleted) {
      queue[idx].deleted = true;
      queue[idx].consumedOnPhone = true;
      queue[idx].updatedAt = now;
      saveState();
      updateBadges();
      toast(`已将「${entry.word}」移出生词队列`);
      document.getElementById('pop-collect').textContent = '+ 加入生词队列';
      if (view === 'studio') {
        document.querySelectorAll('.tok[data-tok]').forEach(el => {
          if (SyncModel.normWord(el.dataset.tok) === key) el.classList.remove('collected');
        });
        const cntBtn = document.querySelector('[data-view-jump="vocab"]');
        if (cntBtn) cntBtn.textContent = `管理生词 (${activeQueue().length})`;
      } else if (view === 'listening') {
        document.querySelectorAll('.tok[data-ltok]').forEach(el => {
          if (SyncModel.normWord(el.dataset.ltok) === key) el.classList.remove('collected');
        });
      }
      return;
    }

    addWordRecord(entry.word, firstGloss, sentence, writingTag);
    toast(writingTag ? `已将「${entry.word}」标为写作语料并加入生词队列` : `已加入「${entry.word}」到生词队列`);
    document.getElementById('pop-collect').textContent = '✓ 已在队列（再点移出）';
    if (view === 'studio') {
      document.querySelectorAll('.tok[data-tok]').forEach(el => {
        if (SyncModel.normWord(el.dataset.tok) === key) el.classList.add('collected');
      });
      const cntBtn = document.querySelector('[data-view-jump="vocab"]');
      if (cntBtn) cntBtn.textContent = `管理生词 (${activeQueue().length})`;
    } else if (view === 'listening') {
      document.querySelectorAll('.tok[data-ltok]').forEach(el => {
        if (SyncModel.normWord(el.dataset.ltok) === key) el.classList.add('collected');
      });
    }
  }

  // ---- Vocab Queue Modal (Add / Edit / Pre-filled Selected Phrase) ----
  function openVocabModal(editKey = null, prefill = null) {
    editingVocabKey = editKey;
    const existing = editKey ? activeQueue().find(x => SyncModel.normWord(x.word) === editKey) : null;
    document.getElementById('vm-title').textContent = existing
      ? `编辑生词：${existing.word}`
      : (prefill ? '收藏划选短语 / 记笔记' : '手动添加生词 / 写作短句');
    const wInput = document.getElementById('vm-word');
    wInput.value = existing ? existing.word : (prefill?.word || '');
    wInput.readOnly = Boolean(existing);
    document.getElementById('vm-gloss').value = existing ? (existing.gloss || '') : (prefill?.gloss || '');
    document.getElementById('vm-sentence').value = existing ? (existing.sentence || '') : (prefill?.sentence || '');
    document.getElementById('vm-writing').checked = Boolean(existing ? existing.writingTag : prefill?.writingTag);
    vocabModal.showModal();
    if (prefill) requestAnimationFrame(() => document.getElementById('vm-gloss').focus());
  }

  function saveVocabModal() {
    const word = document.getElementById('vm-word').value.trim();
    const gloss = document.getElementById('vm-gloss').value.trim();
    const sentence = document.getElementById('vm-sentence').value.trim();
    const writingTag = document.getElementById('vm-writing').checked;
    if (!word) { toast('请填写英文单词或短句'); return; }
    const key = SyncModel.normWord(word);
    const queue = state.vocab.collectedQueue ||= [];
    const matched = wordByKey.get(key);
    const idx = queue.findIndex(x => SyncModel.normWord(x.word) === (editingVocabKey || key));
    const now = Date.now();
    const wasActive = idx >= 0 && !queue[idx].deleted;
    const entry = {
      word,
      id: matched ? String(matched.id) : `w:${key}`,
      gloss: gloss || matched?.glosses?.[0] || matched?.cetGlosses?.[0] || matched?.cet4Glosses?.[0] || '短语 / 自定义笔记',
      passageId: wasActive ? (queue[idx].passageId || '') : (currentPassageId || '手动添加'),
      sentence,
      writingTag,
      collectedAt: wasActive ? (queue[idx].collectedAt || now) : now,
      updatedAt: now,
      consumedOnPhone: wasActive ? Boolean(queue[idx].consumedOnPhone) : false,
      deleted: false,
    };
    if (idx >= 0) queue[idx] = { ...queue[idx], ...entry };
    else queue.unshift(entry);
    markSop('collected');
    saveState();
    vocabModal.close();
    toast(wasActive ? `已更新「${word}」` : `已添加「${word}」到生词队列`);
    if (view === 'studio') renderKeepStudioScroll();
    else render();
  }

  // ---- Passage & Exam Set Workflow ----
  function tokenizeParagraph(text, collected) {
    return text.replace(/([A-Za-z]{2,}(?:[-'’][A-Za-z]+)*)/g, match => {
      const cls = collected.has(SyncModel.normWord(match)) ? 'tok collected' : 'tok';
      return `<span class="${cls}" data-tok="${esc(match)}">${esc(match)}</span>`;
    });
  }

  function startPassage(id, locatePara = null) {
    const p = passageById(id);
    if (!p) return;
    activeSet = null; // Leave exam set mode when opening standalone passage
    currentPassageId = id;
    showTranslations = false;
    showStudyPack = false;
    const prev = attemptsFor(id)[0];
    if (prev) {
      activeDraft = {
        passageId: id,
        startedAt: Date.now(),
        answers: Object.fromEntries(prev.items.map(x => [x.no, x.chosen])),
        marks: Object.fromEntries(prev.items.map(x => [x.no, x.mark || ''])),
        submittedAttemptId: prev.id,
      };
    } else {
      activeDraft = { passageId: id, startedAt: Date.now(), answers: {}, marks: {}, submittedAttemptId: null };
    }
    setView('studio');
    if (locatePara) {
      requestAnimationFrame(() => highlightEvidencePara(locatePara));
    }
  }

  function startExamSet(setTitle, passageIds, difficulty) {
    const validIds = passageIds.filter(id => passageById(id));
    if (!validIds.length) { toast('该套卷暂无可用篇目'); return; }
    const timeLimitMin = validIds.reduce((n, id) => n + (passageById(id)?.timeLimitMin || 15), 0);
    const drafts = {};
    for (const id of validIds) drafts[id] = { answers: {}, marks: {} };
    activeSet = {
      id: `mock:${Date.now().toString(36)}`,
      title: setTitle,
      difficulty,
      passageIds: validIds,
      activeIndex: 0,
      startedAt: Date.now(),
      timeLimitMin,
      drafts,
      submittedIds: {},
      submitted: false,
      totalSec: 0,
    };
    currentPassageId = validIds[0];
    showTranslations = false;
    showStudyPack = false;
    setView('studio');
    toast(`已进入套卷模考：${setTitle}（共 ${validIds.length} 篇，限时 ${timeLimitMin} 分钟）`);
  }

  function startRandomMock(tier, count, title) {
    const pool = allPassages().filter(p => p.difficulty === tier);
    const todo = pool.filter(p => !attemptsFor(p.id).length);
    const done = pool.filter(p => attemptsFor(p.id).length);
    const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
    const picked = [...shuffle(todo), ...shuffle(done)].slice(0, count);
    if (picked.length < 2) { toast('当前难度题数不足以组套'); return; }
    startExamSet(title, picked.map(p => p.id), tier);
  }

  function restartPassage(id) {
    if (activeSet) {
      startExamSet(activeSet.title, activeSet.passageIds, activeSet.difficulty);
      return;
    }
    currentPassageId = id;
    activeDraft = { passageId: id, startedAt: Date.now(), answers: {}, marks: {}, submittedAttemptId: null };
    showTranslations = false;
    showStudyPack = false;
    wordPop.hidden = true;
    render();
    toast('已开启新一轮计时作答');
  }

  function activeDraftForCurrent() {
    if (activeSet) {
      const pid = activeSet.passageIds[activeSet.activeIndex];
      return activeSet.drafts[pid];
    }
    return activeDraft;
  }

  function currentAttempt() {
    if (activeSet) {
      if (!activeSet.submitted) return null;
      const pid = activeSet.passageIds[activeSet.activeIndex];
      const attId = activeSet.submittedIds[pid];
      return state.reading.attempts.find(a => a.id === attId) || null;
    }
    if (!activeDraft?.submittedAttemptId) return null;
    return state.reading.attempts.find(a => a.id === activeDraft.submittedAttemptId) || null;
  }

  function gradePassage(p, draft, durationSec, extra = {}) {
    const now = Date.now();
    const items = p.questions.map(q => {
      const chosen = draft.answers[q.no];
      const correct = chosen === q.answer;
      return {
        no: q.no,
        type: q.type,
        chosen: chosen === undefined ? -1 : chosen,
        answer: q.answer,
        correct,
        mark: draft.marks[q.no] || '',
        errorTags: [],
        note: '',
      };
    });
    const score = items.filter(x => x.correct).length;
    return {
      id: `read:${p.id}:${now.toString(36)}:${Math.random().toString(36).slice(2, 5)}`,
      passageId: p.id,
      title: p.title,
      difficulty: p.difficulty,
      exam: p.exam,
      submittedAt: now,
      updatedAt: now,
      durationSec,
      score,
      total: items.length,
      items,
      ...extra,
    };
  }

  function submitCurrentPassage() {
    if (activeSet) return submitActiveSet();
    const p = passageById(currentPassageId);
    if (!p || !activeDraft) return;
    const unanswered = p.questions.filter(q => activeDraft.answers[q.no] === undefined);
    if (unanswered.length && !confirm(`还有 ${unanswered.length} 题未作答，确定现在交卷吗？`)) return;
    const durationSec = Math.max(10, Math.round((Date.now() - activeDraft.startedAt) / 1000));
    const attempt = gradePassage(p, activeDraft, durationSec);
    state.reading.attempts.unshift(attempt);
    activeDraft.submittedAttemptId = attempt.id;
    saveState();
    wordPop.hidden = true;
    toast(`已交卷：${attempt.score} / ${attempt.total}（已解锁逐段译文与精读卡）`);
    render();
  }

  function submitActiveSet() {
    if (!activeSet || activeSet.submitted) return;
    let unanswered = 0;
    for (const pid of activeSet.passageIds) {
      const p = passageById(pid);
      const d = activeSet.drafts[pid];
      for (const q of p.questions) if (d.answers[q.no] === undefined) unanswered++;
    }
    if (unanswered && !confirm(`整套试卷还有 ${unanswered} 题未作答，确定整套交卷吗？`)) return;
    const totalSec = Math.max(15, Math.round((Date.now() - activeSet.startedAt) / 1000));
    const perSec = Math.max(10, Math.round(totalSec / activeSet.passageIds.length));
    let totalScore = 0;
    let totalQ = 0;
    for (const pid of activeSet.passageIds) {
      const p = passageById(pid);
      const att = gradePassage(p, activeSet.drafts[pid], perSec, { examSetId: activeSet.id, examSetTitle: activeSet.title });
      state.reading.attempts.unshift(att);
      activeSet.submittedIds[pid] = att.id;
      totalScore += att.score;
      totalQ += att.total;
    }
    activeSet.submitted = true;
    activeSet.totalSec = totalSec;
    saveState();
    wordPop.hidden = true;
    toast(`套卷交卷完成：${totalScore} / ${totalQ}（用时 ${Math.max(1, Math.round(totalSec / 60))} 分钟，逐段译文与精读卡已解锁）`);
    render();
  }

  function highlightEvidencePara(paraNo) {
    document.querySelectorAll('.para.evidence-hit').forEach(el => el.classList.remove('evidence-hit'));
    const target = document.getElementById(`para-${paraNo}`);
    if (target) {
      target.classList.add('evidence-hit');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function startTimerTick() {
    clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      const el = document.getElementById('live-timer');
      if (!el) return;
      if (activeSet) {
        if (activeSet.submitted) return;
        const elapsed = Math.max(0, Math.floor((Date.now() - activeSet.startedAt) / 1000));
        const limitSec = activeSet.timeLimitMin * 60;
        const remain = limitSec - elapsed;
        if (remain >= 0) {
          el.textContent = `剩 ${String(Math.floor(remain / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;
          el.className = remain <= 300 ? 'timer-box warn' : 'timer-box';
        } else {
          const ov = -remain;
          el.textContent = `超时 +${String(Math.floor(ov / 60)).padStart(2, '0')}:${String(ov % 60).padStart(2, '0')}`;
          el.className = 'timer-box over';
        }
        return;
      }
      if (!activeDraft || activeDraft.submittedAttemptId) return;
      const sec = Math.max(0, Math.floor((Date.now() - activeDraft.startedAt) / 1000));
      el.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    }, 1000);
  }

  function renderKeepStudioScroll() {
    const leftScroll = mainEl.querySelector('.article-scroll')?.scrollTop || 0;
    const rightScroll = mainEl.querySelector('.questions-scroll')?.scrollTop || 0;
    render();
    const l2 = mainEl.querySelector('.article-scroll');
    const r2 = mainEl.querySelector('.questions-scroll');
    if (l2) l2.scrollTop = leftScroll;
    if (r2) r2.scrollTop = rightScroll;
  }

  // ---- VIEW 1: LIBRARY (Single Passages + Exam Set Mock Mode) ----
  function renderLibraryCards() {
    const passages = allPassages();
    const qLow = libSearch.trim().toLowerCase();
    const filtered = passages.filter(p => {
      if (filterTier !== 'ALL' && p.difficulty !== filterTier) return false;
      const atts = attemptsFor(p.id);
      if (filterStatus === 'TODO' && atts.length) return false;
      if (filterStatus === 'DONE' && !atts.length) return false;
      if (filterStatus === 'WRONG' && (!atts.length || atts[0].score === atts[0].total)) return false;
      if (qLow) {
        const hay = `${p.title} ${p.subtitle || ''} ${p.sourceLabel || ''} ${p.year || ''} ${p.exam || ''}`.toLowerCase();
        if (!hay.includes(qLow)) return false;
      }
      return true;
    });

    if (!filtered.length) return '<div class="ana-card" style="grid-column:1/-1;text-align:center;color:var(--muted)">当前筛选条件下没有文章，可切换筛选词或清空搜索。</div>';

    return filtered.map(p => {
      const latest = attemptsFor(p.id)[0];
      const scoreHtml = latest
        ? `<span class="score-pill ${latest.score < latest.total * 0.6 ? 'warn' : ''}">上次 ${latest.score}/${latest.total} · ${Math.max(1, Math.round(latest.durationSec / 60))}m</span>`
        : '<span>未做</span>';
      return `<button type="button" class="passage-card" data-open-passage="${esc(p.id)}">
        <div class="p-card-top">
          <span class="tier tier-${p.difficulty}">${TIER_META[p.difficulty]?.name || p.difficulty}</span>
          <span class="origin-badge ${p.origin === 'official' ? 'official' : ''}">${p.origin === 'official' ? '官方真题' : '分级精编'}</span>
          <span class="origin-badge">${esc(p.year)}</span>
          ${p.translations?.length ? '<span class="origin-badge">含译文+精读卡</span>' : ''}
        </div>
        <div class="p-card-title">${esc(p.title)}</div>
        <div class="p-card-sub">${esc(p.sourceLabel || '')}${p.subtitle ? ` · ${esc(p.subtitle)}` : ''}</div>
        <div class="p-card-meta">
          <span>约 ${p.wordCount || 360} 词 · ${p.questions.length} 题 · 建议 ${p.timeLimitMin}m</span>
          ${scoreHtml}
        </div>
      </button>`;
    }).join('');
  }

  function renderExamSetsGrid() {
    const sets = buildExamSets().filter(s => filterTier === 'ALL' || s.difficulty === filterTier);
    const randomHtml = `<div class="section-label">🎲 随机抽题模考（优先抽取未做篇目）</div>
      <div class="passage-grid">
        <button type="button" class="passage-card set-card" data-random-mock="L2:2:六级随机 2 篇模考">
          <div class="p-card-top"><span class="tier tier-L2">六级 CET-6</span><span class="origin-badge official">考前必练</span></div>
          <div class="p-card-title">随机组卷 · 六级 Section C（2 篇 10 题）</div>
          <div class="p-card-sub">严格按真实六级仔细阅读双篇节奏，倒计时 30 分钟一次交卷</div>
          <div class="p-card-meta"><span>限时 30 分钟</span><span class="score-pill">立即开考 →</span></div>
        </button>
        <button type="button" class="passage-card set-card" data-random-mock="L3:4:考研英语一随机 4 篇模考">
          <div class="p-card-top"><span class="tier tier-L3">考研英语一</span><span class="origin-badge official">Part A 全真</span></div>
          <div class="p-card-title">随机组卷 · 考研英一 Text 1–4（4 篇 20 题）</div>
          <div class="p-card-sub">完整 4 篇连刷（折算 40 分），限时 72 分钟训练耐力与配速</div>
          <div class="p-card-meta"><span>限时 72 分钟</span><span class="score-pill">立即开考 →</span></div>
        </button>
        <button type="button" class="passage-card set-card" data-random-mock="L1:2:四级随机 2 篇热身">
          <div class="p-card-top"><span class="tier tier-L1">四级 CET-4</span><span class="origin-badge">提速热身</span></div>
          <div class="p-card-title">随机组卷 · 四级阅读双篇（2 篇 10 题）</div>
          <div class="p-card-sub">适合碎片时间快速找手感，限时 24 分钟</div>
          <div class="p-card-meta"><span>限时 24 分钟</span><span class="score-pill">立即开考 →</span></div>
        </button>
      </div>`;

    const setCards = sets.map(s => {
      const doneCnt = s.passageIds.filter(id => attemptsFor(id).length).length;
      const latestSum = doneCnt === s.passageIds.length
        ? s.passageIds.reduce((acc, id) => acc + (attemptsFor(id)[0]?.score || 0), 0)
        : null;
      return `<button type="button" class="passage-card" data-open-set="${esc(s.title)}">
        <div class="p-card-top">
          <span class="tier tier-${s.difficulty}">${TIER_META[s.difficulty]?.name || s.difficulty}</span>
          <span class="origin-badge official">完整原卷</span>
          <span class="origin-badge">${s.passageIds.length} 篇 · ${s.totalQ} 题</span>
        </div>
        <div class="p-card-title">${esc(s.title)}</div>
        <div class="p-card-sub">${s.passages.map((p, i) => `P${i + 1}: ${esc(p.title)}`).join(' ｜ ')}</div>
        <div class="p-card-meta">
          <span>统一倒计时 ${s.timeLimitMin} 分钟</span>
          <span class="score-pill">${latestSum != null ? `上次合计 ${latestSum}/${s.totalQ}` : `已做 ${doneCnt}/${s.passageIds.length} 篇`}</span>
        </div>
      </button>`;
    }).join('');

    return `${randomHtml}
      <div class="section-label">📚 历年完整真题套卷（共 ${sets.length} 套 · 2024–2027 考研真题严格锁存留作冲刺）</div>
      <div class="passage-grid">${setCards}</div>`;
  }

  function renderLibrary() {
    const passages = allPassages();
    const sets = buildExamSets();
    const tierCounts = { ALL: passages.length, L1: 0, L2: 0, L3: 0, L4: 0 };
    for (const p of passages) if (tierCounts[p.difficulty] !== undefined) tierCounts[p.difficulty]++;
    const doneCount = new Set(state.reading.attempts.map(a => a.passageId)).size;
    const track = SyncModel.EXAM_TRACKS[state.profile.examTrack] || SyncModel.EXAM_TRACKS.cet6;

    return `<div class="scroll-view">
      <section class="lib-hero">
        <div>
          <h2>分级阅读真题库（${passages.length} 篇 · ${passages.reduce((s, p) => s + p.questions.length, 0)} 题 · ${sets.length} 套完整原卷）</h2>
          <p>当前档位：<strong>${esc(track.label)}</strong> · 已精读 ${doneCount} / ${passages.length} 篇 · 交卷解锁逐段译文与长难句/同义替换精读卡</p>
        </div>
        <div class="btn-row" style="margin:0;align-items:center">
          <div class="mode-seg" data-tour="mode">
            <button type="button" class="${libMode === 'passages' ? 'on' : ''}" data-lib-mode="passages">单篇精读 (${passages.length})</button>
            <button type="button" class="${libMode === 'sets' ? 'on' : ''}" data-lib-mode="sets">套卷模考 (${sets.length}套)</button>
          </div>
          <button type="button" class="ghost-sm" id="btn-import-pack">+ 导入 JSON 题包</button>
          ${currentPassageId ? `<button type="button" class="solid-sm" data-view-jump="studio">继续精读</button>` : ''}
        </div>
      </section>

      <div class="lib-controls">
        <div class="chip-group">
          ${['ALL', 'L1', 'L2', 'L3', 'L4'].map(t => `<button type="button" class="filter-chip ${filterTier === t ? 'active' : ''}" data-filter-tier="${t}">${t === 'ALL' ? '全部难度' : TIER_META[t].name} (${tierCounts[t]})</button>`).join('')}
        </div>
        ${libMode === 'passages' ? `<div class="chip-group">
          ${[['ALL', '全部'], ['TODO', '未做'], ['DONE', '已做'], ['WRONG', '含错题']].map(([k, lbl]) => `<button type="button" class="filter-chip ${filterStatus === k ? 'active' : ''}" data-filter-status="${k}">${lbl}</button>`).join('')}
          <input type="search" id="lib-search" class="search-input" value="${esc(libSearch)}" placeholder="搜年份、主题或关键词…">
        </div>` : ''}
      </div>

      ${libMode === 'sets' ? renderExamSetsGrid() : `<div id="lib-grid" class="passage-grid">${renderLibraryCards()}</div>`}
    </div>`;
  }

  // ---- VIEW 2: SPLIT READING STUDIO (Single + Exam Set + Translations + StudyPack + Para Notes) ----
  function renderStudyPackHtml(p, collected) {
    const sp = p.studyPack;
    if (!sp) return '<div class="study-pack-box"><p style="font-size:13px;color:var(--muted)">本篇暂无扩展精读卡。</p></div>';

    const lsHtml = (sp.longSentences || []).map((s, idx) => `
      <div class="sp-ls-item">
        <div class="sp-ls-en"><strong>长难句 ${idx + 1}：</strong>${esc(s.en)}</div>
        <div class="sp-ls-struct"><strong>主干拆解：</strong>${esc(s.structure)}</div>
        <div class="sp-ls-zh"><strong>精准译文：</strong>${esc(s.zh)}</div>
        <div class="sp-ls-pt">考点：${esc(s.point)}</div>
      </div>`).join('');

    const paraHtml = (sp.paraphrases || []).map(row => `
      <div class="sp-para-row">
        <code>${esc(row.original)}</code>
        <span class="arrow">→</span>
        <code>${esc(row.option)}</code>
        ${row.note ? `<div class="sp-para-note">${esc(row.note)}</div>` : ''}
      </div>`).join('');

    const vocabHtml = (sp.keyVocab || []).map(v => {
      const k = SyncModel.normWord(v.word);
      const added = collected.has(k);
      return `<div class="sp-vocab-card">
        <div class="sp-vocab-head">
          <b lang="en">${esc(v.word)}</b>
          <button type="button" class="${added ? 'ok-sm' : 'ghost-sm'}" data-sp-add-word="${esc(v.word)}" data-sp-add-gloss="${esc(v.gloss)}">${added ? '✓ 已收词' : '+ 收词'}</button>
        </div>
        <div class="sp-vocab-gloss">${esc(v.gloss)}</div>
        ${v.note ? `<div class="sp-vocab-note">${esc(v.note)}</div>` : ''}
      </div>`;
    }).join('');

    return `<section class="study-pack-box">
      ${lsHtml ? `<div class="sp-sec"><h4>🔍 核心长难句拆解</h4>${lsHtml}</div>` : ''}
      ${paraHtml ? `<div class="sp-sec"><h4>🔁 真题高频同义替换表</h4><div class="sp-para-grid">${paraHtml}</div></div>` : ''}
      ${vocabHtml ? `<div class="sp-sec"><h4>📌 核心词 / 熟词僻义（可一键入队列同步手机）</h4><div class="sp-vocab-grid">${vocabHtml}</div></div>` : ''}
    </section>`;
  }

  function renderSetRibbon() {
    if (!activeSet) return '';
    let totalAns = 0;
    let totalQ = 0;
    const tabsHtml = activeSet.passageIds.map((pid, idx) => {
      const p = passageById(pid);
      const d = activeSet.drafts[pid];
      const cnt = Object.keys(d.answers).length;
      const tot = p.questions.length;
      totalAns += cnt;
      totalQ += tot;
      let statusTxt = `${cnt}/${tot}`;
      if (activeSet.submitted) {
        const att = state.reading.attempts.find(a => a.id === activeSet.submittedIds[pid]);
        statusTxt = att ? `${att.score}/${att.total}分` : statusTxt;
      }
      return `<button type="button" class="set-tab ${idx === activeSet.activeIndex ? 'on' : ''} ${cnt === tot ? 'done' : ''}" data-set-idx="${idx}">P${idx + 1} · ${statusTxt}</button>`;
    }).join('');

    let scorecardHtml = '';
    if (activeSet.submitted) {
      let sc = 0;
      const details = activeSet.passageIds.map((pid, i) => {
        const att = state.reading.attempts.find(a => a.id === activeSet.submittedIds[pid]);
        sc += att?.score || 0;
        return `P${i + 1}: ${att?.score || 0}/${att?.total || 5}`;
      }).join(' ｜ ');
      const pct = totalQ ? Math.round((sc / totalQ) * 100) : 0;
      const scaled = activeSet.difficulty === 'L3' ? `折算考研阅读 ${sc * 2} / ${totalQ * 2} 分`
        : activeSet.difficulty === 'L2' || activeSet.difficulty === 'L1' ? `折算仔细阅读 ${Math.round(sc * 14.2)} / ${Math.round(totalQ * 14.2)} 分`
        : '';
      scorecardHtml = `<div class="set-scorecard">
        <div><strong>套卷成绩：${sc} / ${totalQ}（正确率 ${pct}%）</strong>${scaled ? ` · ${scaled}` : ''} · 总用时 ${Math.max(1, Math.round(activeSet.totalSec / 60))} 分钟</div>
        <div style="color:var(--muted)">${details}</div>
      </div>`;
    }

    return `<div class="set-ribbon">
      <div class="set-ribbon-left">
        <span class="set-ribbon-title">📝 套卷模考：${esc(activeSet.title)}</span>
        <div class="set-tabs">${tabsHtml}</div>
      </div>
      <div class="pane-bar-group">
        ${!activeSet.submitted
          ? `<span style="font-size:12.5px;color:var(--muted)">已答 ${totalAns}/${totalQ}</span>
             <button type="button" class="solid-sm" id="btn-submit-set">整套交卷核对</button>`
          : `<button type="button" class="ghost-sm" id="btn-restart-set">重刷本套卷</button>
             <button type="button" class="ghost-sm" id="btn-exit-set">退出套卷模式</button>`}
      </div>
      ${scorecardHtml}
    </div>`;
  }

  function renderSopBar(p, attempt) {
    const prog = sopProgress[p.id] || {};
    const step1Done = Boolean(attempt);
    const step2Done = Boolean(prog.located || (attempt && attempt.items.some(x => (x.errorTags || []).length)));
    const step3Done = Boolean(prog.studied || showTranslations || showStudyPack);
    const step4Done = Boolean(prog.collected || activeQueue().some(x => x.passageId === p.id));
    const step5Done = Boolean(prog.synced || (ghConfig.lastSyncAt && attempt && ghConfig.lastSyncAt >= attempt.submittedAt));

    const states = [
      { id: 1, label: '① 闭卷限时', done: step1Done },
      { id: 2, label: '② 定位错因', done: step2Done },
      { id: 3, label: '③ 译文/精读卡', done: step3Done },
      { id: 4, label: '④ 收词划短语', done: step4Done },
      { id: 5, label: '⑤ 同步手机', done: step5Done },
    ];
    let foundNow = false;
    const stepsHtml = states.map((s, idx) => {
      let cls = 'sop-step';
      if (s.done) cls += ' done';
      else if (!foundNow) { cls += ' now'; foundNow = true; }
      return `${idx > 0 ? '<span class="sop-sep">→</span>' : ''}<button type="button" class="${cls}" data-sop-step="${s.id}">${s.done ? '✓ ' : ''}${s.label}</button>`;
    }).join('');

    const lockHtml = !attempt
      ? `<button type="button" class="lock-pill ${examLockLookup ? 'on' : ''}" id="btn-exam-lock" title="一刷开启可防止忍不住查词，交卷后自动解锁">${examLockLookup ? '🔒 考场锁查词：开' : '🔓 考场锁查词：关'}</button>`
      : `<span class="origin-badge official">✓ 查词与划短语已解锁</span>`;

    return `<div class="sop-bar" data-tour="sop">
      <div class="sop-steps">${stepsHtml}</div>
      <div class="sop-tools">
        ${lockHtml}
        <button type="button" class="ghost-sm" id="btn-grammar-studio">📖 时态语态速查</button>
      </div>
    </div>`;
  }

  function renderStudio() {
    if (activeSet) currentPassageId = activeSet.passageIds[activeSet.activeIndex];
    const p = passageById(currentPassageId) || allPassages()[0];
    if (!p) return '<div class="scroll-view"><p>题库为空。</p></div>';
    currentPassageId = p.id;
    if (!activeSet && (!activeDraft || activeDraft.passageId !== p.id)) {
      activeDraft = { passageId: p.id, startedAt: Date.now(), answers: {}, marks: {}, submittedAttemptId: null };
    }
    const draft = activeDraftForCurrent();
    const attempt = currentAttempt();
    const collected = collectedSet();
    const userHl = new Set(state.reading.highlights?.[p.id] || []);
    const paraNotes = state.reading.paraNotes?.[p.id] || {};
    const trans = p.translations || [];

    const parasHtml = p.paragraphs.map((text, i) => {
      const num = i + 1;
      const note = paraNotes[num] || '';
      const transHtml = attempt && showTranslations && trans[i]
        ? `<div class="para-trans">${esc(trans[i])}</div>` : '';
      const noteHtml = highlightMode
        ? `<div class="para-note-box"><input type="text" class="para-note-input" data-pnote-para="${num}" value="${esc(note)}" placeholder="第 [${num}] 段段意批注（选填，自动保存）…"></div>`
        : (note ? `<div class="para-note-pill">段意批注：${esc(note)}</div>` : '');
      return `<div class="para-block">
        <p class="para ${userHl.has(num) ? 'user-hl' : ''}" id="para-${num}" data-para="${num}" style="--art-size:${fontSize}px">
          <span class="para-num">[${num}]</span>${tokenizeParagraph(text, collected)}
        </p>
        ${transHtml}
        ${noteHtml}
      </div>`;
    }).join('');

    const qsHtml = p.questions.map(q => {
      const itemRec = attempt ? attempt.items.find(x => x.no === q.no) : null;
      const chosen = attempt ? itemRec?.chosen : draft.answers[q.no];
      const mark = attempt ? itemRec?.mark : (draft.marks[q.no] || '');
      const optsHtml = q.options.map((opt, idx) => {
        let cls = 'q-opt';
        if (attempt) {
          if (idx === q.answer) cls += ' correct';
          else if (idx === chosen && chosen !== q.answer) cls += ' wrong';
        } else if (chosen === idx) cls += ' selected';
        return `<button type="button" class="${cls}" data-choose-q="${q.no}" data-choose-opt="${idx}" ${attempt ? 'disabled' : ''}>
          <span class="letter">${LETTERS[idx]}</span><span>${esc(opt)}</span>
        </button>`;
      }).join('');

      let reviewHtml = '';
      if (attempt && itemRec) {
        const errTagsHtml = SyncModel.ERROR_TAGS.map(tag => {
          const on = (itemRec.errorTags || []).includes(tag);
          return `<button type="button" class="err-tag ${on ? 'on' : ''}" data-err-q="${q.no}" data-err-tag="${esc(tag)}">${esc(tag)}</button>`;
        }).join('');
        reviewHtml = `<div class="q-review">
          <div class="q-verdict ${itemRec.correct ? 'ok' : 'bad'}">
            <span>${itemRec.correct ? '✓ 答对了' : `✕ 选了 ${chosen >= 0 ? LETTERS[chosen] : '未选'}，正解为 ${LETTERS[q.answer]}`}</span>
            <button type="button" class="ghost-sm" data-locate-para="${q.evidencePara}">定位原文第 [${q.evidencePara}] 段</button>
          </div>
          <p class="q-quote">“${esc(q.evidenceQuote)}”</p>
          <p class="q-exp">${esc(q.explanation)}</p>
          ${q.trapNote ? `<p class="q-trap">干扰项拆解：${esc(q.trapNote)}</p>` : ''}
          ${(!itemRec.correct || itemRec.mark === 'hesitant') ? `<div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:5px">标记错因 / 犹豫原因（自动进入「错题本」与分析报告）：</div>
            <div class="err-tags">${errTagsHtml}</div>
            <input type="text" class="q-note-input" style="margin-top:8px" data-note-q="${q.no}" value="${esc(itemRec.note || '')}" placeholder="选填：一句话记下这道题的坑点…">
          </div>` : ''}
        </div>`;
      }

      return `<article class="q-card">
        <div class="q-head">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="q-no">Q${q.no}</span>
            <span class="q-type">${esc(q.type)}</span>
          </div>
          <div class="conf-group">
            <button type="button" class="conf-btn sure ${mark === 'sure' ? 'on' : ''}" data-mark-q="${q.no}" data-mark-val="sure" ${attempt ? 'disabled' : ''}>稳</button>
            <button type="button" class="conf-btn hesitant ${mark === 'hesitant' ? 'on' : ''}" data-mark-q="${q.no}" data-mark-val="hesitant" ${attempt ? 'disabled' : ''}>犹</button>
          </div>
        </div>
        <div class="q-stem">${esc(q.stem)}</div>
        <div class="q-opts">${optsHtml}</div>
        ${reviewHtml}
      </article>`;
    }).join('');

    const answeredCnt = Object.keys(draft.answers).length;
    const elapsedText = activeSet
      ? (activeSet.submitted ? `套卷总用时 ${Math.floor(activeSet.totalSec / 60)}分${activeSet.totalSec % 60}秒` : `剩 ${activeSet.timeLimitMin}:00`)
      : (attempt ? `用时 ${Math.floor(attempt.durationSec / 60)}分${attempt.durationSec % 60}秒` : '00:00');
    const qCnt = activeQueue().length;

    const nextSetBtn = activeSet && activeSet.activeIndex < activeSet.passageIds.length - 1
      ? `<button type="button" class="solid-btn" data-set-idx="${activeSet.activeIndex + 1}">下一篇 P${activeSet.activeIndex + 2} →</button>`
      : null;

    return `<div class="studio-shell">
      ${renderSetRibbon()}
      ${renderSopBar(p, attempt)}
      <div class="studio-wrap">
        <section class="pane-left ${highlightMode ? 'hl-mode' : ''}" data-tour="article">
          <div class="pane-bar">
            <div class="pane-bar-group">
              <button type="button" class="ghost-sm" data-view-jump="library">← 题库</button>
              <span class="tier tier-${p.difficulty}">${TIER_META[p.difficulty]?.name || p.difficulty}</span>
              ${attempt ? `<button type="button" class="ghost-sm ${showTranslations ? 'active' : ''}" id="btn-toggle-trans">${showTranslations ? '隐藏译文' : '逐段译文'}</button>` : ''}
              ${attempt && p.studyPack ? `<button type="button" class="ghost-sm ${showStudyPack ? 'active' : ''}" id="btn-toggle-study">${showStudyPack ? '收起精读卡' : '精读卡（长难句/替换）'}</button>` : ''}
            </div>
            <div class="pane-bar-group">
              <button type="button" class="ghost-sm ${!highlightMode ? 'active' : ''}" id="mode-lookup">点词/划短语</button>
              <button type="button" class="ghost-sm ${highlightMode ? 'active' : ''}" id="mode-hl">标亮/段意</button>
              <button type="button" class="ghost-sm" id="font-dec">A-</button>
              <button type="button" class="ghost-sm" id="font-inc">A+</button>
              <button type="button" class="ghost-sm" data-view-jump="vocab">管理生词 (${qCnt})</button>
            </div>
          </div>
          <div class="article-scroll">
            <h2 class="article-title">${esc(p.title)}</h2>
            <div class="article-meta">
              <span>${esc(p.sourceLabel)}</span>
              <span>约 ${p.wordCount || 360} 词</span>
              <span>建议 ${p.timeLimitMin} 分钟</span>
              <span>${attempt ? '点单词查义 · 拖选多词短语可一键记笔记 · 上方可开译文与精读卡' : (highlightMode ? '点击段落标亮，下方可记一句中文段意' : (examLockLookup ? '考场锁查词中：先专心限时做完再精读' : '点单词快查 · 拖选多词短语可一键收笔记'))}</span>
            </div>
            ${attempt && showStudyPack ? renderStudyPackHtml(p, collected) : ''}
            ${parasHtml}
          </div>
        </section>

        <section class="pane-right" data-tour="questions">
          <div class="pane-bar">
            <div class="pane-bar-group">
              <strong style="font-size:14.5px">${attempt ? `已交卷 · ${attempt.score}/${attempt.total}` : `答题区（${answeredCnt}/${p.questions.length}）`}</strong>
            </div>
            <div class="pane-bar-group">
              <span class="timer-box" id="live-timer">${elapsedText}</span>
              ${attempt && !activeSet ? `<button type="button" class="ghost-sm" data-restart-passage="${esc(p.id)}">再刷一遍</button>` : ''}
            </div>
          </div>
          <div class="questions-scroll">${qsHtml}</div>
          <div class="submit-bar">
            <span style="font-size:12.5px;color:var(--muted)">${attempt ? '点「定位原文」标亮证据段，错题自动收入「错题本」' : (activeSet ? '全部篇目答完后点「整套交卷核对」' : `建议 ${p.timeLimitMin} 分钟 · 顺手标「稳/犹」`)}</span>
            ${attempt
              ? (nextSetBtn || `<button type="button" class="solid-btn" data-view-jump="mistakes">去错题本复盘</button>`)
              : (activeSet ? (nextSetBtn || `<button type="button" class="solid-btn" id="btn-submit-passage">整套交卷核对</button>`) : `<button type="button" class="solid-btn" id="btn-submit-passage">交卷核对</button>`)}
          </div>
        </section>
      </div>
    </div>`;
  }

  // ---- VIEW 3: MISTAKES NOTEBOOK ----
  function renderMistakes() {
    const all = collectMistakeEntries();
    const activeCnt = all.filter(x => !x.mastered).length;
    const wrongCnt = all.filter(x => !x.mastered && x.isWrong).length;
    const hesCnt = all.filter(x => !x.mastered && !x.isWrong && x.isHesitant).length;
    const untaggedCnt = all.filter(x => !x.mastered && !(x.item.errorTags || []).length).length;
    const masteredCnt = all.filter(x => x.mastered).length;

    const filtered = all.filter(x => {
      if (mistakeFilter === 'ACTIVE' && x.mastered) return false;
      if (mistakeFilter === 'WRONG' && (x.mastered || !x.isWrong)) return false;
      if (mistakeFilter === 'HESITANT' && (x.mastered || !x.isHesitant)) return false;
      if (mistakeFilter === 'UNTAGGED' && (x.mastered || (x.item.errorTags || []).length)) return false;
      if (mistakeFilter === 'MASTERED' && !x.mastered) return false;
      if (mistakeTier !== 'ALL' && x.passage.difficulty !== mistakeTier) return false;
      if (mistakeType !== 'ALL' && x.question.type !== mistakeType) return false;
      if (mistakeTag !== 'ALL' && !(x.item.errorTags || []).includes(mistakeTag)) return false;
      return true;
    });

    const cardsHtml = filtered.map(entry => {
      const { passage: p, question: q, item, attempt, mastered, key } = entry;
      const optsHtml = q.options.map((opt, idx) => {
        let cls = 'q-opt';
        if (idx === q.answer) cls += ' correct';
        else if (idx === item.chosen && item.chosen !== q.answer) cls += ' wrong';
        return `<div class="${cls}"><span class="letter">${LETTERS[idx]}</span><span>${esc(opt)}</span></div>`;
      }).join('');
      const errTagsHtml = SyncModel.ERROR_TAGS.map(tag => {
        const on = (item.errorTags || []).includes(tag);
        return `<button type="button" class="err-tag ${on ? 'on' : ''}" data-m-err-att="${esc(attempt.id)}" data-m-err-q="${q.no}" data-m-err-tag="${esc(tag)}">${esc(tag)}</button>`;
      }).join('');

      return `<article class="mistake-card ${mastered ? 'mastered' : ''}">
        <div class="mistake-top">
          <div class="mistake-src">
            <span class="tier tier-${p.difficulty}">${TIER_META[p.difficulty]?.name || p.difficulty}</span>
            <span class="origin-badge ${entry.isWrong ? 'err' : 'star'}">${entry.isWrong ? `错选 ${item.chosen >= 0 ? LETTERS[item.chosen] : '未选'} → 正解 ${LETTERS[q.answer]}` : `标犹做对（${LETTERS[q.answer]}）`}</span>
            <span class="q-type">${esc(q.type)}</span>
            <span>${esc(p.title)} · Q${q.no}</span>
          </div>
          <div class="pane-bar-group">
            <button type="button" class="ghost-sm" data-jump-evidence="${esc(p.id)}:${q.evidencePara}">去原文第 [${q.evidencePara}] 段复看</button>
            <button type="button" class="${mastered ? 'ghost-sm' : 'ok-sm'}" data-toggle-mastered="${esc(key)}">${mastered ? '撤回待复盘' : '✓ 标为已吃透'}</button>
          </div>
        </div>
        <div class="q-stem">${esc(q.stem)}</div>
        <div class="q-opts">${optsHtml}</div>
        <p class="q-quote">“${esc(q.evidenceQuote)}”</p>
        <p class="q-exp">${esc(q.explanation)}</p>
        ${q.trapNote ? `<p class="q-trap">干扰项拆解：${esc(q.trapNote)}</p>` : ''}
        <div>
          <div class="err-tags">${errTagsHtml}</div>
          <input type="text" class="q-note-input" style="margin-top:8px" data-m-note-att="${esc(attempt.id)}" data-m-note-q="${q.no}" value="${esc(item.note || '')}" placeholder="写一句考前提醒自己的避坑要点…">
        </div>
      </article>`;
    }).join('');

    return `<div class="scroll-view">
      <section class="lib-hero">
        <div>
          <h2>阅读错题本与犹豫题专项复盘（待复盘 ${activeCnt} 题）</h2>
          <p>其中做错 <strong>${wrongCnt}</strong> 题 · 标「犹」蒙对 <strong>${hesCnt}</strong> 题 · 尚未标错因 <strong>${untaggedCnt}</strong> 题 · 已吃透 <strong>${masteredCnt}</strong> 题</p>
        </div>
        <div class="btn-row" style="margin:0">
          <button type="button" class="ghost-sm" data-view-jump="analytics">查看错因统计报告</button>
        </div>
      </section>

      <div class="lib-controls">
        <div class="chip-group">
          ${[
            ['ACTIVE', `待复盘 (${activeCnt})`],
            ['WRONG', `仅错题 (${wrongCnt})`],
            ['HESITANT', `含犹豫 (${all.filter(x => !x.mastered && x.isHesitant).length})`],
            ['UNTAGGED', `未标错因 (${untaggedCnt})`],
            ['MASTERED', `已吃透 (${masteredCnt})`],
            ['ALL', `全部 (${all.length})`],
          ].map(([k, lbl]) => `<button type="button" class="filter-chip ${mistakeFilter === k ? 'active' : ''}" data-m-filter="${k}">${lbl}</button>`).join('')}
        </div>
        <div class="chip-group">
          <select id="m-tier" class="filter-select">
            <option value="ALL">全部难度</option>
            ${['L1', 'L2', 'L3', 'L4'].map(t => `<option value="${t}" ${mistakeTier === t ? 'selected' : ''}>${TIER_META[t].name}</option>`).join('')}
          </select>
          <select id="m-type" class="filter-select">
            <option value="ALL">全部题型</option>
            ${SyncModel.QUESTION_TYPES.map(tp => `<option value="${tp}" ${mistakeType === tp ? 'selected' : ''}>${tp}</option>`).join('')}
          </select>
          <select id="m-tag" class="filter-select">
            <option value="ALL">全部错因</option>
            ${SyncModel.ERROR_TAGS.map(tg => `<option value="${tg}" ${mistakeTag === tg ? 'selected' : ''}>${tg}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="mistake-list">
        ${cardsHtml || '<div class="ana-card" style="text-align:center;color:var(--muted)">当前筛选下没有错题记录。完成阅读并交卷后，所有做错的题和标「犹」的题会自动汇总到这里。</div>'}
      </div>
    </div>`;
  }

  // ---- VIEW 4: VOCAB QUEUE MANAGER ----
  function renderVocabRows() {
    const queue = activeQueue();
    const qLow = vocabSearch.trim().toLowerCase();
    const filtered = queue.filter(item => {
      if (vocabFilter === 'PENDING' && item.consumedOnPhone) return false;
      if (vocabFilter === 'SYNCED' && !item.consumedOnPhone) return false;
      if (vocabFilter === 'WRITING' && !item.writingTag) return false;
      if (qLow) {
        const hay = `${item.word} ${item.gloss || ''} ${item.sentence || ''} ${item.passageId || ''}`.toLowerCase();
        if (!hay.includes(qLow)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      return '<div class="ana-card" style="text-align:center;color:var(--muted)">生词队列为空或没有匹配项。在「正在精读」里点文章中的任意英文词，或在精读卡里点「+ 收词」即可加入。</div>';
    }

    return filtered.map(item => {
      const k = SyncModel.normWord(item.word);
      const srcPassage = passageById(item.passageId);
      const srcName = srcPassage ? srcPassage.title : (item.passageId || '手动添加');
      const card = state.vocab.cards?.[item.id || `w:${k}`];
      const phoneState = card
        ? (card.phase === 'known' ? '手机熟词' : card.lapses > 0 ? `手机忘过 ${card.lapses} 次` : `手机间隔 ${card.ivl || 1} 天`)
        : (item.consumedOnPhone ? '已入手机队列' : '待同步至手机');
      return `<article class="vocab-row">
        <div class="vocab-word-col">
          <b lang="en">${esc(item.word)}</b>
          <div class="v-tags">
            <span class="origin-badge ${item.consumedOnPhone ? 'official' : ''}">${phoneState}</span>
            ${item.writingTag ? '<span class="origin-badge star">★ 写作语料</span>' : ''}
          </div>
        </div>
        <div class="vocab-mid-col">
          <div class="v-gloss">${esc(item.gloss || '（未填释义）')}</div>
          ${item.sentence ? `<div class="v-sent">“${esc(item.sentence)}”</div>` : ''}
          <div class="v-meta">来源：${esc(srcName)} · ${item.collectedAt ? new Date(item.collectedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</div>
        </div>
        <div class="vocab-act-col">
          <button type="button" class="ghost-sm" data-v-speak="${esc(item.word)}">🔊 听音</button>
          <button type="button" class="ghost-sm ${item.writingTag ? 'active' : ''}" data-v-star="${esc(k)}">${item.writingTag ? '★ 已标写作' : '☆ 写作'}</button>
          <button type="button" class="ghost-sm" data-v-toggle-sync="${esc(k)}" title="重置后下次同步会重新推入手机待补学队列">${item.consumedOnPhone ? '重推手机' : '标已入队'}</button>
          <button type="button" class="ghost-sm" data-v-edit="${esc(k)}">编辑</button>
          <button type="button" class="danger-sm" data-v-del="${esc(k)}">删除</button>
        </div>
      </article>`;
    }).join('');
  }

  function renderVocabManager() {
    const queue = activeQueue();
    const pendingCnt = queue.filter(x => !x.consumedOnPhone).length;
    const syncedCnt = queue.filter(x => x.consumedOnPhone).length;
    const writingCnt = queue.filter(x => x.writingTag).length;

    return `<div class="scroll-view">
      <section class="lib-hero">
        <div>
          <h2>生词队列与写作语料管理（共 ${queue.length} 条）</h2>
          <p>待同步入手机 <strong>${pendingCnt}</strong> 条 · 手机已入队 <strong>${syncedCnt}</strong> 条 · ★ 写作语料 <strong>${writingCnt}</strong> 条。这里删改后点右上角「GitHub 同步」即可同步到 OPPO 手机。</p>
        </div>
        <div class="btn-row" style="margin:0">
          <button type="button" class="solid-sm" id="btn-vocab-add">+ 手动添加生词 / 短句</button>
          <button type="button" class="ghost-sm" id="btn-vocab-copy-csv">复制全部（可直贴手机导入）</button>
          ${syncedCnt ? '<button type="button" class="ghost-sm" id="btn-vocab-clear-synced">清理已入队项</button>' : ''}
        </div>
      </section>

      <div class="lib-controls">
        <div class="chip-group">
          ${[['ALL', `全部 (${queue.length})`], ['PENDING', `待同步手机 (${pendingCnt})`], ['SYNCED', `手机已入队 (${syncedCnt})`], ['WRITING', `★ 写作语料 (${writingCnt})`]].map(([k, lbl]) =>
            `<button type="button" class="filter-chip ${vocabFilter === k ? 'active' : ''}" data-v-filter="${k}">${lbl}</button>`).join('')}
        </div>
        <input type="search" id="vocab-search" class="search-input" value="${esc(vocabSearch)}" placeholder="搜索单词、释义或出处…">
      </div>

      <div id="vocab-list" class="vocab-list">${renderVocabRows()}</div>
    </div>`;
  }

  // ---- VIEW 5: ANALYTICS & SYNC ----
  function renderAnalytics() {
    const sum = SyncModel.readingSummary(state.reading.attempts, state.vocab.cards, state.vocab.collectedQueue);
    const track = SyncModel.EXAM_TRACKS[state.profile.examTrack] || SyncModel.EXAM_TRACKS.cet6;
    const dl = SyncModel.daysUntil(state.profile.examDate);
    const phoneCards = Object.values(state.vocab.cards || {});
    const phoneLearned = phoneCards.filter(c => c.grade != null).length;
    const phoneDue = phoneCards.filter(c => c.phase !== 'queued' && c.due <= Date.now()).length;

    const tierBars = ['L1', 'L2', 'L3', 'L4'].map(t => {
      const row = sum.byDifficulty[t];
      const pct = row && row.total ? Math.round((row.correct / row.total) * 100) : 0;
      const meta = row ? `${pct}%（${row.correct}/${row.total} · ${row.passages}篇）` : '暂未作答';
      return `<div><div class="bar-item-head"><span>${TIER_META[t].name}</span><span>${meta}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div></div>`;
    }).join('');

    const typeEntries = Object.entries(sum.byType).sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total));
    const typeBars = typeEntries.length ? typeEntries.map(([tp, row]) => {
      const pct = Math.round((row.correct / row.total) * 100);
      return `<div><div class="bar-item-head"><span>${esc(tp)}</span><span>${pct}%（${row.correct}/${row.total}）</span></div>
        <div class="bar-track"><div class="bar-fill ${pct < 60 ? 'red' : ''}" style="width:${pct}%"></div></div></div>`;
    }).join('') : '<p style="font-size:13.5px;color:var(--muted)">做完第一篇阅读后，这里会自动统计六大题型的薄弱排序。</p>';

    const errEntries = Object.entries(sum.byErrorTag).sort((a, b) => b[1] - a[1]);
    const errTotal = errEntries.reduce((s, [, v]) => s + v, 0) || 1;
    const errBars = errEntries.length ? errEntries.map(([tag, cnt]) => {
      const pct = Math.round((cnt / errTotal) * 100);
      return `<div><div class="bar-item-head"><span>${esc(tag)}</span><span>${cnt} 次（${pct}%）</span></div>
        <div class="bar-track"><div class="bar-fill red" style="width:${pct}%"></div></div></div>`;
    }).join('') : '<p style="font-size:13.5px;color:var(--muted)">交卷后在错题/犹豫题上点一下错因标签，这里会自动归因。</p>';

    return `<div class="scroll-view">
      <div class="ana-grid">
        <section class="ana-card hero">
          <h3>备考档位与核心仪表盘 <small>${dl != null ? `距 ${esc(track.label)} 约 ${dl} 天` : ''}</small></h3>
          <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
            <div class="field-row">
              <label for="ana-track">分析目标档位（随时可切）</label>
              <select id="ana-track">${Object.values(SyncModel.EXAM_TRACKS).map(t => `<option value="${t.id}" ${t.id === state.profile.examTrack ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
            </div>
            <div class="field-row">
              <label for="ana-date">目标考试日期</label>
              <input type="date" id="ana-date" value="${esc(state.profile.examDate)}">
            </div>
          </div>
          <div class="kpi-row">
            <div class="kpi-box"><b>${sum.passagesDone}</b><span>已精读篇数</span></div>
            <div class="kpi-box"><b>${sum.accuracy != null ? Math.round(sum.accuracy * 100) + '%' : '—'}</b><span>阅读总正确率</span></div>
            <div class="kpi-box"><b>${sum.avgMinutesPerPassage ?? '—'}m</b><span>篇均用时</span></div>
            <div class="kpi-box"><b>${phoneLearned}</b><span>手机已背词</span></div>
          </div>
          <p style="font-size:13px;color:var(--muted);margin-top:12px">当前档位诊断重点：${esc(track.focus)}${phoneDue ? ` · 手机当前到期 ${phoneDue} 词` : ''}</p>
        </section>

        <section class="ana-card">
          <h3>GitHub 私有库跨端同步 <small>${ghConfig.lastSyncAt ? `上次：${new Date(ghConfig.lastSyncAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '尚未同步'}</small></h3>
          <div class="form-grid">
            <div class="field-row"><label for="gh-repo">私有仓库（用户名/仓库名）</label><input id="gh-repo" value="${esc(ghConfig.repo)}" placeholder="例如 darks/study-sync"></div>
            <div class="field-row"><label for="gh-path">同步文件路径</label><input id="gh-path" value="${esc(ghConfig.path)}" placeholder="sync/study-state.json"></div>
            <div class="field-row"><label for="gh-token">Fine-grained PAT（仅授单仓 Contents 读写）</label><input id="gh-token" type="password" value="${esc(ghConfig.token)}" placeholder="github_pat_..."></div>
          </div>
          <div class="btn-row">
            <button type="button" class="solid-sm" id="btn-gh-save-sync" ${syncing ? 'disabled' : ''}>${syncing ? '正在同步…' : '保存并双向同步'}</button>
            <button type="button" class="ghost-sm" id="btn-export-local">导出本地备份 JSON</button>
            <button type="button" class="ghost-sm" id="btn-import-local">导入合并 JSON</button>
          </div>
        </section>
      </div>

      <div class="ana-grid">
        <section class="ana-card">
          <h3>分难度梯队掌握度 <small>L1 四级 → L4 拔高</small></h3>
          <div class="bar-list">${tierBars}</div>
        </section>
        <section class="ana-card">
          <h3>题型薄弱排序 <small>从最弱到最强</small></h3>
          <div class="bar-list">${typeBars}</div>
        </section>
        <section class="ana-card">
          <h3>高频错因归因 <small>犹而不决 ${sum.hesitantTotal} 题（错 ${sum.hesitantWrong}）</small></h3>
          <div class="bar-list">${errBars}</div>
        </section>
      </div>

      <div class="ana-grid">
        <section class="ana-card">
          <h3>平板 × 手机词汇联动 <small><button type="button" class="ghost-sm" data-view-jump="vocab">去管理生词队列 (${sum.vocabBridge.collectedTotal})</button></small></h3>
          <p style="font-size:13.5px;color:var(--text)">
            阅读中收藏的生词里：手机端未背过 <strong>${sum.vocabBridge.collectedUnseen}</strong> 个 · 背过但曾忘过 <strong>${sum.vocabBridge.collectedLapsed}</strong> 个 · 手机已学 <strong>${sum.vocabBridge.collectedAlreadyLearned}</strong> 个。
          </p>
        </section>

        <section class="ana-card">
          <h3>AI 私人备考分析官 <small>DeepSeek 直连或零费用复制数据包</small></h3>
          <div class="form-grid" style="grid-template-columns:1fr 140px">
            <div class="field-row"><label for="ai-key">DeepSeek API Key（选填，仅存本机浏览器）</label><input id="ai-key" type="password" value="${esc(aiConfig.key)}" placeholder="sk-..."></div>
            <div class="field-row"><label for="ai-model">模型</label><select id="ai-model"><option value="deepseek-flash" ${aiConfig.model === 'deepseek-flash' ? 'selected' : ''}>Flash（快省）</option><option value="deepseek-v4-pro" ${aiConfig.model === 'deepseek-v4-pro' ? 'selected' : ''}>Pro（深度）</option></select></div>
          </div>
          <div class="btn-row">
            <button type="button" class="solid-sm" id="btn-run-ai" ${aiBusy ? 'disabled' : ''}>${aiBusy ? '正在诊断…' : '生成分档深度诊断'}</button>
            <button type="button" class="ghost-sm" id="btn-copy-pack">一键复制诊断包（贴给 GPT/Claude）</button>
          </div>
          ${state.lastAiReport ? `<div class="ai-box">${esc(state.lastAiReport)}</div>` : ''}
        </section>
      </div>
    </div>`;
  }

  function buildDiagnosticPayload() {
    const track = SyncModel.EXAM_TRACKS[state.profile.examTrack] || SyncModel.EXAM_TRACKS.cet6;
    const sum = SyncModel.readingSummary(state.reading.attempts, state.vocab.cards, state.vocab.collectedQueue);
    const phoneCards = Object.values(state.vocab.cards || {});
    return {
      examProfile: { ...track, examDate: state.profile.examDate, daysLeft: SyncModel.daysUntil(state.profile.examDate) },
      readingSummary: sum,
      vocabOverview: {
        syncedPhoneLearned: phoneCards.filter(c => c.grade != null).length,
        syncedPhoneMature: phoneCards.filter(c => c.grade != null && c.ivl >= 21).length,
        syncedPhoneDueNow: phoneCards.filter(c => c.phase !== 'queued' && c.due <= Date.now()).length,
        collectedFromReading: activeQueue().slice(0, 20).map(x => ({ word: x.word, gloss: x.gloss, writingTag: x.writingTag })),
      },
    };
  }

  async function runAiDiagnosis() {
    aiConfig.key = (document.getElementById('ai-key')?.value || '').trim();
    aiConfig.model = document.getElementById('ai-model')?.value || 'deepseek-flash';
    saveAi();
    if (!aiConfig.key) { toast('未填 DeepSeek Key，可直接点「一键复制诊断包」发给 AI 分析'); return; }
    aiBusy = true;
    render();
    try {
      const payload = buildDiagnosticPayload();
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiConfig.key}` },
        body: JSON.stringify({
          model: aiConfig.model,
          thinking: { type: 'disabled' },
          max_tokens: 1200,
          messages: [
            {
              role: 'system',
              content: '你是资深四六级与考研英语导师。根据用户提交的 JSON（含目标考试档位、倒计时、阅读分难度/分题型正确率、错因统计、以及与手机端联动的词汇掌握情况），写一份犀利、具体、零套话的中文诊断报告，分四段：①当前节奏与倒计时评估；②阅读最核心失分根因（区分词汇问题 vs 句法/逻辑问题）；③词汇与阅读联动建议；④下周 3 条可直接照做的定量行动。禁止“继续保持/加油/总的来说”等废话。',
            },
            { role: 'user', content: JSON.stringify(payload) },
          ],
        }),
      });
      if (!res.ok) throw new Error(`DeepSeek 请求失败（HTTP ${res.status}）`);
      const data = await res.json();
      state.lastAiReport = data.choices?.[0]?.message?.content?.trim() || '未返回有效内容';
      state.lastAiAt = Date.now();
      saveState();
      toast('深度学情诊断已生成');
    } catch (err) {
      toast(err.message || 'AI 诊断失败，可用「一键复制诊断包」替代');
    } finally {
      aiBusy = false;
      render();
    }
  }

  function setView(next) {
    if (view === 'listening' && next !== 'listening') window.ListeningStudio?.stopPlayback();
    view = next;
    wordPop.hidden = true;
    hideSelBar();
    document.querySelectorAll('.top-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === next)));
    render();
  }

  function render() {
    updateBadges();
    if (view === 'library') mainEl.innerHTML = renderLibrary();
    else if (view === 'studio') { mainEl.innerHTML = renderStudio(); startTimerTick(); }
    else if (view === 'listening') mainEl.innerHTML = window.ListeningStudio ? window.ListeningStudio.render() : '<div class="scroll-view"><p class="empty-box">听力模块未加载</p></div>';
    else if (view === 'mistakes') mainEl.innerHTML = renderMistakes();
    else if (view === 'vocab') mainEl.innerHTML = renderVocabManager();
    else mainEl.innerHTML = renderAnalytics();
  }

  // ---- Built-in Grammar Quick Reference (Tenses, Voices, Negation & Long Sentences) ----
  const GRAMMAR_CONTENT = {
    tense: [
      {
        title: '1. 虚拟语气 & 情态完成式（考场最爱把“假设”偷换成“事实”）',
        ex: 'People who might have had the chance to develop practical judgment no longer will.',
        bad: '❌ 错翻成事实：“人们已经有了培养判断力的机会……”',
        good: '✅ 正解（虚拟/过去可能）：“原本可能有幸培养实践判断力的人，今后将不再有机会。”',
        tip: '盯紧 would / could / might / should + have done、were to、had + 主语 倒装。选项若用 has proved / already happened 把虚拟变事实，90% 是干扰项！',
      },
      {
        title: '2. 被动语态 vs 过去分词作后置定语（done ≠ did！）',
        ex: 'The policies introduced to protect ordinary workers may place those jobs at risk.',
        bad: '❌ 错把 introduced 当谓语动词，后面看到 may place 就晕了。',
        good: '✅ 主干：The policies (主) + may place (谓) + those jobs at risk (宾补)；introduced to... 是被动修饰 policies 的后置定语。',
        tip: '口诀：一个简单句只能有一个谓语！遇到名词后紧跟 V-ed，先往后看还有没有真正的谓语动词（is/are/may/has/V-s）；有的话前面那个 V-ed 一定是“被……”的后置定语。',
      },
      {
        title: '3. 现在完成 / 完成进行时（have done / has been doing）暗示“至今仍在持续”',
        ex: 'America is stuck in a debate that has been going on for decades.',
        bad: '❌ 误以为争论已经结束了。',
        good: '✅ 正解：这场争论已经持续数十年且至今未决（对应选项中的 enduring / ongoing）。',
        tip: '六级和考研细节题经常用时间维度设坑：原文现在完成时 = 现状依然存在；选项如果说 used to / once / no longer 就直接排除。',
      },
      {
        title: '4. 过去完成时（had done）与时间先后倒推',
        ex: 'He becomes a far better person than he would have been had he remained in society.',
        bad: '❌ 看到 had he remained 不认识倒装，翻不出逻辑。',
        good: '✅ 还原为 if he had remained（对过去的虚拟条件）：“如果当初留在原社会，他本不会成为这么好的人。”',
        tip: 'had + done 在陈述句表“过去的过去”；如果 had / were / should 跑到主语前面，就是省略 if 的虚拟倒装！',
      },
    ],
    neg: [
      {
        title: '5. 隐性否定 & 双重否定（干扰项“正反颠倒”第一重灾区）',
        ex: 'While this research is relatively new, the principles involved are anything but.',
        bad: '❌ 看到 anything but 误以为“任何东西都……”。',
        good: '✅ anything but = 绝不、根本不是（“这些原则绝非新事物” → nothing new at all）。',
        tip: '高频隐性否定必背清单：anything but（绝不）、far from（远非）、fail to（未能）、little / few（几乎没有）、hardly / scarcely / barely（几乎不）、too...to（太……以至于不能）、short of（缺乏）、free from（免于）。',
      },
      {
        title: '6. 指代跨越（this / such / it 形式主语 / the former）',
        ex: 'This distinction misses the point that it is processing, not mere possession, that gives data value.',
        bad: '❌ 只看本句不往前找 This distinction 指什么，且看不出 it is ... that 强调句。',
        good: '✅ 先回溯上句找“区分控制者与处理者”，再拆开强调句骨架：真正赋予数据价值的是“处理与聚合”，而非单纯拥有。',
        tip: '考研英一极爱考“段首 This / Such + 名词”指代上段末句核心观点；遇到 It is + 被强调部分 + that...，把 It is 和 that 删掉句子依然完整，就是强调句！',
      },
    ],
    long: [
      {
        title: '第一步：圈出连词与标点，切分主句与从句',
        ex: 'Even if [a growing number of textbooks reflect consensus], unofficial materials [that convey slanted views] are being distributed to teachers.',
        bad: '❌ 从头到尾逐字硬顺，读到一半忘了主语是谁。',
        good: '✅ 先用括号把状语从句（Even if...）和定语从句（that...）括起来，句子瞬间缩短一半！',
        tip: '重点路标词：转折（but/yet/however/while）、让步（although/even if）、定语从句（which/that/who/where）、双逗号/双破折号插入语（先跳过不看！）。',
      },
      {
        title: '第二步：划掉介词短语，揪出唯一主句「主 + 谓（看时态语态）+ 宾」',
        ex: 'unofficial materials [that ...] → are being distributed (现在进行被动语态) → to teachers.',
        bad: '❌ 把 reflect 或 convey 当成了整句主干。',
        good: '✅ 唯一主干：非官方材料 + 正在被分发给 + 教师（现在进行时被动 = 正在发生的隐患！）。',
        tip: '真题正确答案 80% 就藏在唯一主句的主谓宾里，尤其是转折词（But/Yet/However）之后的那个主句！',
      },
      {
        title: '第三步：回填修饰语 + 对照精读卡检验',
        ex: '交卷后打开左栏「精读卡（长难句/替换）」，每篇都已帮你把最难的 2–3 句拆好主干、标出语法考点和同义替换！',
        bad: '❌ 看不懂直接扫一眼译文就过，下次换个词还是不会拆。',
        good: '✅ 自己先拆一遍主谓宾，再开「精读卡」对照，10 篇之后长难句速度肉眼可见起飞。',
        tip: '遇到极好的短语或句型（比如 stem from / at the expense of），直接鼠标/手指划选文章里的英文短语，点浮出来的「+ 收为短语」记下来送回手机背！',
      },
    ],
    order: [
      {
        title: 'Step 1｜OPPO 手机清词（每天 15–25 分钟，碎片时间）',
        ex: '先清当天到期复习（优先消化大屏昨天同步回来的生词/短语），再学当日新词。',
        bad: '❌ 手机里只背新词不清到期复习，或者在阅读里见词就全收把队列塞爆。',
        good: '✅ 12.12 六级考前主攻六级 + 四级补漏；考完六级无缝切到考研核心词。',
        tip: '生词只收三类：① 挡住解题的动词/形容词/态度副词；② 熟词僻义；③ 写作能复用的地道短语。',
      },
      {
        title: 'Step 2｜电脑 / 华为平板一刷闭卷限时（15–30 分钟）',
        ex: '平时单篇限时（六级 15m / 考研 18m），周末用「套卷模考」连刷整套原卷！',
        bad: '❌ 边做题边查单词、边偷看译文，导致上考场一遇生词就慌。',
        good: '✅ 建议开启顶部「🔒 考场锁查词」，强迫自己靠上下文逻辑硬读，顺手标「稳 / 犹」。',
        tip: '拿不准的题一定点一下「犹」，就算蒙对了也会自动进「错题本」提醒你复盘！',
      },
      {
        title: 'Step 3｜交卷后「四步精读」+ 同步回手机（15 分钟/篇）',
        ex: '定位证据段标错因 → 开「精读卡」与「逐段译文」核对时态/长难句 → 点词/划选短语收笔记 → 点右上角「GitHub 同步」。',
        bad: '❌ 交完卷只看对了几个就关页面，同一类干扰项坑掉三次。',
        good: '✅ 每周末花 15 分钟清空一次「错题本」（搞懂点「✓ 已吃透」），看「学情与同步」盯紧最弱题型。',
        tip: '电脑和华为平板共用同一个 GitHub 私有库，或者把离线单文件版发给平板/电脑本地打开，随时随地闭环学习。',
      },
    ],
  };

  function renderGrammarTab(tab) {
    grammarTab = tab;
    grammarModal.querySelectorAll('[data-gm-tab]').forEach(b => b.classList.toggle('active', b.dataset.gmTab === tab));
    const items = GRAMMAR_CONTENT[tab] || [];
    document.getElementById('gm-body').innerHTML = items.map(it => `
      <article class="gm-card">
        <h4>${esc(it.title)}</h4>
        <div class="gm-ex" lang="en">${esc(it.ex)}</div>
        <div class="gm-bad">${esc(it.bad)}</div>
        <div class="gm-good">${esc(it.good)}</div>
        <div class="gm-tip">💡 ${esc(it.tip)}</div>
      </article>`).join('');
  }

  function openGrammarModal(tab = 'tense') {
    renderGrammarTab(tab);
    grammarModal.showModal();
  }

  // ---- Multi-Word Phrase Selection Collector ----
  function handleArticleSelection() {
    const inStudio = view === 'studio' && !highlightMode;
    const inListening = view === 'listening';
    if (!inStudio && !inListening) { hideSelBar(); return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelBar(); return; }
    const anchorEl = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
    const focusEl = sel.focusNode?.nodeType === 1 ? sel.focusNode : sel.focusNode?.parentElement;
    const selector = inListening ? '.lt-transcript' : '.para';
    const paraA = anchorEl?.closest?.(selector);
    const paraB = focusEl?.closest?.(selector);
    if (!paraA || !paraB) { hideSelBar(); return; }

    const raw = sel.toString().replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
    // Trigger phrase bar for multi-word selections (contains space) or phrases >= 4 chars when dragged
    if (raw.length < 2 || raw.length > 150 || !/[A-Za-z]{2,}/.test(raw)) { hideSelBar(); return; }
    // Single plain word click without space is already handled cleanly by .tok popover unless dragged across >=2 words
    if (!/\s/.test(raw) && raw.length < 18) { hideSelBar(); return; }

    if (inStudio && examLockLookup && !currentAttempt()) {
      hideSelBar();
      toast('🔒 考场锁查词已开启：先限时做完，交卷后自动解锁划短语记笔记');
      return;
    }

    let sentence = '';
    if (inListening) {
      sentence = (anchorEl?.closest?.('.lt-seg-text, .lt-en-p')?.textContent || paraA.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    } else {
      const pNum = Number(paraA.dataset.para);
      const p = passageById(currentPassageId);
      sentence = (p?.paragraphs?.[pNum - 1] || '').slice(0, 260);
    }
    pendingSelection = { phrase: raw, sentence };

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { hideSelBar(); return; }
    document.getElementById('sel-preview').textContent = raw;
    selBar.hidden = false;
    const bw = Math.min(440, selBar.offsetWidth || 320);
    const left = Math.max(12, Math.min(rect.left + rect.width / 2 - bw / 2, window.innerWidth - bw - 12));
    const top = rect.top > 56 ? rect.top - 46 : rect.bottom + 8;
    selBar.style.left = `${Math.round(left)}px`;
    selBar.style.top = `${Math.round(top)}px`;
  }

  // ---- Cite-Checkup Style Spotlight + Hand-Drawn Brush Loop Tour ----
  const TOUR_FLAG = 'reading-tour-v1';
  const TOUR_NUMERALS = ['壹', '贰', '叁', '肆', '伍', '陆'];
  const TOUR_STEPS = [
    {
      view: 'library',
      target: '[data-tour="nav"]',
      title: '完整闭环，都在顶部五个页签',
      body: '推荐顺序：先在手机背完当日词卡 → 回大屏「阅读题库」选篇 →「正在精读」闭卷一刷+精读复盘 →「错题本」攻克薄弱项 →「生词队列」管词同步回手机。电脑和平板大屏都能直接用。',
      prefer: ['bottom', 'top'],
    },
    {
      view: 'library',
      target: '[data-tour="mode"]',
      title: '单篇精读 & 48 套真题模考',
      body: '内置 131 篇（含 17 套六级覆盖至 2026.06、17 套四级、以及 2010–2023 十四年全套考研英一；2024–2027 考研真题严格锁存留作冲刺）。平时刷单篇，周末切「套卷模考」统一倒计时练配速！',
      prefer: ['bottom', 'top', 'left'],
    },
    {
      view: 'studio',
      target: '[data-tour="sop"]',
      title: '跟着五步精读条走，一刷先开锁',
      body: '一刷建议开启「🔒 考场锁查词」，逼自己闭卷限时作答并顺手标「稳 / 犹」；交卷后自动解锁查词、逐段译文与精读卡，沿着 ①→⑤ 逐项打勾就把精读闭环走透了。',
      prefer: ['bottom', 'top'],
    },
    {
      view: 'studio',
      target: '[data-tour="article"]',
      title: '点单词快查，划选多词短语记笔记',
      body: '交卷精读时：点击任意英文词，左下角弹出 7,417 词离线词典（不遮右侧题目）；用鼠标或手指拖选任意英文短语（如 stem from / at the expense of），会自动浮出「+ 收为短语」直接带原句记笔记！',
      prefer: ['right', 'bottom', 'top'],
    },
    {
      view: 'studio',
      target: '[data-tour="grammar"]',
      title: '时态语态 & 长难句，一屏速查',
      body: '遇到虚拟语气、被动语态、过去分词后置定语、隐性否定或超长难句卡壳？随时点顶部「法 · 语法速查」直接看考场 6 大句法坑与 3 步断句口诀，交卷后也能一键展开每篇专属「精读卡」。',
      prefer: ['bottom', 'left', 'top'],
    },
    {
      view: 'studio',
      target: '[data-tour="sync"]',
      title: '一键同步回手机，开始第一轮练习吧',
      body: '点这里经 GitHub 私有库与 OPPO 手机双向互通，平板/电脑收的生词和短语会自动推入手机复习队列。以后随时点右上角「问 · 怎么用」都能重看这份引导。',
      prefer: ['bottom', 'left', 'top'],
      final: true,
    },
  ];

  let tourActive = false;
  let tourStep = 0;

  function loopPath(width, height, inset = 8) {
    const w = Math.max(width, 8);
    const h = Math.max(height, 8);
    const m = inset;
    const r = Math.min(16, h / 2, w / 2);
    const p = (x, y) => `${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
    return [
      `M ${p(m + w * 0.55, m + 1)}`,
      `L ${p(m + w - r, m - 1)}`,
      `Q ${p(m + w + 1, m - 1)} ${p(m + w + 1, m + r)}`,
      `L ${p(m + w - 1, m + h - r)}`,
      `Q ${p(m + w - 1, m + h + 1)} ${p(m + w - r, m + h + 1)}`,
      `L ${p(m + r, m + h)}`,
      `Q ${p(m - 1, m + h)} ${p(m - 1, m + h - r)}`,
      `L ${p(m + 1, m + r)}`,
      `Q ${p(m + 1, m - 1)} ${p(m + r + 2, m)}`,
      `L ${p(m + w * 0.72, m - Math.min(4, m - 1))}`,
    ].join(' ');
  }

  function placeTourCard(target, cardW, cardH, prefer) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 16;
    const margin = 14;
    const clampX = x => Math.max(margin, Math.min(x, vw - cardW - margin));
    const clampY = y => Math.max(margin, Math.min(y, vh - cardH - margin));
    const bottom = target.top + target.height;
    const right = target.left + target.width;
    for (const side of prefer) {
      if (side === 'bottom' && bottom + gap + cardH + margin <= vh && bottom + gap >= margin) {
        return { left: clampX(target.left), top: bottom + gap };
      }
      if (side === 'top' && target.top - gap - cardH >= margin && target.top - gap <= vh) {
        return { left: clampX(target.left), top: target.top - gap - cardH };
      }
      if (side === 'right' && right + gap + cardW + margin <= vw) {
        return { left: right + gap, top: clampY(target.top + target.height / 2 - cardH / 2) };
      }
      if (side === 'left' && target.left - gap - cardW >= margin) {
        return { left: target.left - gap - cardW, top: clampY(target.top + target.height / 2 - cardH / 2) };
      }
    }
    return { left: clampX((vw - cardW) / 2), top: Math.max(margin, vh - cardH - margin) };
  }

  function positionTourStep() {
    if (!tourActive) return;
    const cfg = TOUR_STEPS[tourStep];
    const el = document.querySelector(cfg.target);
    const spot = document.getElementById('tour-spot');
    const svg = document.getElementById('tour-loop');
    const path = document.getElementById('tour-loop-path');
    const card = document.getElementById('tour-card');
    const cardW = Math.min(356, window.innerWidth - 28);
    card.style.width = `${cardW}px`;

    if (el && el.getClientRects().length > 0) {
      const r = el.getBoundingClientRect();
      // Cap very tall targets (like article pane) cleanly so brush loop frames the top visible working portion
      const h = Math.min(r.height, window.innerHeight * 0.56);
      const rect = { left: r.left, top: r.top, width: r.width, height: h };
      const spotPad = 6;
      const loopPad = 10;
      const inset = 8;
      spot.hidden = false;
      spot.style.left = `${rect.left - spotPad}px`;
      spot.style.top = `${rect.top - spotPad}px`;
      spot.style.width = `${rect.width + spotPad * 2}px`;
      spot.style.height = `${rect.height + spotPad * 2}px`;

      const lw = rect.width + loopPad * 2;
      const lh = rect.height + loopPad * 2;
      svg.hidden = false;
      svg.style.left = `${rect.left - loopPad - inset}px`;
      svg.style.top = `${rect.top - loopPad - inset}px`;
      svg.setAttribute('width', String(Math.round(lw + inset * 2)));
      svg.setAttribute('height', String(Math.round(lh + inset * 2)));
      // Restart hand-drawn brush animation cleanly on each step
      path.style.animation = 'none';
      path.setAttribute('d', loopPath(lw, lh, inset));
      void path.getBoundingClientRect();
      path.style.animation = '';

      const placed = placeTourCard({ left: rect.left - loopPad, top: rect.top - loopPad, width: lw, height: lh }, cardW, card.offsetHeight || 220, cfg.prefer);
      card.style.left = `${Math.round(placed.left)}px`;
      card.style.top = `${Math.round(placed.top)}px`;
    } else {
      spot.hidden = true;
      svg.hidden = true;
      card.style.left = `${Math.round((window.innerWidth - cardW) / 2)}px`;
      card.style.top = `${Math.round(Math.max(76, (window.innerHeight - 240) / 2))}px`;
    }
  }

  function renderTourStep() {
    const cfg = TOUR_STEPS[tourStep];
    if (cfg.view === 'studio' && !currentPassageId) currentPassageId = allPassages()[0]?.id || null;
    if (view !== cfg.view) setView(cfg.view);

    document.getElementById('tour-num').textContent = TOUR_NUMERALS[tourStep] || String(tourStep + 1);
    document.getElementById('tour-step-meta').textContent = `第 ${tourStep + 1} 步 · 共 ${TOUR_STEPS.length} 步`;
    document.getElementById('tour-title').textContent = cfg.title;
    document.getElementById('tour-body').textContent = cfg.body;
    document.getElementById('tour-dots').innerHTML = TOUR_STEPS.map((_, i) =>
      `<span class="tc-dot ${i === tourStep ? 'on' : i < tourStep ? 'past' : ''}"></span>`).join('');
    document.getElementById('btn-tour-prev').hidden = tourStep === 0;
    document.getElementById('btn-tour-next').textContent = cfg.final ? '开始第一篇精读' : '下一步';

    tourRoot.hidden = false;
    requestAnimationFrame(() => {
      positionTourStep();
      document.getElementById('btn-tour-next').focus({ preventScroll: true });
    });
  }

  function startTour() {
    tourInvite.hidden = true;
    wordPop.hidden = true;
    hideSelBar();
    tourActive = true;
    tourStep = 0;
    renderTourStep();
  }

  function finishTour(goFirstPassage = false) {
    tourActive = false;
    tourRoot.hidden = true;
    try { localStorage.setItem(TOUR_FLAG, 'done'); } catch {}
    if (goFirstPassage) {
      const firstTodo = allPassages().find(p => !attemptsFor(p.id).length) || allPassages()[0];
      if (firstTodo) startPassage(firstTodo.id);
    }
  }

  function dismissInvite() {
    tourInvite.hidden = true;
    try { localStorage.setItem(TOUR_FLAG, 'dismissed'); } catch {}
  }

  // ---- Global Event Listeners ----
  document.querySelectorAll('.top-tab').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  document.getElementById('btn-quick-sync').addEventListener('click', () => { markSop('synced'); syncWithGitHub(false); });
  document.getElementById('btn-grammar-top').addEventListener('click', () => openGrammarModal('tense'));
  document.getElementById('btn-tour').addEventListener('click', startTour);
  document.getElementById('btn-invite-go').addEventListener('click', startTour);
  document.getElementById('btn-invite-skip').addEventListener('click', dismissInvite);
  document.getElementById('btn-tour-skip').addEventListener('click', () => finishTour(false));
  document.getElementById('btn-tour-prev').addEventListener('click', () => { if (tourStep > 0) { tourStep--; renderTourStep(); } });
  document.getElementById('btn-tour-next').addEventListener('click', () => {
    if (tourStep + 1 < TOUR_STEPS.length) { tourStep++; renderTourStep(); }
    else finishTour(true);
  });
  window.addEventListener('resize', () => { if (tourActive) positionTourStep(); hideSelBar(); });

  document.getElementById('btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  });

  // Grammar modal listeners
  document.getElementById('gm-close').addEventListener('click', () => grammarModal.close());
  grammarModal.addEventListener('click', e => {
    if (e.target === grammarModal) { grammarModal.close(); return; }
    const tabBtn = e.target.closest('[data-gm-tab]');
    if (tabBtn) renderGrammarTab(tabBtn.dataset.gmTab);
  });

  // Phrase selection floating toolbar listeners
  document.getElementById('sel-add-phrase').addEventListener('click', () => {
    if (!pendingSelection) return;
    const { phrase, sentence } = pendingSelection;
    hideSelBar();
    window.getSelection()?.removeAllRanges();
    openVocabModal(null, { word: phrase, sentence, writingTag: false });
  });
  document.getElementById('sel-add-writing').addEventListener('click', () => {
    if (!pendingSelection) return;
    const { phrase, sentence } = pendingSelection;
    hideSelBar();
    window.getSelection()?.removeAllRanges();
    openVocabModal(null, { word: phrase, sentence, writingTag: true });
  });
  document.getElementById('sel-close').addEventListener('click', () => {
    hideSelBar();
    window.getSelection()?.removeAllRanges();
  });

  // Dismiss popovers & keyboard nav for Tour
  document.getElementById('pop-close').addEventListener('click', () => { wordPop.hidden = true; });
  document.addEventListener('keydown', e => {
    if (tourActive) {
      if (e.key === 'Escape') { e.preventDefault(); finishTour(false); }
      else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (tourStep + 1 < TOUR_STEPS.length) { tourStep++; renderTourStep(); } else finishTour(false);
      } else if (e.key === 'ArrowLeft' && tourStep > 0) {
        e.preventDefault();
        tourStep--; renderTourStep();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (!wordPop.hidden) wordPop.hidden = true;
      if (!selBar.hidden) hideSelBar();
    }
  });
  document.addEventListener('click', e => {
    if (!wordPop.hidden && !e.target.closest('#word-pop') && !e.target.closest('.tok')) wordPop.hidden = true;
    if (!selBar.hidden && !e.target.closest('#sel-bar') && !e.target.closest('.para, .lt-transcript')) hideSelBar();
  });

  document.getElementById('pop-speak-uk').addEventListener('click', () => activePopWord && speakWord(activePopWord.entry.word, 'en-GB'));
  document.getElementById('pop-speak-us').addEventListener('click', () => activePopWord && speakWord(activePopWord.entry.word, 'en-US'));
  document.getElementById('pop-collect').addEventListener('click', () => { markSop('collected'); collectWord(false); });
  document.getElementById('pop-writing').addEventListener('click', () => { markSop('collected'); collectWord(true); });

  // Vocab modal buttons & backdrop click
  document.getElementById('vm-close').addEventListener('click', () => vocabModal.close());
  document.getElementById('vm-cancel').addEventListener('click', () => vocabModal.close());
  document.getElementById('vm-save').addEventListener('click', saveVocabModal);
  vocabModal.addEventListener('click', e => { if (e.target === vocabModal) vocabModal.close(); });
  vocabModal.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); saveVocabModal(); }
  });

  mainEl.addEventListener('click', e => {
    if (view === 'listening' && window.ListeningStudio?.handleClick(e)) return;
    const btn = e.target.closest('button');
    if (btn) {
      // Library controls
      if (btn.dataset.libMode) { libMode = btn.dataset.libMode; render(); return; }
      if (btn.dataset.filterTier) { filterTier = btn.dataset.filterTier; render(); return; }
      if (btn.dataset.filterStatus) { filterStatus = btn.dataset.filterStatus; render(); return; }
      if (btn.dataset.openPassage) { if (!tourInvite.hidden) dismissInvite(); startPassage(btn.dataset.openPassage); return; }
      if (btn.dataset.openSet) {
        if (!tourInvite.hidden) dismissInvite();
        const setObj = buildExamSets().find(s => s.title === btn.dataset.openSet);
        if (setObj) startExamSet(setObj.title, setObj.passageIds, setObj.difficulty);
        return;
      }
      if (btn.dataset.randomMock) {
        const [tier, cnt, title] = btn.dataset.randomMock.split(':');
        startRandomMock(tier, Number(cnt), title);
        return;
      }
      if (btn.dataset.restartPassage) { restartPassage(btn.dataset.restartPassage); return; }
      if (btn.dataset.viewJump) { setView(btn.dataset.viewJump); return; }
      if (btn.id === 'btn-import-pack') { document.getElementById('pack-file-input').click(); return; }

      // Exam set ribbon controls
      if (btn.dataset.setIdx !== undefined && activeSet) {
        activeSet.activeIndex = Number(btn.dataset.setIdx);
        wordPop.hidden = true;
        render();
        return;
      }
      if (btn.id === 'btn-submit-set') { submitActiveSet(); return; }
      if (btn.id === 'btn-restart-set' && activeSet) { startExamSet(activeSet.title, activeSet.passageIds, activeSet.difficulty); return; }
      if (btn.id === 'btn-exit-set') { activeSet = null; setView('library'); return; }

      // Studio toolbar & SOP controls
      if (btn.id === 'btn-exam-lock') {
        examLockLookup = !examLockLookup;
        try { localStorage.setItem('reading-exam-lock-v1', examLockLookup ? '1' : '0'); } catch {}
        if (examLockLookup) { wordPop.hidden = true; hideSelBar(); }
        toast(examLockLookup ? '🔒 已开启考场锁查词：交卷前专注盲读，交卷后自动解锁' : '🔓 已关闭考场锁查词，可随时点词/划短语');
        renderKeepStudioScroll();
        return;
      }
      if (btn.id === 'btn-grammar-studio') { openGrammarModal('tense'); return; }
      if (btn.dataset.sopStep) {
        const s = Number(btn.dataset.sopStep);
        const att = currentAttempt();
        if (s === 1) { toast(att ? '✓ 已完成一刷交卷！' : '第一步：专心限时选出 5 题答案并标「稳/犹」，完成后点右下角交卷'); return; }
        if (!att) { toast('请先完成第 ① 步闭卷限时交卷，再解锁后续精读步骤'); return; }
        if (s === 2) { markSop('located'); toast('点击右栏错题/犹豫题上的「定位原文」并勾选错因标签'); renderKeepStudioScroll(); return; }
        if (s === 3) { showStudyPack = true; showTranslations = true; markSop('studied'); renderKeepStudioScroll(); toast('已为你同时展开「精读卡」与「逐段译文」'); return; }
        if (s === 4) { toast('点击原文生词或拖选多词短语，收入「生词队列」；也可在精读卡一键「+ 收词」'); return; }
        if (s === 5) { markSop('synced'); syncWithGitHub(false); return; }
      }
      if (btn.id === 'btn-toggle-trans') { showTranslations = !showTranslations; if (showTranslations) markSop('studied'); renderKeepStudioScroll(); return; }
      if (btn.id === 'btn-toggle-study') { showStudyPack = !showStudyPack; if (showStudyPack) markSop('studied'); renderKeepStudioScroll(); return; }
      if (btn.id === 'mode-lookup') { highlightMode = false; renderKeepStudioScroll(); return; }
      if (btn.id === 'mode-hl') { highlightMode = true; wordPop.hidden = true; hideSelBar(); renderKeepStudioScroll(); return; }
      if (btn.id === 'font-dec') { fontSize = Math.max(14, fontSize - 2); renderKeepStudioScroll(); return; }
      if (btn.id === 'font-inc') { fontSize = Math.min(26, fontSize + 2); renderKeepStudioScroll(); return; }
      if (btn.id === 'btn-submit-passage') { submitCurrentPassage(); return; }
      if (btn.dataset.spAddWord) {
        addWordRecord(btn.dataset.spAddWord, btn.dataset.spAddGloss || '', '', false);
        markSop('collected');
        toast(`已将「${btn.dataset.spAddWord}」加入生词队列`);
        renderKeepStudioScroll();
        return;
      }

      // Question answering & review
      if (btn.dataset.chooseQ) {
        const draft = activeDraftForCurrent();
        if (!draft || currentAttempt()) return;
        draft.answers[Number(btn.dataset.chooseQ)] = Number(btn.dataset.chooseOpt);
        renderKeepStudioScroll();
        return;
      }
      if (btn.dataset.markQ) {
        const draft = activeDraftForCurrent();
        if (!draft || currentAttempt()) return;
        const qn = Number(btn.dataset.markQ);
        draft.marks[qn] = draft.marks[qn] === btn.dataset.markVal ? '' : btn.dataset.markVal;
        renderKeepStudioScroll();
        return;
      }
      if (btn.dataset.locatePara) {
        markSop('located');
        highlightEvidencePara(btn.dataset.locatePara);
        return;
      }
      if (btn.dataset.errQ) {
        const att = currentAttempt();
        if (!att) return;
        const item = att.items.find(x => x.no === Number(btn.dataset.errQ));
        if (!item) return;
        const tag = btn.dataset.errTag;
        item.errorTags ||= [];
        const i = item.errorTags.indexOf(tag);
        if (i >= 0) item.errorTags.splice(i, 1);
        else item.errorTags.push(tag);
        att.updatedAt = Date.now();
        saveState();
        renderKeepStudioScroll();
        return;
      }

      // Mistakes Notebook Actions
      if (btn.dataset.mFilter) { mistakeFilter = btn.dataset.mFilter; render(); return; }
      if (btn.dataset.jumpEvidence) {
        const [pid, pno] = btn.dataset.jumpEvidence.split(':');
        startPassage(pid, Number(pno));
        return;
      }
      if (btn.dataset.toggleMastered) {
        const k = btn.dataset.toggleMastered;
        state.reading.masteredMistakes ||= {};
        if (state.reading.masteredMistakes[k]) delete state.reading.masteredMistakes[k];
        else state.reading.masteredMistakes[k] = Date.now();
        saveState();
        toast(state.reading.masteredMistakes[k] ? '已标为吃透，从待复盘移出' : '已撤回至待复盘错题');
        render();
        return;
      }
      if (btn.dataset.mErrAtt) {
        const att = state.reading.attempts.find(a => a.id === btn.dataset.mErrAtt);
        const item = att?.items.find(x => x.no === Number(btn.dataset.mErrQ));
        if (item) {
          const tag = btn.dataset.mErrTag;
          item.errorTags ||= [];
          const i = item.errorTags.indexOf(tag);
          if (i >= 0) item.errorTags.splice(i, 1);
          else item.errorTags.push(tag);
          att.updatedAt = Date.now();
          saveState();
          render();
        }
        return;
      }

      // Vocab Queue Manager Actions
      if (btn.dataset.vFilter) { vocabFilter = btn.dataset.vFilter; render(); return; }
      if (btn.id === 'btn-vocab-add') { openVocabModal(null); return; }
      if (btn.id === 'btn-vocab-copy-csv') {
        const lines = activeQueue().map(x => `${x.word}\t${x.gloss || ''}${x.sentence ? `\t${x.sentence}` : ''}`);
        if (!lines.length) { toast('生词队列还是空的'); return; }
        navigator.clipboard?.writeText(lines.join('\n')).then(() => toast(`已复制 ${lines.length} 条，可直接粘贴进手机「导入词表」`)).catch(() => toast('复制失败，请检查剪贴板权限'));
        return;
      }
      if (btn.id === 'btn-vocab-clear-synced') {
        if (!confirm('确认清理所有「手机已入队」的词吗？（手机里已同步的记录不受影响）')) return;
        const now = Date.now();
        for (const item of (state.vocab.collectedQueue || [])) {
          if (!item.deleted && item.consumedOnPhone) { item.deleted = true; item.updatedAt = now; }
        }
        saveState();
        toast('已清理已入队记录');
        render();
        return;
      }
      if (btn.dataset.vSpeak) { speakWord(btn.dataset.vSpeak, 'en-US'); return; }
      if (btn.dataset.vStar) {
        const item = activeQueue().find(x => SyncModel.normWord(x.word) === btn.dataset.vStar);
        if (item) { item.writingTag = !item.writingTag; item.updatedAt = Date.now(); saveState(); render(); }
        return;
      }
      if (btn.dataset.vToggleSync) {
        const item = activeQueue().find(x => SyncModel.normWord(x.word) === btn.dataset.vToggleSync);
        if (item) {
          item.consumedOnPhone = !item.consumedOnPhone;
          item.updatedAt = Date.now();
          saveState();
          toast(item.consumedOnPhone ? '已标为手机已入队' : '已重置为待同步，下次同步将再次推入手机补学队列');
          render();
        }
        return;
      }
      if (btn.dataset.vEdit) { openVocabModal(btn.dataset.vEdit); return; }
      if (btn.dataset.vDel) {
        const item = activeQueue().find(x => SyncModel.normWord(x.word) === btn.dataset.vDel);
        if (item) { item.deleted = true; item.consumedOnPhone = true; item.updatedAt = Date.now(); }
        saveState();
        toast('已从生词队列移除');
        render();
        return;
      }

      // Analytics / Sync Actions
      if (btn.id === 'btn-gh-save-sync') {
        ghConfig.repo = document.getElementById('gh-repo')?.value.trim() || '';
        ghConfig.path = document.getElementById('gh-path')?.value.trim() || 'sync/study-state.json';
        ghConfig.token = document.getElementById('gh-token')?.value.trim() || '';
        saveGh();
        syncWithGitHub(false);
        return;
      }
      if (btn.id === 'btn-run-ai') { runAiDiagnosis(); return; }
      if (btn.id === 'btn-copy-pack') {
        const payload = buildDiagnosticPayload();
        const txt = `【平板阅读 × 手机词汇联合诊断包｜${payload.examProfile.label}】\n` + JSON.stringify(payload, null, 2);
        navigator.clipboard?.writeText(txt).then(() => toast('已复制完整诊断包，可直接粘贴给 GPT/Claude/Antigravity')).catch(() => toast('浏览器阻止了剪贴板访问，请检查权限'));
        return;
      }
      if (btn.id === 'btn-export-local') {
        const blob = new Blob([JSON.stringify({ syncVersion: 1, updatedAt: Date.now(), profile: state.profile, vocab: state.vocab, reading: state.reading, listening: state.listening }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `study-sync-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        toast('已导出本地同步备份 JSON');
        return;
      }
      if (btn.id === 'btn-import-local') { document.getElementById('backup-file-input').click(); return; }
      return;
    }

    // Paragraph highlight OR word tap lookup
    const paraEl = e.target.closest('.para');
    if (paraEl && view === 'studio') {
      const pNum = Number(paraEl.dataset.para);
      if (highlightMode) {
        const list = (state.reading.highlights[currentPassageId] ||= []);
        const idx = list.indexOf(pNum);
        if (idx >= 0) list.splice(idx, 1);
        else list.push(pNum);
        saveState();
        renderKeepStudioScroll();
        return;
      }
      const tokEl = e.target.closest('.tok');
      if (tokEl) {
        // Ignore single-word click if user just dragged to select a multi-word phrase
        const selTxt = (window.getSelection()?.toString() || '').trim();
        if (/\s/.test(selTxt) && selTxt.length >= 4) return;
        if (examLockLookup && !currentAttempt()) {
          toast('🔒 考场锁查词已开启：先限时做完，交卷后自动解锁（点上方锁按钮可关闭）');
          return;
        }
        const p = passageById(currentPassageId);
        openWordPop(tokEl.dataset.tok, p?.paragraphs?.[pNum - 1] || '');
      }
    }
  });

  mainEl.addEventListener('mouseup', () => setTimeout(handleArticleSelection, 10));
  mainEl.addEventListener('touchend', () => setTimeout(handleArticleSelection, 60));
  mainEl.addEventListener('scroll', () => { if (!selBar.hidden) hideSelBar(); }, true);

  mainEl.addEventListener('input', e => {
    if (view === 'listening' && window.ListeningStudio?.handleInput(e)) return;
    if (e.target.id === 'vocab-search') {
      vocabSearch = e.target.value;
      const listEl = document.getElementById('vocab-list');
      if (listEl) listEl.innerHTML = renderVocabRows();
    } else if (e.target.id === 'lib-search') {
      libSearch = e.target.value;
      const gridEl = document.getElementById('lib-grid');
      if (gridEl) gridEl.innerHTML = renderLibraryCards();
    } else if (e.target.dataset.pnotePara) {
      const pno = Number(e.target.dataset.pnotePara);
      state.reading.paraNotes ||= {};
      state.reading.paraNotes[currentPassageId] ||= {};
      const val = e.target.value.trim();
      if (val) state.reading.paraNotes[currentPassageId][pno] = val;
      else delete state.reading.paraNotes[currentPassageId][pno];
      saveState();
    }
  });

  mainEl.addEventListener('change', e => {
    if (e.target.id === 'ana-track') {
      state.profile.examTrack = e.target.value;
      state.profile.examDate = SyncModel.EXAM_TRACKS[e.target.value]?.defaultDate || state.profile.examDate;
      state.profile.updatedAt = Date.now();
      saveState();
      render();
    } else if (e.target.id === 'ana-date') {
      state.profile.examDate = e.target.value;
      state.profile.updatedAt = Date.now();
      saveState();
      render();
    } else if (e.target.id === 'm-tier') {
      mistakeTier = e.target.value; render();
    } else if (e.target.id === 'm-type') {
      mistakeType = e.target.value; render();
    } else if (e.target.id === 'm-tag') {
      mistakeTag = e.target.value; render();
    } else if (e.target.dataset.noteQ) {
      const att = currentAttempt();
      if (!att) return;
      const item = att.items.find(x => x.no === Number(e.target.dataset.noteQ));
      if (item) { item.note = e.target.value; att.updatedAt = Date.now(); saveState(); }
    } else if (e.target.dataset.mNoteAtt) {
      const att = state.reading.attempts.find(a => a.id === e.target.dataset.mNoteAtt);
      const item = att?.items.find(x => x.no === Number(e.target.dataset.mNoteQ));
      if (item) { item.note = e.target.value; att.updatedAt = Date.now(); saveState(); }
    }
  });

  // Custom Reading Pack Import
  document.getElementById('pack-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const list = Array.isArray(parsed) ? parsed : (parsed.passages || []);
      const valid = list.filter(p => p && p.id && p.title && Array.isArray(p.paragraphs) && Array.isArray(p.questions));
      if (!valid.length) throw new Error('JSON 中未找到合法阅读篇目');
      const map = new Map((state.customPassages || []).map(p => [p.id, p]));
      for (const p of valid) map.set(p.id, p);
      state.customPassages = [...map.values()];
      saveState();
      toast(`成功导入 ${valid.length} 篇阅读题`);
      render();
    } catch (err) {
      toast('题包导入失败：' + (err.message || 'JSON 格式不正确'));
    }
  });

  // Local Backup Merge Import
  document.getElementById('backup-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const remote = JSON.parse(await file.text());
      const merged = SyncModel.mergeBundles({ profile: state.profile, vocab: state.vocab, reading: state.reading, listening: state.listening }, remote);
      state.profile = merged.profile;
      state.vocab = merged.vocab;
      state.reading = Object.assign({ attempts: [], highlights: {}, paraNotes: {}, masteredMistakes: {} }, merged.reading);
      state.listening = Object.assign({ attempts: [] }, merged.listening);
      saveState();
      toast('已合并导入本地同步 JSON');
      render();
    } catch {
      toast('备份文件格式不正确');
    }
  });

  // Expose bridge for Listening Studio module
  window.ReadingBridge = {
    state, saveState, toast, esc, openWordPop, openVocabModal, updateBadges,
    syncWithGitHub, collectedSet,
    rerender: () => render(),
    rerenderKeepScroll: () => {
      const sv = mainEl.querySelector('.scroll-view');
      const svTop = sv ? sv.scrollTop : 0;
      const ltTop = mainEl.querySelector('.lt-transcript')?.scrollTop || 0;
      render();
      const sv2 = mainEl.querySelector('.scroll-view');
      if (sv2) sv2.scrollTop = svTop;
      const lt2 = mainEl.querySelector('.lt-transcript');
      if (lt2) lt2.scrollTop = ltTop;
    },
  };
  window.ListeningStudio?.bindLocalInput();

  if (isPhone) {
    document.getElementById('phone-lock').hidden = false;
    document.getElementById('app').hidden = true;
    document.getElementById('btn-phone-listen')?.addEventListener('click', () => {
      document.body.classList.add('phone-listen-mode');
      document.getElementById('phone-lock').hidden = true;
      document.getElementById('app').hidden = false;
      document.querySelectorAll('.top-tab[data-view="library"], .top-tab[data-view="studio"], .top-tab[data-view="mistakes"]').forEach(b => {
        b.hidden = true;
      });
      setView('listening');
    });
  } else {
    render();

    // Gentle first-visit onboarding invite (Cite-Checkup style)
    try {
      if (!localStorage.getItem(TOUR_FLAG)) {
        setTimeout(() => {
          if (!tourActive && !localStorage.getItem(TOUR_FLAG)) tourInvite.hidden = false;
        }, 600);
      }
    } catch {}
  }
})();
