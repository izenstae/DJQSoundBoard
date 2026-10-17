// DJ Q Soundboard
// Built-in sounds come from sounds/sounds.json; sounds added in the browser
// are stored in IndexedDB so they survive reloads and work offline.

const KEYS = '1234567890QWERTYUIOPASDFGHJKLZXCVBNM'.split('');
const COLORS = ['#ff3b6b', '#00d1ff', '#ffd400', '#3ddc84', '#b44dff', '#ff8a00', '#5b6cff', '#ff4dd2'];
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4)$/i;
const MASTER_KEY = 'djq.master';

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');

// ---------------------------------------------------------------------------
// Storage (IndexedDB, with an in-memory fallback if it's unavailable)
// ---------------------------------------------------------------------------

const store = await openStore();

async function openStore() {
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('djq-soundboard', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('pads', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const run = (mode, fn) => new Promise((resolve, reject) => {
      const tx = db.transaction('pads', mode);
      const req = fn(tx.objectStore('pads'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    navigator.storage?.persist?.().catch(() => {});
    return {
      persistent: true,
      all: () => run('readonly', (s) => s.getAll()),
      put: (rec) => run('readwrite', (s) => s.put(rec)),
      del: (id) => run('readwrite', (s) => s.delete(id)),
    };
  } catch (err) {
    console.warn('IndexedDB unavailable, sounds will not be saved', err);
    const mem = new Map();
    return {
      persistent: false,
      all: async () => [...mem.values()],
      put: async (rec) => { mem.set(rec.id, rec); },
      del: async (id) => { mem.delete(id); },
    };
  }
}

// What gets saved for each pad. Built-in pads only save overrides (no audio).
function toRecord(pad) {
  const rec = {
    id: pad.id,
    builtin: pad.builtin,
    name: pad.name,
    color: pad.color,
    volume: pad.volume,
    loop: pad.loop,
    mode: pad.mode,
    order: pad.order,
    hidden: !!pad.hidden,
  };
  if (!pad.builtin) {
    rec.data = pad.data;
    rec.type = pad.type;
  }
  return rec;
}

const save = (pad) => store.put(toRecord(pad)).catch((err) => {
  console.error(err);
  toast('Could not save — browser storage may be full');
});

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

const AudioCtx = window.AudioContext || window.webkitAudioContext;
const ctx = new AudioCtx({ latencyHint: 'interactive' });
const master = ctx.createGain();
master.connect(ctx.destination);

// iOS: let sounds play even when the ringer/silent switch is on (Safari 17+).
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }

const buffers = new Map(); // pad id -> Promise<AudioBuffer>
const playing = new Map(); // pad id -> { src, gain, start, dur, loop }

function decode(arrayBuffer) {
  // decodeAudioData detaches its input, so always hand it a copy.
  const copy = arrayBuffer.slice(0);
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(copy, resolve, reject);
    if (p && p.catch) p.catch(reject);
  });
}

function loadBuffer(pad) {
  if (!buffers.has(pad.id)) {
    const p = (async () => {
      const data = pad.builtin
        ? await fetch(pad.url).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          })
        : pad.data;
      const buf = await decode(data);
      pad.duration = buf.duration;
      return buf;
    })();
    buffers.set(pad.id, p);
    p.catch(() => buffers.delete(pad.id));
  }
  return buffers.get(pad.id);
}

function unlockAudio() {
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
}

async function trigger(pad) {
  unlockAudio();
  flash(pad.id);

  if (playing.has(pad.id)) {
    stopPad(pad.id, 0.012);
    if (pad.mode === 'toggle') return;
  }

  let buf;
  try {
    buf = await loadBuffer(pad);
  } catch (err) {
    // Web Audio couldn't decode it; let the browser's own player have a go.
    console.warn(`Web Audio couldn't decode "${pad.name}", using fallback player`, err);
    playWithElement(pad);
    return;
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = pad.loop;
  const gain = ctx.createGain();
  gain.gain.value = pad.volume;
  src.connect(gain).connect(master);

  const entry = { src, gain, start: ctx.currentTime, dur: buf.duration, loop: pad.loop };
  src.onended = () => {
    if (playing.get(pad.id) === entry) {
      playing.delete(pad.id);
      setPlayingClass(pad.id, false);
    }
  };
  playing.set(pad.id, entry);
  src.start();
  setPlayingClass(pad.id, true);
  tick();
}

// Fallback for files Web Audio can't decode: a plain <audio> element.
function playWithElement(pad) {
  if (!pad.builtin && !pad.blobUrl) pad.blobUrl = URL.createObjectURL(new Blob([pad.data], { type: pad.type }));
  const el = new Audio(pad.builtin ? pad.url : pad.blobUrl);
  el.loop = pad.loop;
  el.volume = Math.min(1, pad.volume * master.gain.value);
  const entry = { el, start: ctx.currentTime, dur: Infinity, loop: pad.loop };
  const done = () => {
    if (playing.get(pad.id) === entry) {
      playing.delete(pad.id);
      setPlayingClass(pad.id, false);
    }
  };
  el.addEventListener('loadedmetadata', () => { entry.dur = el.duration; });
  el.addEventListener('ended', done);
  el.addEventListener('error', () => {
    done();
    toast(`Couldn't play "${pad.name}" — try re-saving it as MP3`);
  });
  playing.set(pad.id, entry);
  setPlayingClass(pad.id, true);
  el.play().then(tick).catch((err) => {
    if (err.name === 'AbortError') return; // stopped before it started
    console.error(err);
    el.dispatchEvent(new Event('error'));
  });
}

function stopPad(id, fade = 0.04) {
  const entry = playing.get(id);
  if (!entry) return;
  playing.delete(id);
  setPlayingClass(id, false);
  if (entry.el) {
    entry.el.pause();
    return;
  }
  const t = ctx.currentTime;
  const g = entry.gain.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(0, t + fade);
  try { entry.src.stop(t + fade + 0.005); } catch { /* already stopped */ }
}

function stopAll() {
  for (const id of [...playing.keys()]) stopPad(id, 0.06);
}

// Progress bars
let rafId = 0;
function tick() {
  if (rafId) return;
  const step = () => {
    rafId = 0;
    for (const [id, e] of playing) {
      const el = padEl(id);
      if (!el) continue;
      const t = e.el ? e.el.currentTime : ctx.currentTime - e.start;
      const p = e.loop ? (t % e.dur) / e.dur : Math.min(1, t / e.dur);
      el.style.setProperty('--p', p.toFixed(4));
    }
    if (playing.size) rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pads = [];
let editing = false;

async function loadPads() {
  const records = await store.all().catch(() => []);
  const byId = new Map(records.map((r) => [r.id, r]));

  let manifest = [];
  try {
    const res = await fetch('sounds/sounds.json', { cache: 'no-cache' });
    if (res.ok) manifest = await res.json();
  } catch (err) {
    console.warn('No built-in sound list', err);
  }

  const list = [];
  manifest.forEach((entry, i) => {
    if (!entry || !entry.file) return;
    const id = `builtin:${entry.file}`;
    const saved = byId.get(id) || {};
    list.push({
      id,
      builtin: true,
      url: `sounds/${encodeURIComponent(entry.file)}`,
      name: saved.name ?? entry.name ?? entry.file,
      color: saved.color ?? entry.color ?? COLORS[i % COLORS.length],
      volume: saved.volume ?? entry.volume ?? 1,
      loop: saved.loop ?? !!entry.loop,
      mode: saved.mode ?? entry.mode ?? 'restart',
      order: saved.order ?? i,
      hidden: !!saved.hidden,
    });
  });

  for (const r of records) {
    if (r.builtin) continue;
    list.push({ ...r, builtin: false, hidden: false });
  }

  list.sort((a, b) => a.order - b.order);
  pads = list;
  renormalizeOrder();
}

function renormalizeOrder() {
  pads.forEach((p, i) => { p.order = i; });
}

const visiblePads = () => pads.filter((p) => !p.hidden);
const findPad = (id) => pads.find((p) => p.id === id);
const padEl = (id) => grid.querySelector(`[data-id="${CSS.escape(id)}"]`);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtTime(sec) {
  if (!isFinite(sec)) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function render() {
  const vis = visiblePads();
  grid.replaceChildren(...vis.map((pad, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pad';
    el.dataset.id = pad.id;
    el.style.setProperty('--c', pad.color);
    if (playing.has(pad.id)) el.classList.add('playing');

    const key = KEYS[i];
    const badges = [];
    if (pad.loop) badges.push('<span title="Loops">&#8635;</span>');
    if (pad.mode === 'toggle') badges.push('<span title="Tap again to stop">&#9199;</span>');
    if (!pad.builtin) badges.push('<span title="Added on this device">&#128190;</span>');

    el.innerHTML = `
      ${key ? `<span class="key">${key}</span>` : ''}
      <span class="badges">${badges.join('')}</span>
      <span class="name"></span>
      <span class="meta">${fmtTime(pad.duration)}</span>
      <span class="bar"></span>`;
    el.querySelector('.name').textContent = pad.name;
    el.setAttribute('aria-label', `${pad.name}${key ? `, key ${key}` : ''}`);

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'pad-rename';
    rename.dataset.renameId = pad.id;
    rename.title = `Rename "${pad.name}"`;
    rename.setAttribute('aria-label', `Rename ${pad.name}`);
    rename.innerHTML = '&#9998;';

    const wrap = document.createElement('div');
    wrap.className = 'pad-wrap';
    wrap.append(el, rename);
    return wrap;
  }));
  $('#empty').hidden = vis.length > 0;
}

function setPlayingClass(id, on) {
  const el = padEl(id);
  if (!el) return;
  el.classList.toggle('playing', on);
  if (!on) el.style.setProperty('--p', 0);
}

function flash(id) {
  const el = padEl(id);
  if (!el) return;
  el.classList.add('hit');
  setTimeout(() => el.classList.remove('hit'), 90);
}

// Decode everything up front so the first hit has no delay, then fill in durations.
function preloadAll() {
  for (const pad of pads) {
    if (pad.hidden) continue;
    loadBuffer(pad).then(() => {
      const meta = padEl(pad.id)?.querySelector('.meta');
      if (meta) meta.textContent = fmtTime(pad.duration);
    }).catch((err) => {
      // Not fatal: trigger() falls back to an <audio> element for this pad.
      console.warn(`Web Audio couldn't preload ${pad.name}`, err);
    });
  }
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------------------
// Adding sounds
// ---------------------------------------------------------------------------

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('audio/') || f.type === 'video/mp4' || AUDIO_EXT.test(f.name));
  if (!files.length) {
    toast('Those don\'t look like audio files');
    return;
  }
  unlockAudio();
  let added = 0;
  for (const file of files) {
    try {
      const data = await file.arrayBuffer();
      const buf = await decode(data); // make sure the browser can actually play it
      const pad = {
        id: newId(),
        builtin: false,
        name: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 40) || 'Sound',
        color: COLORS[pads.length % COLORS.length],
        volume: 1,
        loop: false,
        mode: 'restart',
        order: pads.length,
        data,
        type: file.type,
        duration: buf.duration,
      };
      pads.push(pad);
      buffers.set(pad.id, Promise.resolve(buf));
      await save(pad);
      added++;
    } catch (err) {
      console.error(err);
      toast(`Couldn't read "${file.name}" — try MP3 or WAV`);
    }
  }
  if (added) {
    render();
    toast(`Added ${added} sound${added > 1 ? 's' : ''}${store.persistent ? '' : ' (won\'t be saved in this browser)'}`);
  }
}

$('#addBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

// Drag & drop anywhere on the page
const overlay = $('#dropOverlay');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  addFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------------------
// Playing: pointer + keyboard
// ---------------------------------------------------------------------------

grid.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || editing) return;
  const el = e.target.closest('.pad');
  if (!el) return;
  e.preventDefault(); // fire on press, not release
  const pad = findPad(el.dataset.id);
  if (pad) trigger(pad);
});

grid.addEventListener('click', (e) => {
  const renameBtn = e.target.closest('.pad-rename');
  if (renameBtn) {
    const pad = findPad(renameBtn.dataset.renameId);
    if (pad) openEditor(pad, { rename: true });
    return;
  }
  const el = e.target.closest('.pad');
  if (!el) return;
  const pad = findPad(el.dataset.id);
  if (!pad) return;
  if (editing) openEditor(pad);
  else if (e.detail === 0) trigger(pad); // keyboard activation (Enter on a focused pad)
});

grid.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.pad')) e.preventDefault();
});

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const dialogOpen = () => !!document.querySelector('dialog[open]');

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (dialogOpen() || typing(document.activeElement)) return;

  if (e.code === 'Space' || e.key === 'Escape') {
    e.preventDefault();
    unlockAudio();
    stopAll();
    return;
  }
  if (e.repeat) return;
  const idx = KEYS.indexOf(e.key.toUpperCase());
  if (idx === -1) return;
  const pad = visiblePads()[idx];
  if (!pad) return;
  e.preventDefault();
  if (editing) openEditor(pad);
  else trigger(pad);
});
// Stop Space from also "clicking" whatever button has focus.
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !dialogOpen() && !typing(document.activeElement)) e.preventDefault();
});

$('#stopAll').addEventListener('click', () => { unlockAudio(); stopAll(); });

const masterInput = $('#master');
try {
  const saved = parseFloat(localStorage.getItem(MASTER_KEY));
  if (!Number.isNaN(saved)) masterInput.value = saved;
} catch { /* storage blocked */ }
master.gain.value = parseFloat(masterInput.value);
masterInput.addEventListener('input', () => {
  master.gain.setTargetAtTime(parseFloat(masterInput.value), ctx.currentTime, 0.01);
  try { localStorage.setItem(MASTER_KEY, masterInput.value); } catch { /* storage blocked */ }
});

// Browsers only allow audio after a user gesture; resume on the first one.
['pointerdown', 'keydown', 'touchstart'].forEach((t) => window.addEventListener(t, unlockAudio, { once: true, capture: true }));

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

const editToggle = $('#editToggle');
editToggle.addEventListener('click', () => setEditing(!editing));

function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  editToggle.setAttribute('aria-pressed', String(on));
  editToggle.textContent = on ? 'Done' : 'Edit';
  $('#editBanner').hidden = !on;
}

const dlg = $('#editDialog');
const f = {
  name: $('#fName'),
  colors: $('#fColors'),
  vol: $('#fVol'),
  volOut: $('#fVolOut'),
  mode: $('#fMode'),
  loop: $('#fLoop'),
};
let current = null;

function openEditor(pad, { rename = false } = {}) {
  current = pad;
  f.name.value = pad.name;
  f.vol.value = pad.volume;
  f.volOut.textContent = `${Math.round(pad.volume * 100)}%`;
  f.mode.value = pad.mode;
  f.loop.checked = pad.loop;
  $('#fDelete').textContent = pad.builtin ? 'Hide' : 'Delete';
  renderSwatches();
  dlg.showModal();
  if (rename) {
    f.name.focus();
    f.name.select();
  }
}

function renderSwatches() {
  const swatches = COLORS.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c);
    b.setAttribute('aria-checked', String(c.toLowerCase() === current.color.toLowerCase()));
    b.addEventListener('click', () => updateCurrent({ color: c }, true));
    return b;
  });
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.title = 'Custom color';
  custom.value = current.color;
  custom.addEventListener('input', () => updateCurrent({ color: custom.value }));
  f.colors.replaceChildren(...swatches, custom);
}

function updateCurrent(changes, rerenderSwatches = false) {
  if (!current) return;
  Object.assign(current, changes);
  const entry = playing.get(current.id);
  if (entry) {
    if ('volume' in changes) {
      if (entry.el) entry.el.volume = Math.min(1, current.volume * master.gain.value);
      else entry.gain.gain.setTargetAtTime(current.volume, ctx.currentTime, 0.01);
    }
    if ('loop' in changes) {
      (entry.el || entry.src).loop = current.loop;
      entry.loop = current.loop;
    }
  }
  render();
  if (rerenderSwatches) renderSwatches();
}

f.name.addEventListener('input', () => updateCurrent({ name: f.name.value.trim() || 'Untitled' }));
f.vol.addEventListener('input', () => {
  const v = parseFloat(f.vol.value);
  f.volOut.textContent = `${Math.round(v * 100)}%`;
  updateCurrent({ volume: v });
});
f.mode.addEventListener('change', () => updateCurrent({ mode: f.mode.value }));
f.loop.addEventListener('change', () => updateCurrent({ loop: f.loop.checked }));

$('#fPreview').addEventListener('click', () => current && trigger(current));

function move(delta) {
  const vis = visiblePads();
  const i = vis.indexOf(current);
  const other = vis[i + delta];
  if (!other) return;
  const a = pads.indexOf(current);
  const b = pads.indexOf(other);
  [pads[a], pads[b]] = [pads[b], pads[a]];
  renormalizeOrder();
  render();
  pads.forEach(save);
}
$('#fLeft').addEventListener('click', () => move(-1));
$('#fRight').addEventListener('click', () => move(1));

$('#fDelete').addEventListener('click', async () => {
  const pad = current;
  if (!pad) return;
  if (pad.builtin) {
    pad.hidden = true;
    await save(pad);
    toast(`Hid "${pad.name}" — bring it back from the ⋯ menu`);
  } else {
    if (!confirm(`Delete "${pad.name}" from this device?`)) return;
    pads = pads.filter((p) => p !== pad);
    buffers.delete(pad.id);
    await store.del(pad.id);
    toast(`Deleted "${pad.name}"`);
  }
  stopPad(pad.id);
  current = null;
  dlg.close();
  render();
});

dlg.addEventListener('close', () => {
  if (current) save(current);
  current = null;
});

// ---------------------------------------------------------------------------
// Menu: backup / restore / unhide
// ---------------------------------------------------------------------------

const menu = $('#menuDialog');
$('#menuBtn').addEventListener('click', () => menu.showModal());

function bufToDataUrl(buf, type) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([buf], { type: type || 'application/octet-stream' }));
  });
}

$('#backupBtn').addEventListener('click', async () => {
  const out = [];
  for (const pad of pads) {
    const rec = toRecord(pad);
    if (!pad.builtin) rec.data = await bufToDataUrl(pad.data, pad.type);
    out.push(rec);
  }
  const blob = new Blob([JSON.stringify({ app: 'djq-soundboard', version: 1, pads: out })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `djq-soundboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#restoreBtn').addEventListener('click', () => $('#restoreInput').click());
$('#restoreInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (json.app !== 'djq-soundboard' || !Array.isArray(json.pads)) throw new Error('Not a soundboard backup');
    let count = 0;
    for (const rec of json.pads) {
      if (!rec || typeof rec.id !== 'string') continue;
      if (!rec.builtin) {
        if (typeof rec.data !== 'string' || !rec.data.startsWith('data:')) continue;
        rec.data = await fetch(rec.data).then((r) => r.arrayBuffer());
        count++;
      }
      await store.put(rec);
    }
    stopAll();
    buffers.clear();
    await loadPads();
    render();
    preloadAll();
    menu.close();
    toast(`Restored ${count} sound${count === 1 ? '' : 's'}`);
  } catch (err) {
    console.error(err);
    toast('That file isn\'t a valid backup');
  }
});

$('#unhideBtn').addEventListener('click', async () => {
  const hidden = pads.filter((p) => p.hidden);
  for (const pad of hidden) {
    pad.hidden = false;
    await save(pad);
  }
  render();
  preloadAll();
  toast(hidden.length ? `Restored ${hidden.length} built-in sound${hidden.length > 1 ? 's' : ''}` : 'Nothing is hidden');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

await loadPads();
render();
preloadAll();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline mode unavailable', err));
}
