'use strict';

// CET-6 Listening Practice & Intensive-Listening Studio (PC / Tablet / Phone)
window.ListeningStudio = (() => {
  const LISTEN_TAGS = ['生词卡壳', '连读吞音没听出', '同义替换没反应', '预读太慢漏听', '被原词陷阱带偏'];
  const SPEEDS = [0.75, 0.85, 1.0, 1.15, 1.25];

  let subMode = 'sets'; // sets | warmups | local | practice
  let activeSetId = null;
  let activeSecIndex = 0;
  let examMode = true; // hide transcript before submit
  let forceShowTranscript = false;
  let showZhTranscript = true;
  let showPrinted2023 = false;
  let draft = null; // { secId, answers: {qno: 'A'}, marks: {qno: 'hesitant'}, struck: {'qno:A': true}, startedAt, submittedId }

  // Shared HTML5 audio element & playback controls
  const audio = new Audio();
  audio.preload = 'metadata';
  let currentSrc = '';
  let rate = 1.0;
  let loopA = null;
  let loopB = null;
  let loopSeg = null; // { t0, t1, idx }
  let activeSegIdx = -1;

  // Warmup state
  let activeWarmupId = null;
  let warmupSpeed = 'clear'; // clear | normal
  let showWarmupScript = false;

  // Local MP3 dock state
  let localFile = null; // { name, url, bookmarks: [{t, note}] }

  function B() { return window.ReadingBridge; }
  function bank() { return window.listeningBank || { sets: [], warmups: [] }; }
  function listenState() {
    const s = B().state;
    s.listening = Object.assign({ attempts: [] }, s.listening || {});
    return s.listening;
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function tokenizeEn(text) {
    const esc = B().esc;
    const col = B().collectedSet();
    return String(text || '').split(/([A-Za-z]+(?:['’-][A-Za-z]+)*)/).map((part, i) => {
      if (i % 2 === 1) {
        const norm = SyncModel.normWord(part);
        const cls = col.has(norm) ? 'tok collected' : 'tok';
        return `<span class="${cls}" data-ltok="${esc(part)}">${esc(part)}</span>`;
      }
      return esc(part);
    }).join('');
  }

  function setAudioSrc(src, autoPlay = false) {
    if (!src) return;
    if (currentSrc !== src) {
      audio.pause();
      audio.src = src;
      audio.playbackRate = rate;
      currentSrc = src;
      loopA = null;
      loopB = null;
      loopSeg = null;
      activeSegIdx = -1;
    }
    if (autoPlay) audio.play().catch(() => B().toast('请点击播放按钮开始听音'));
  }

  function stopPlayback() {
    audio.pause();
    loopSeg = null;
  }

  function latestAttempt(secId) {
    return (listenState().attempts || []).find(a => a.sectionId === secId) || null;
  }

  function setProgressStats(setObj) {
    let doneQ = 0, correctQ = 0, doneSec = 0;
    for (const sec of setObj.sections) {
      const att = latestAttempt(sec.id);
      if (att) {
        doneSec++;
        doneQ += att.total || sec.questions.length;
        correctQ += att.score || 0;
      }
    }
    return { doneSec, totalSec: setObj.sections.length, doneQ, correctQ };
  }

  function openSection(setId, secIdx = 0) {
    const setObj = bank().sets.find(s => s.id === setId);
    if (!setObj) return;
    activeSetId = setId;
    activeSecIndex = Math.max(0, Math.min(secIdx, setObj.sections.length - 1));
    subMode = 'practice';
    const sec = setObj.sections[activeSecIndex];
    const existing = latestAttempt(sec.id);
    draft = {
      secId: sec.id,
      answers: {},
      marks: {},
      struck: {},
      startedAt: Date.now(),
      submittedId: existing ? existing.id : null,
    };
    forceShowTranscript = false;
    loopA = null;
    loopB = null;
    loopSeg = null;
    setAudioSrc(sec.audio, false);
    B().rerender();
  }

  function currentSetAndSec() {
    const setObj = bank().sets.find(s => s.id === activeSetId);
    if (!setObj) return { setObj: null, sec: null };
    return { setObj, sec: setObj.sections[activeSecIndex] || setObj.sections[0] };
  }

  function activeAttempt() {
    if (!draft?.submittedId) return null;
    return (listenState().attempts || []).find(a => a.id === draft.submittedId) || null;
  }

  function submitSection() {
    const { setObj, sec } = currentSetAndSec();
    if (!sec || !draft) return;
    const unanswered = sec.questions.filter(q => !draft.answers[q.no]).length;
    if (unanswered > 0 && !confirm(`还有 ${unanswered} 题没选，确定现在交卷批改并解锁听稿吗？`)) return;
    let score = 0;
    const weight = sec.section === 'Section C' ? 14.2 : 7.1;
    const items = sec.questions.map(q => {
      const chosen = draft.answers[q.no] || '';
      const correct = chosen === q.answer;
      if (correct) score++;
      return {
        no: q.no,
        chosen,
        answer: q.answer,
        correct,
        mark: draft.marks[q.no] || '',
        errorTags: [],
        note: '',
      };
    });
    const att = {
      id: `lat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      setId: setObj.id,
      sectionId: sec.id,
      title: `${setObj.year} ${sec.title}`,
      section: sec.section,
      score,
      total: sec.questions.length,
      cetPoints: Math.round(score * weight * 10) / 10,
      maxCetPoints: Math.round(sec.questions.length * weight * 10) / 10,
      durationSec: Math.max(10, Math.round((Date.now() - draft.startedAt) / 1000)),
      submittedAt: Date.now(),
      updatedAt: Date.now(),
      items,
    };
    listenState().attempts.unshift(att);
    draft.submittedId = att.id;
    B().saveState();
    B().toast(`交卷完成：${score} / ${sec.questions.length}（约 ${att.cetPoints} / ${att.maxCetPoints} 分，听稿与逐句跟读已解锁）`);
    B().rerender();
  }

  function redoSection() {
    const { sec } = currentSetAndSec();
    if (!sec) return;
    draft = { secId: sec.id, answers: {}, marks: {}, struck: {}, startedAt: Date.now(), submittedId: null };
    forceShowTranscript = false;
    loopA = null;
    loopB = null;
    loopSeg = null;
    audio.currentTime = 0;
    B().rerender();
  }

  // ---- Audio Event Sync (live progress bar, A-B loop, Whisper active sentence tracking) ----
  function syncPlayerDom() {
    const playBtn = document.getElementById('lt-play');
    if (playBtn) playBtn.textContent = audio.paused ? '▶ 播放' : '⏸ 暂停';
    const curEl = document.getElementById('lt-cur');
    const durEl = document.getElementById('lt-dur');
    const seekEl = document.getElementById('lt-seek');
    if (curEl) curEl.textContent = fmtTime(audio.currentTime);
    if (durEl && Number.isFinite(audio.duration)) durEl.textContent = fmtTime(audio.duration);
    if (seekEl && Number.isFinite(audio.duration) && audio.duration > 0) {
      seekEl.max = String(audio.duration);
      seekEl.value = String(audio.currentTime);
    }
  }

  audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime;
    if (loopSeg && t >= loopSeg.t1) {
      audio.currentTime = loopSeg.t0;
      return;
    }
    if (loopA != null && loopB != null && loopB > loopA && t >= loopB) {
      audio.currentTime = loopA;
      return;
    }
    syncPlayerDom();

    // Live-highlight current timed Whisper segment
    if (subMode === 'practice') {
      const { sec } = currentSetAndSec();
      if (sec?.segments?.length) {
        const idx = sec.segments.findIndex(s => t >= s.t0 - 0.15 && t <= s.t1 + 0.15);
        if (idx !== activeSegIdx) {
          activeSegIdx = idx;
          document.querySelectorAll('.lt-seg.active').forEach(el => el.classList.remove('active'));
          if (idx >= 0) {
            const row = document.querySelector(`.lt-seg[data-seg-idx="${idx}"]`);
            if (row) row.classList.add('active');
          }
        }
      }
    }
  });
  audio.addEventListener('play', syncPlayerDom);
  audio.addEventListener('pause', syncPlayerDom);
  audio.addEventListener('loadedmetadata', syncPlayerDom);
  audio.addEventListener('ended', () => {
    if (loopSeg) { audio.currentTime = loopSeg.t0; audio.play().catch(() => {}); return; }
    if (loopA != null && loopB != null) { audio.currentTime = loopA; audio.play().catch(() => {}); return; }
    syncPlayerDom();
  });

  // ---- RENDERERS ----
  function renderTopSwitcher() {
    const setsCount = bank().sets.length;
    const totalQ = bank().sets.reduce((n, s) => n + s.totalQuestions, 0);
    const wCount = bank().warmups.length;
    return `
      <div class="lt-top-bar">
        <div class="mode-switch">
          <button type="button" class="mode-btn ${subMode === 'sets' ? 'active' : ''}" data-lt-mode="sets">🎧 六级真题精听（${setsCount}套·${totalQ}题）</button>
          <button type="button" class="mode-btn ${subMode === 'warmups' ? 'active' : ''}" data-lt-mode="warmups">🌱 磨耳朵入门热身（${wCount}场景）</button>
          <button type="button" class="mode-btn ${subMode === 'local' ? 'active' : ''}" data-lt-mode="local">📂 本地 MP3 精听夹</button>
        </div>
        <span class="lt-tip-pill">交卷自动解锁听稿 · 点词查义一键同步回手机词卡</span>
      </div>`;
  }

  function renderSetsHome() {
    const esc = B().esc;
    const cards = bank().sets.map(setObj => {
      const st = setProgressStats(setObj);
      const isSliced = setObj.audioMode === 'sliced';
      const secBtns = setObj.sections.map((sec, idx) => {
        const att = latestAttempt(sec.id);
        const badge = att ? `<span class="lt-sec-score">${att.score}/${att.total}</span>` : '';
        return `<button type="button" class="lt-sec-pill ${att ? 'done' : ''}" data-lt-open-set="${esc(setObj.id)}" data-lt-open-idx="${idx}">
          <span><b>${esc(sec.section)}</b> · ${esc(sec.title)}</span>${badge}
        </button>`;
      }).join('');
      return `
        <article class="lt-set-card">
          <div class="lt-set-head">
            <div>
              <div class="card-tags">
                <span class="tier-tag L2">${esc(setObj.year)}</span>
                <span class="badge-ok">${isSliced ? '✂️ 7段切片 · 逐句点播跟读' : '🎧 原卷完整录音 · 双语精析'}</span>
                ${st.doneSec ? `<span class="badge-ok">已练 ${st.doneSec}/7 段 · ${st.correctQ}/${st.doneQ}</span>` : '<span class="badge-todo">未首听</span>'}
              </div>
              <h3>${esc(setObj.title)}</h3>
            </div>
            <button type="button" class="solid-sm" data-lt-open-set="${esc(setObj.id)}" data-lt-open-idx="0">${st.doneSec ? '继续精听' : '从第 1 段开听 ▶'}</button>
          </div>
          <div class="lt-sec-grid">${secBtns}</div>
        </article>`;
    }).join('');
    return `${renderTopSwitcher()}<section class="lt-sets-wrap">${cards}</section>`;
  }

  function renderWarmups() {
    const esc = B().esc;
    const list = bank().warmups;
    const cur = list.find(w => w.id === activeWarmupId) || list[0];
    if (cur && !activeWarmupId) activeWarmupId = cur.id;
    const curAudio = cur ? (warmupSpeed === 'clear' ? cur.audioClear : cur.audioNormal) : '';
    if (curAudio && currentSrc !== curAudio) setAudioSrc(curAudio, false);

    return `${renderTopSwitcher()}
      <section class="lt-warmup-layout">
        <aside class="lt-warmup-list">
          ${list.map(w => `
            <button type="button" class="lt-warmup-item ${w.id === cur?.id ? 'active' : ''}" data-lt-warmup="${esc(w.id)}">
              <b>0${w.no} · ${esc(w.title)}</b>
              <small>${esc(w.summary.slice(0, 34))}…</small>
            </button>`).join('')}
        </aside>
        <div class="lt-warmup-stage">
          ${cur ? `
            <div class="lt-warmup-head">
              <div>
                <span class="tier-tag L1">入门磨耳朵 · 场景 0${cur.no}</span>
                <h2 style="margin:6px 0 4px">${esc(cur.title)}</h2>
                <p class="note-muted">${esc(cur.summary)}</p>
              </div>
              <div class="mode-switch">
                <button type="button" class="mode-btn ${warmupSpeed === 'clear' ? 'active' : ''}" data-lt-wspeed="clear">🐢 清晰慢速版</button>
                <button type="button" class="mode-btn ${warmupSpeed === 'normal' ? 'active' : ''}" data-lt-wspeed="normal">▶ 常速版</button>
              </div>
            </div>
            ${renderPlayerBar('磨耳朵热身 · 可变速与 A-B 复读')}
            <div class="lt-phrase-box">
              <b>常用表达：</b>${cur.phrases.map(p => `<span class="lt-phrase-chip">${esc(p)}</span>`).join('')}
            </div>
            <div style="margin-top:12px">
              <button type="button" class="ghost-sm" data-lt-act="toggle-wscript">${showWarmupScript ? '隐藏英文原文（盲听）' : '展开英文原文（点词查义/收词）'}</button>
            </div>
            ${showWarmupScript ? `<div class="lt-transcript lt-warmup-script" style="margin-top:12px"><p class="lt-en-p">${tokenizeEn(cur.script)}</p></div>` : '<p class="empty-box" style="margin-top:12px">建议先看上面中文大意直接盲听 1–2 遍，听不清再展开英文原文点词查义。</p>'}
          ` : ''}
        </div>
      </section>`;
  }

  function renderLocalDock() {
    const esc = B().esc;
    return `${renderTopSwitcher()}
      <section class="lt-local-wrap">
        <div class="lt-local-head">
          <div>
            <h2>本地 MP3 / M4A 自由精听夹</h2>
            <p class="note-muted">选择手机、平板或电脑里的任意听力/播客/复试音频（纯本地加载，不上传服务器），支持 0.75x–1.25x 变速、A–B 句段死磕循环与一键打听不清书签。</p>
          </div>
          <button type="button" class="solid-sm" data-lt-act="pick-local">📂 选择本地音频文件</button>
        </div>
        ${localFile ? `
          <div class="lt-local-card">
            <p class="lt-local-name">当前音频：<b>${esc(localFile.name)}</b></p>
            ${renderPlayerBar('本地音频自由精听')}
            <div class="lt-bm-bar">
              <button type="button" class="ghost-sm" data-lt-act="add-bm">★ 标记当前位置（${fmtTime(audio.currentTime)} 没听清）</button>
              <span class="note-muted">点书签立刻跳回前 2 秒重听</span>
            </div>
            ${localFile.bookmarks.length ? `<div class="lt-bm-list">${localFile.bookmarks.map((bm, i) => `
              <div class="lt-bm-row">
                <button type="button" class="lt-bm-jump" data-lt-jump="${Math.max(0, bm.t - 2).toFixed(2)}">▶ ${fmtTime(bm.t)}</button>
                <span class="lt-bm-note">${esc(bm.note || '听不清/连读卡点')}</span>
                <button type="button" class="mini-hide" data-lt-del-bm="${i}">✕</button>
              </div>`).join('')}</div>` : '<p class="note-muted" style="margin-top:8px">播放时遇到听不清的连读或生词，点「标记当前位置」记下来反复磨。</p>'}
          </div>
        ` : '<div class="empty-box">还没有选音频文件。点击右上角「选择本地音频文件」即可开始精听复读。</div>'}
      </section>`;
  }

  function renderPlayerBar(hint = '') {
    const abStatus = loopSeg ? `单句循环 ${fmtTime(loopSeg.t0)}–${fmtTime(loopSeg.t1)}`
      : (loopA != null && loopB != null) ? `A–B循环 ${fmtTime(loopA)}–${fmtTime(loopB)}`
      : loopA != null ? `已设 A=${fmtTime(loopA)}，点 B 开始循环` : '';
    const speedBtns = SPEEDS.map(sp => `<button type="button" class="lt-sp-btn ${rate === sp ? 'active' : ''}" data-lt-rate="${sp}">${sp}x</button>`).join('');
    return `
      <div class="lt-player">
        <div class="lt-player-row1">
          <button type="button" class="solid-sm lt-play-btn" id="lt-play" data-lt-act="play">${audio.paused ? '▶ 播放' : '⏸ 暂停'}</button>
          <button type="button" class="ghost-sm" data-lt-seek-delta="-5">-5s</button>
          <button type="button" class="ghost-sm" data-lt-seek-delta="5">+5s</button>
          <div class="lt-seek-wrap">
            <span id="lt-cur" class="lt-time">${fmtTime(audio.currentTime)}</span>
            <input type="range" id="lt-seek" class="lt-seek" min="0" max="${Number.isFinite(audio.duration) ? audio.duration : 100}" step="0.1" value="${audio.currentTime || 0}">
            <span id="lt-dur" class="lt-time">${Number.isFinite(audio.duration) ? fmtTime(audio.duration) : '--:--'}</span>
          </div>
        </div>
        <div class="lt-player-row2">
          <div class="lt-speeds"><span>语速：</span>${speedBtns}</div>
          <div class="lt-ab">
            <button type="button" class="ghost-sm ${loopA != null ? 'active' : ''}" data-lt-act="set-a">设 A 点</button>
            <button type="button" class="ghost-sm ${loopB != null ? 'active' : ''}" data-lt-act="set-b">设 B 点</button>
            ${abStatus ? `<button type="button" class="ghost-sm warn" data-lt-act="clear-ab">✕ ${abStatus}</button>` : `<span class="lt-ab-hint">${B().esc(hint)}</span>`}
          </div>
        </div>
      </div>`;
  }

  function renderPractice() {
    const esc = B().esc;
    const { setObj, sec } = currentSetAndSec();
    if (!setObj || !sec) { subMode = 'sets'; return renderSetsHome(); }
    const att = activeAttempt();
    const submitted = Boolean(att);
    const unlocked = submitted || !examMode || forceShowTranscript;

    const secNav = setObj.sections.map((s, idx) => {
      const done = Boolean(latestAttempt(s.id));
      return `<button type="button" class="lt-tab-pill ${idx === activeSecIndex ? 'active' : ''} ${done ? 'done' : ''}" data-lt-open-set="${esc(setObj.id)}" data-lt-open-idx="${idx}">
        ${s.section.replace('Section ', '')}${idx + 1} (${s.qRange[0]}–${s.qRange[1]})
      </button>`;
    }).join('');

    // Left Pane: Transcript or Exam Cheat Sheet
    let leftBody = '';
    if (!unlocked) {
      leftBody = `
        <div class="lt-exam-shield">
          <div class="lt-shield-badge">🔒 考场首听模式 · 听稿已锁定</div>
          <h3>用「4 字主题坐标 + 双题盯防」，绝不丢题号！</h3>
          <ul class="lt-shield-tips">
            <li><b>1. 先把每题压成 1 个主题坐标</b>：别试图背 16 行英文！竖向看每题 4 个选项共同聊什么（如 ①现状 → ②保密 → ③坏后果 → ④打算），用右侧 <code>✕</code> 随时划掉排除项。</li>
            <li><b>2. 双题盯防防迷路</b>：只盯「当前题 + 下一题主题词」；遇到听不懂的长难句当成铺垫放过，只要没撞到下一题主题词就稳住别慌，一撞到立刻切下一题。</li>
            <li><b>3. 交卷后 4 步去翻译精听</b>：选错/糊掉的 3–5 句，开 <code>0.85x</code> + 点 <code>🔁</code> 单句循环大声跟读 3 遍，再切回 <code>1.0x</code> 闭眼盲听。</li>
          </ul>
          <div style="margin-top:14px">
            <button type="button" class="ghost-sm" data-lt-act="force-transcript">提前展开听稿（直接精听跟读）</button>
          </div>
        </div>`;
    } else if (sec.bilingual?.length) {
      leftBody = `
        <div class="lt-tr-tools">
          <span class="badge-ok">逐段双语听稿 · 点单词查义 / 拖选短语收词</span>
          <button type="button" class="ghost-sm" data-lt-act="toggle-zh">${showZhTranscript ? '隐藏中文对照' : '显示中文对照'}</button>
        </div>
        <div class="lt-transcript">
          ${sec.bilingual.map((p, i) => `
            <div class="lt-bi-para">
              <p class="lt-en-p"><span class="p-num">${i + 1}</span>${tokenizeEn(p.en)}</p>
              ${showZhTranscript && p.zh ? `<p class="lt-zh-p">${esc(p.zh)}</p>` : ''}
            </div>`).join('')}
        </div>`;
    } else {
      const hasPrinted = Boolean(sec.printedTranscript);
      leftBody = `
        <div class="lt-tr-tools">
          <span class="badge-ok">点 [时间] 跳播该句 · 点 🔁 单句循环跟读 · 点词查义收词</span>
          ${hasPrinted ? `<button type="button" class="ghost-sm" data-lt-act="toggle-printed">${showPrinted2023 ? '切回逐句点播版' : '查看外研社官方印刷稿'}</button>` : ''}
        </div>
        <div class="lt-transcript">
          ${hasPrinted && showPrinted2023
            ? sec.printedTranscript.split('\n').map(ln => `<p class="lt-en-p">${tokenizeEn(ln)}</p>`).join('')
            : (sec.segments || []).map((seg, i) => {
                const isLoop = loopSeg && loopSeg.idx === i;
                return `<div class="lt-seg ${i === activeSegIdx ? 'active' : ''} ${isLoop ? 'looping' : ''}" data-seg-idx="${i}">
                  <button type="button" class="lt-seg-time" data-lt-jump="${seg.t0}" title="从此处播放">${fmtTime(seg.t0)}</button>
                  <button type="button" class="lt-seg-loop ${isLoop ? 'on' : ''}" data-lt-loop-seg="${i}" title="单句循环跟读">🔁</button>
                  <p class="lt-seg-text">${tokenizeEn(seg.text)}</p>
                </div>`;
              }).join('')}
        </div>`;
    }

    // Right Pane: Questions & Diagnosis
    const qCards = sec.questions.map(q => {
      const item = att?.items?.find(x => x.no === q.no);
      const chosen = submitted ? (item?.chosen || '') : (draft.answers[q.no] || '');
      const isHesitant = submitted ? (item?.mark === 'hesitant') : (draft.marks[q.no] === 'hesitant');
      const optsHtml = q.options.map(o => {
        const struck = !submitted && draft.struck[`${q.no}:${o.label}`];
        let cls = 'q-opt lt-opt';
        if (submitted) {
          if (o.label === q.answer) cls += ' is-correct';
          else if (o.label === chosen) cls += ' is-wrong';
        } else {
          if (o.label === chosen) cls += ' selected';
          if (struck) cls += ' struck';
        }
        return `<div class="lt-opt-row">
          <button type="button" class="${cls}" data-lt-q="${q.no}" data-lt-opt="${o.label}" ${submitted ? 'disabled' : ''}>
            <span class="opt-key">${o.label}</span>
            <span class="lt-opt-txt" lang="en">${esc(o.text)}${submitted && o.zh ? `<small class="lt-opt-zh">${esc(o.zh)}</small>` : ''}</span>
          </button>
          ${submitted ? '' : `<button type="button" class="lt-strike-btn ${struck ? 'on' : ''}" data-lt-strike="${q.no}:${o.label}" title="排除此项">✕</button>`}
        </div>`;
      }).join('');

      let postHtml = '';
      if (submitted) {
        const tagChips = LISTEN_TAGS.map(tg => {
          const on = (item?.errorTags || []).includes(tg);
          return `<button type="button" class="err-chip ${on ? 'active' : ''}" data-lt-tag-q="${q.no}" data-lt-tag="${esc(tg)}">${esc(tg)}</button>`;
        }).join('');
        postHtml = `
          <div class="lt-q-review ${item?.correct ? 'ok' : 'bad'}">
            <p class="lt-q-prompt"><b>【录音题干】</b><span lang="en">${esc(q.prompt)}</span></p>
            <p class="lt-q-ans"><b>标准答案：${q.answer}</b>${item?.correct ? ' · 答对了' : ` · 你选了 ${chosen || '未作答'}`}</p>
            ${q.evidence ? `<p class="lt-q-ev"><b>【原文定位】</b>${esc(q.evidence)}</p>` : ''}
            ${q.explanation ? `<p class="lt-q-expl">${esc(q.explanation).replace(/\n/g, '<br>')}</p>` : ''}
            ${!item?.correct || isHesitant ? `<div class="lt-tag-row"><span>错因复盘：</span>${tagChips}</div>` : ''}
          </div>`;
      }

      return `
        <article class="q-card lt-q-card">
          <div class="q-head">
            <span class="q-no">Q${q.no} <small class="note-muted">${sec.section === 'Section C' ? '14.2分' : '7.1分'}</small></span>
            ${submitted
              ? `<span class="${item?.correct ? 'badge-ok' : 'badge-warn'}">${item?.correct ? '✓ 正确' : '✕ 错题'}</span>`
              : `<button type="button" class="hes-btn ${isHesitant ? 'active' : ''}" data-lt-hes="${q.no}">${isHesitant ? '★ 拿不准' : '标为拿不准'}</button>`}
          </div>
          <div class="q-opts">${optsHtml}</div>
          ${postHtml}
        </article>`;
    }).join('');

    return `
      <div class="lt-practice-head">
        <div class="lt-ph-left">
          <button type="button" class="ghost-sm" data-lt-act="back-sets">← 返回听力列表</button>
          <div>
            <h2 class="lt-ph-title">${esc(setObj.year)} · ${esc(sec.title)}</h2>
            <p class="note-muted">${sec.fullTrack ? '本套为完整连续录音，拖进度条或边听边切上方段落页签即可' : '本段为独立切片录音，支持逐句点击跳播与单句循环跟读'}</p>
          </div>
        </div>
        <div class="lt-ph-right">
          <button type="button" class="ghost-sm ${examMode ? 'active' : ''}" data-lt-act="toggle-exam">${examMode ? '🔒 考场首听中' : '🔓 自由精听中'}</button>
          ${submitted ? `<button type="button" class="ghost-sm" data-lt-act="redo">再听一遍重做</button>` : `<button type="button" class="solid-sm" data-lt-act="submit">交卷批改（解锁听稿）</button>`}
        </div>
      </div>
      <div class="lt-sec-tabs">${secNav}</div>
      ${renderPlayerBar(sec.fullTrack ? '完整套卷录音' : '本段独立切片 · 可设 A-B 循环')}
      <div class="lt-studio-grid">
        <section class="lt-left-pane">${leftBody}</section>
        <section class="lt-right-pane">
          ${submitted ? `<div class="lt-score-banner"><b>本段得分：${att.score} / ${att.total}</b><span>换算约 ${att.cetPoints} / ${att.maxCetPoints} 分 · 用时 ${Math.max(1, Math.round(att.durationSec / 60))} 分钟</span>${activeSecIndex + 1 < setObj.sections.length ? `<button type="button" class="solid-sm" data-lt-open-set="${esc(setObj.id)}" data-lt-open-idx="${activeSecIndex + 1}">下一段 →</button>` : ''}</div>` : ''}
          ${qCards}
          ${!submitted ? `<div class="lt-submit-foot"><button type="button" class="solid-sm wide-btn" data-lt-act="submit">交卷批改并解锁听稿与解析</button></div>` : ''}
        </section>
      </div>`;
  }

  function render() {
    let body = '';
    if (subMode === 'practice') body = renderPractice();
    else if (subMode === 'warmups') body = renderWarmups();
    else if (subMode === 'local') body = renderLocalDock();
    else body = renderSetsHome();
    return `<div class="scroll-view lt-scroll">${body}</div>`;
  }

  function handleClick(e) {
    // Click on tokenized English word inside transcript -> reuse Reading Studio offline dictionary popover!
    const tok = e.target.closest('[data-ltok]');
    if (tok) {
      const selTxt = (window.getSelection()?.toString() || '').trim();
      if (/\s/.test(selTxt) && selTxt.length >= 4) return;
      const para = tok.closest('.lt-seg-text, .lt-en-p')?.textContent || '';
      B().openWordPop(tok.dataset.ltok, para.slice(0, 240));
      return true;
    }

    const btn = e.target.closest('button');
    if (!btn) return false;

    if (btn.dataset.ltMode) {
      stopPlayback();
      subMode = btn.dataset.ltMode;
      B().rerender();
      return true;
    }
    if (btn.dataset.ltOpenSet) {
      openSection(btn.dataset.ltOpenSet, Number(btn.dataset.ltOpenIdx || 0));
      return true;
    }
    if (btn.dataset.ltWarmup) {
      activeWarmupId = btn.dataset.ltWarmup;
      showWarmupScript = false;
      const w = bank().warmups.find(x => x.id === activeWarmupId);
      if (w) setAudioSrc(warmupSpeed === 'clear' ? w.audioClear : w.audioNormal, false);
      B().rerender();
      return true;
    }
    if (btn.dataset.ltWspeed) {
      warmupSpeed = btn.dataset.ltWspeed;
      const w = bank().warmups.find(x => x.id === activeWarmupId);
      if (w) setAudioSrc(warmupSpeed === 'clear' ? w.audioClear : w.audioNormal, true);
      B().rerender();
      return true;
    }
    if (btn.dataset.ltRate) {
      rate = Number(btn.dataset.ltRate);
      audio.playbackRate = rate;
      B().rerender();
      return true;
    }
    if (btn.dataset.ltSeekDelta) {
      audio.currentTime = Math.max(0, Math.min(audio.duration || 99999, audio.currentTime + Number(btn.dataset.ltSeekDelta)));
      syncPlayerDom();
      return true;
    }
    if (btn.dataset.ltJump !== undefined) {
      loopSeg = null;
      audio.currentTime = Number(btn.dataset.ltJump);
      audio.play().catch(() => {});
      syncPlayerDom();
      return true;
    }
    if (btn.dataset.ltLoopSeg !== undefined) {
      const idx = Number(btn.dataset.ltLoopSeg);
      const { sec } = currentSetAndSec();
      const seg = sec?.segments?.[idx];
      if (!seg) return true;
      if (loopSeg && loopSeg.idx === idx) {
        loopSeg = null;
        B().toast('已取消单句循环');
      } else {
        loopA = null;
        loopB = null;
        loopSeg = { idx, t0: Math.max(0, seg.t0 - 0.1), t1: seg.t1 + 0.15 };
        audio.currentTime = loopSeg.t0;
        audio.play().catch(() => {});
        B().toast('已开启该句单句循环跟读');
      }
      B().rerender();
      return true;
    }
    if (btn.dataset.ltQ && btn.dataset.ltOpt) {
      if (!draft || draft.submittedId) return true;
      draft.answers[Number(btn.dataset.ltQ)] = btn.dataset.ltOpt;
      B().rerenderKeepScroll();
      return true;
    }
    if (btn.dataset.ltStrike) {
      if (!draft || draft.submittedId) return true;
      draft.struck[btn.dataset.ltStrike] = !draft.struck[btn.dataset.ltStrike];
      B().rerenderKeepScroll();
      return true;
    }
    if (btn.dataset.ltHes) {
      if (!draft || draft.submittedId) return true;
      const qn = Number(btn.dataset.ltHes);
      draft.marks[qn] = draft.marks[qn] === 'hesitant' ? '' : 'hesitant';
      B().rerenderKeepScroll();
      return true;
    }
    if (btn.dataset.ltTagQ && btn.dataset.ltTag) {
      const att = activeAttempt();
      const item = att?.items?.find(x => x.no === Number(btn.dataset.ltTagQ));
      if (item) {
        item.errorTags ||= [];
        const i = item.errorTags.indexOf(btn.dataset.ltTag);
        if (i >= 0) item.errorTags.splice(i, 1);
        else item.errorTags.push(btn.dataset.ltTag);
        att.updatedAt = Date.now();
        B().saveState();
        B().rerenderKeepScroll();
      }
      return true;
    }
    if (btn.dataset.ltDelBm !== undefined && localFile) {
      localFile.bookmarks.splice(Number(btn.dataset.ltDelBm), 1);
      B().rerender();
      return true;
    }

    const act = btn.dataset.ltAct;
    if (!act) return false;
    if (act === 'back-sets') { stopPlayback(); subMode = 'sets'; B().rerender(); return true; }
    if (act === 'play') {
      if (audio.paused) audio.play().catch(() => B().toast('音频加载中或离线缺失，请稍候重试'));
      else audio.pause();
      syncPlayerDom();
      return true;
    }
    if (act === 'set-a') {
      loopSeg = null;
      loopA = audio.currentTime;
      if (loopB != null && loopB <= loopA) loopB = null;
      B().toast(`已设 A 点：${fmtTime(loopA)}`);
      B().rerender();
      return true;
    }
    if (act === 'set-b') {
      loopSeg = null;
      if (loopA == null) { B().toast('请先点「设 A 点」'); return true; }
      if (audio.currentTime <= loopA + 0.5) { B().toast('B 点需晚于 A 点'); return true; }
      loopB = audio.currentTime;
      audio.currentTime = loopA;
      audio.play().catch(() => {});
      B().toast(`A–B 循环已开启：${fmtTime(loopA)}–${fmtTime(loopB)}`);
      B().rerender();
      return true;
    }
    if (act === 'clear-ab') { loopA = null; loopB = null; loopSeg = null; B().rerender(); return true; }
    if (act === 'toggle-exam') { examMode = !examMode; B().rerender(); return true; }
    if (act === 'force-transcript') { forceShowTranscript = true; B().rerender(); return true; }
    if (act === 'toggle-zh') { showZhTranscript = !showZhTranscript; B().rerender(); return true; }
    if (act === 'toggle-printed') { showPrinted2023 = !showPrinted2023; B().rerender(); return true; }
    if (act === 'toggle-wscript') { showWarmupScript = !showWarmupScript; B().rerender(); return true; }
    if (act === 'submit') { submitSection(); return true; }
    if (act === 'redo') { redoSection(); return true; }
    if (act === 'pick-local') { document.getElementById('local-audio-input')?.click(); return true; }
    if (act === 'add-bm' && localFile) {
      localFile.bookmarks.push({ t: audio.currentTime, note: `听不清 / 连读卡点 #${localFile.bookmarks.length + 1}` });
      B().toast(`已标记 ${fmtTime(audio.currentTime)}`);
      B().rerender();
      return true;
    }
    return false;
  }

  function handleInput(e) {
    if (e.target.id === 'lt-seek') {
      audio.currentTime = Number(e.target.value);
      syncPlayerDom();
      return true;
    }
    return false;
  }

  function bindLocalInput() {
    const inp = document.getElementById('local-audio-input');
    if (!inp) return;
    inp.addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (localFile?.url) URL.revokeObjectURL(localFile.url);
      localFile = { name: f.name, url: URL.createObjectURL(f), bookmarks: [] };
      setAudioSrc(localFile.url, false);
      subMode = 'local';
      B().toast(`已载入本地音频：${f.name}`);
      B().rerender();
    });
  }

  return { render, handleClick, handleInput, stopPlayback, bindLocalInput };
})();
