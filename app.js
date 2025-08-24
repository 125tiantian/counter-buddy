// Counter Buddy (Web) - No global hotkeys; page-only demo
// Data model: Counter { id, name, count, history: [{ ts, delta }], createdAt, updatedAt }

const el = (sel) => document.querySelector(sel);
const els = (sel) => Array.from(document.querySelectorAll(sel));

const storeKey = 'counter-buddy-state-v2';
let state = {
  counters: [],
  ui: {
    panel: { x: null, y: null, w: null, h: null },
    theme: 'pink',
  }
};
let lastBumpId = null;
let lastAddedId = null;
let popoverEl = null;
let popoverHideTimer = null;
let currentPopoverFor = null; // counter id for which popover is open
let dragId = null; // currently dragged counter id
let dragImageEl = null; // custom drag preview element
let pendingFlip = null; // prev positions for FLIP animation
let pendingNameAnim = null; // { id, old, neo } for rename animation
const LONG_PRESS_MS = 320;

function isTouchDevice() {
  try {
    return (
      ('ontouchstart' in window) ||
      (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
    );
  } catch { return false; }
}

// Modal helpers: animate open/close for <dialog>
function openModal(dialog) {
  try {
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => dialog.classList.add('show'));
  } catch (e) { try { dialog.showModal(); } catch {} }
}

function closeModal(dialog) {
  const onDone = () => { try { dialog.close(); } catch {} };
  dialog.classList.remove('show');
  // wait for css transition (~180ms)
  setTimeout(onDone, 200);
}

async function confirmDialog({ title = '请确认', text = '', danger = true, okText = '确定', cancelText = '取消' } = {}) {
  return new Promise((resolve) => {
    const dlg = el('#confirm-dialog');
    el('#confirm-title').textContent = title;
    el('#confirm-text').textContent = text;
    const okBtnOld = el('#confirm-ok');
    const cancelBtnOld = el('#confirm-cancel');
    const okBtn = okBtnOld.cloneNode(true);
    const cancelBtn = cancelBtnOld.cloneNode(true);
    okBtnOld.parentNode.replaceChild(okBtn, okBtnOld);
    cancelBtnOld.parentNode.replaceChild(cancelBtn, cancelBtnOld);
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    okBtn.classList.toggle('danger', !!danger);
    okBtn.classList.toggle('primary', !danger);

    const finish = (val) => { closeModal(dlg); resolve(val); };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }, { once: true });
    openModal(dlg);
  });
}

function ensurePopover() {
  if (!popoverEl) {
    popoverEl = document.createElement('div');
    popoverEl.id = 'actions-popover';
    popoverEl.className = 'popover hidden';
    document.body.appendChild(popoverEl);
    popoverEl.addEventListener('pointerenter', () => {
      if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
    });
    popoverEl.addEventListener('pointerleave', () => scheduleHidePopover());
  }
  return popoverEl;
}

function scheduleHidePopover(delay = 160) {
  if (popoverHideTimer) clearTimeout(popoverHideTimer);
  popoverHideTimer = setTimeout(() => hidePopover(), delay);
}

function hidePopover() {
  const elp = ensurePopover();
  if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
  const alreadyHidden = elp.classList.contains('hidden');
  if (!alreadyHidden) {
    elp.classList.add('hiding');
    setTimeout(() => { elp.classList.add('hidden'); elp.classList.remove('hiding'); }, 160);
  }
  currentPopoverFor = null;
  // 关闭时也清除可能的 hover 打开定时器，避免误触再次打开
  try { clearMenuOpenTimer(); } catch {}
  // 无论浮层当前是否可见，都要清除所有三点按钮的展开标记，避免点点持续跳动
  try { document.querySelectorAll('.btn-ellipsis[aria-expanded="true"]').forEach(b => b.removeAttribute('aria-expanded')); } catch {}
}

function showPopoverForCounter(counter, anchorRect) {
  const elp = ensurePopover();
  if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
  elp.classList.remove('hiding');
  elp.innerHTML = '';
  const mk = (text, cls, handler) => {
    const b = document.createElement('button');
    b.className = 'item' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.addEventListener('click', (e) => { e.stopPropagation(); handler(); hidePopover(); });
    // Staggered animation delay to keep item-reveal consistent on mobile/desktop
    try { b.style.animationDelay = (elp.children.length * 0.05) + 's'; } catch {}
    return b;
  };
  elp.appendChild(mk('历史记录', '', () => openHistory(counter.id)));
  elp.appendChild(mk('重命名', '', () => openRename(counter.id, counter.name)));
  // Touch-friendly reorder options as DnD fallback
  if (isTouchDevice()) {
    elp.appendChild(mk('上移', '', () => moveCounterById(counter.id, -1)));
    elp.appendChild(mk('下移', '', () => moveCounterById(counter.id, +1)));
    elp.appendChild(mk('置顶', '', () => moveCounterToEdge(counter.id, 'top')));
    elp.appendChild(mk('置底', '', () => moveCounterToEdge(counter.id, 'bottom')));
  }
  elp.appendChild(mk('重置（清零并清空历史）', '', async () => {
    const ok = await confirmDialog({ title: '重置计数器', text: `确认重置 “${counter.name}” 吗？这会将计数清零并删除所有历史。`, danger: true, okText: '重置' });
    if (ok) resetCounter(counter.id);
  }));
  elp.appendChild(mk('删除', 'danger', async () => {
    const ok = await confirmDialog({ title: '删除计数器', text: `确认删除计数器 “${counter.name}” 吗？该操作不可撤销。`, danger: true, okText: '删除' });
    if (ok) removeCounter(counter.id);
  }));

  const vw = window.innerWidth, vh = window.innerHeight;
  elp.style.left = '0px'; elp.style.top = '0px';
  elp.classList.remove('hidden');
  const rect = elp.getBoundingClientRect();
  const pw = rect.width || 200;
  const ph = rect.height || 160;
  let left = Math.min(anchorRect.right, vw - pw - 8);
  let top;
  // Prefer below; if not enough space, flip to above
  const spaceBelow = vh - anchorRect.bottom;
  if (spaceBelow >= ph + 12) {
    top = Math.min(anchorRect.bottom + 6, vh - ph - 8);
  } else {
    top = Math.max(8, anchorRect.top - ph - 6);
  }
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  elp.style.left = `${left}px`;
  elp.style.top = `${top}px`;
  currentPopoverFor = counter.id;
}

// Quick note popover (app-style) for +1
let notePopoverEl = null;
let noteCommit = null;
let noteSuppressCloseUntil = 0; // ignore document clicks for a short period after opening
let noteIgnoreNextClick = 0;    // additionally ignore exactly the next click after opening (robust for long-press)
let menuOpenTimer = null; // single hover-open timer for popovers

function clearMenuOpenTimer() {
  if (menuOpenTimer) { clearTimeout(menuOpenTimer); menuOpenTimer = null; }
}

function ensureNotePopover() {
  if (!notePopoverEl) {
    notePopoverEl = document.createElement('div');
    notePopoverEl.id = 'note-popover';
    notePopoverEl.className = 'popover hidden';
    notePopoverEl.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(notePopoverEl);
  }
  return notePopoverEl;
}

function hideNotePopover() {
  const p = ensureNotePopover();
  if (p.classList.contains('hidden')) return;
  p.classList.add('hiding');
  setTimeout(() => { p.classList.add('hidden'); p.classList.remove('hiding'); }, 160);
  noteCommit = null;
}

function showQuickNote(anchorRect, onCommit, placeholder = '填写备注…') {
  // Avoid stacking with other popovers
  try { hidePopover(); } catch {}
  const p = ensureNotePopover();
  p.classList.remove('hiding');
  p.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'note-quick';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.className = 'note-input';
  const ok = document.createElement('button'); ok.textContent = '保存'; ok.className = 'primary';
  const cancel = document.createElement('button'); cancel.textContent = '取消';
  wrap.append(input, ok, cancel);
  p.appendChild(wrap);
  // position
  p.style.left = '0px'; p.style.top = '0px';
  p.classList.remove('hidden');
  const rect = p.getBoundingClientRect();
  const pw = rect.width || 260;
  const ph = rect.height || 64;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = Math.min(Math.max(anchorRect.left, 8), vw - pw - 8);
  let top = Math.min(anchorRect.bottom + 6, vh - ph - 8);
  if (top < 8) top = 8;
  p.style.left = `${left}px`;
  p.style.top = `${top}px`;
  noteCommit = onCommit;
  try {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    noteSuppressCloseUntil = now + 600; // give a wider window to cover finger-up after long-press
  } catch { noteSuppressCloseUntil = Date.now() + 600; }
  noteIgnoreNextClick = 1; // swallow the very next document click after opening
  input.focus(); try { input.select(); } catch {}
  const finish = (commit) => {
    if (commit && noteCommit) { const v = input.value.trim(); try { noteCommit(v); } catch {} }
    hideNotePopover();
  };
  ok.onclick = () => finish(true);
  cancel.onclick = () => finish(false);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
}

function moveCounterById(id, delta) {
  const idx = state.counters.findIndex(x => x.id === id);
  if (idx < 0) return;
  let dst = idx + (delta < 0 ? -1 : 1);
  dst = Math.max(0, Math.min(state.counters.length - 1, dst));
  if (dst === idx) return;
  pendingFlip = measureCardPositions();
  reorderCounters(idx, dst);
}

function moveCounterToEdge(id, edge) {
  const idx = state.counters.findIndex(x => x.id === id);
  if (idx < 0) return;
  const dst = edge === 'top' ? 0 : state.counters.length - 1;
  if (dst === idx) return;
  pendingFlip = measureCardPositions();
  reorderCounters(idx, dst);
}

function save() {
  localStorage.setItem(storeKey, JSON.stringify(state));
}

function load() {
  try {
    const raw = localStorage.getItem(storeKey);
    if (raw) state = JSON.parse(raw);
    if (!state.ui) state.ui = { panel: { x: null, y: null, w: null, h: null }, theme: 'pink' };
  } catch (e) {
    console.error('Load failed:', e);
  }
}

function uid() {
  // simple uuid-ish
  return 'id-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}

function nowISO() {
  return new Date().toISOString();
}

function timeAgo(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 10) return '刚刚';
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const day = Math.floor(h / 24);
  if (day === 1) return `昨天 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  if (day < 7) return `${day}天前`;
  return `${d.getMonth()+1}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function addCounter(name = '新的计数器') {
  const c = {
    id: uid(),
    name,
    count: 0,
    history: [],
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  state.counters.unshift(c);
  lastAddedId = c.id;
  save();
  render();
}

function removeCounter(id) {
  // Prevent ghost menu if a pending hover-open would fire after removal
  try { clearMenuOpenTimer(); hidePopover(); } catch {}
  try {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) {
      const cs = getComputedStyle(card);
      const rect = card.getBoundingClientRect();
      card.style.height = rect.height + 'px';
      card.style.marginTop = cs.marginTop;
      card.style.marginBottom = cs.marginBottom;
      card.style.paddingTop = cs.paddingTop;
      card.style.paddingBottom = cs.paddingBottom;
      void card.offsetHeight;
      card.classList.add('leaving');
      requestAnimationFrame(() => {
        card.style.height = '0px';
        card.style.marginTop = '0px';
        card.style.marginBottom = '0px';
        card.style.paddingTop = '0px';
        card.style.paddingBottom = '0px';
      });
      const finish = () => {
        card.removeEventListener('transitionend', finish);
        state.counters = state.counters.filter((c) => c.id !== id);
        save();
        render();
      };
      card.addEventListener('transitionend', finish);
      setTimeout(finish, 280);
      return;
    }
  } catch {}
  state.counters = state.counters.filter((c) => c.id !== id);
  save();
  render();
}

function renameCounter(id, name) {
  const c = state.counters.find((x) => x.id === id);
  if (!c) return;
  c.name = name || c.name;
  c.updatedAt = nowISO();
  save();
  render();
}

function addHistory(c, delta, note) {
  c.history.unshift({ ts: nowISO(), delta, note: note || '' });
  // keep last N if needed; for now, keep all
}

function inc(id, delta = +1, note) {
  const c = state.counters.find((x) => x.id === id);
  if (!c) return;
  if (delta < 0) {
    if (c.count <= 0) return; // clamp: no negative counts
    // Undo: remove the most recent +1 from history (if any), and decrement count.
    const idx = c.history.findIndex((h) => h && h.delta > 0);
    if (idx !== -1) c.history.splice(idx, 1);
    c.count = Math.max(0, c.count - 1);
    // Do NOT record -1 into history
  } else {
    c.count = Math.max(0, c.count + delta);
    addHistory(c, delta, note);
  }
  c.updatedAt = nowISO();
  lastBumpId = id;
  save();
  render();
}

function fmtTime(s) {
  const d = new Date(s);
  const pad = (n) => String(n).padStart(2, '0');
  // 显示：月、日、时、分（不含年与秒）
  return `${d.getMonth() + 1}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render() {
  const container = el('#counters');
  container.innerHTML = '';
  if (!state.counters.length) {
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.padding = '8px';
    hint.textContent = '还没有计数器，点上方 “+ 新建计数器” 创建一个。';
    container.appendChild(hint);
    // Even在空列表时也应用最小高度策略（预留三张卡的空间）
    ensureMinCounterArea(3);
    return;
  }

  for (const c of state.counters) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = c.id;

    const left = document.createElement('div');
    left.className = 'stack';
    const nameRow = document.createElement('div');
    nameRow.className = 'name-row';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = c.name;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = c.count;
    nameRow.append(name, badge);
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `更新 ${timeAgo(c.updatedAt)}`;
    left.appendChild(nameRow);
    left.appendChild(meta);

    const right = document.createElement('div');
    right.className = 'actions';
    const minus = document.createElement('button');
    minus.textContent = '−1';
    minus.title = '减少 1';
    minus.className = 'btn-minus ghost round btn-icon';
    // Use click listener to blur after action to avoid sticky focus
    minus.addEventListener('click', (e) => { inc(c.id, -1); try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} });
    const plus = document.createElement('button');
    plus.textContent = '+1';
    plus.className = 'primary round btn-icon';
    plus.title = '增加 1';
    plus.className += ' btn-plus';
    // Click to +1；长按或 Shift 点击弹“快速备注”应用内浮窗
    let holdTimer = null; let consumedByHold = false;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
    plus.addEventListener('pointerdown', (e) => {
      consumedByHold = false;
      clearHold();
      holdTimer = setTimeout(() => {
        consumedByHold = true;
        const r = plus.getBoundingClientRect();
        showQuickNote(r, (note) => inc(c.id, +1, note || ''));
      }, LONG_PRESS_MS);
    });
    plus.addEventListener('pointerup', (e) => {
      clearHold();
      if (!consumedByHold) {
        if (e.shiftKey) {
          const r = plus.getBoundingClientRect();
          showQuickNote(r, (note) => inc(c.id, +1, note || ''));
        } else {
          inc(c.id, +1);
        }
      }
      try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {}
    });
    // 再加一层 click 兜底：
    // - 若此次 click 来源于“长按”触发的快速备注，则吞掉 click，避免冒泡到 document 触发关闭
    // - 否则仅做 blur，防止粘住的选中态
    plus.addEventListener('click', (e) => {
      if (consumedByHold) { e.preventDefault(); e.stopPropagation(); return; }
      try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {}
    });
    plus.addEventListener('pointerleave', clearHold);
    // minus disabled at 0
    minus.disabled = c.count <= 0;

    // More button -> floating popover
    const more = document.createElement('button');
    more.title = '更多';
    more.className = 'btn-menu btn-ellipsis ghost round btn-icon';
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    more.appendChild(dots);
    const openMore = () => {
      const r = more.getBoundingClientRect();
      try { more.setAttribute('aria-expanded', 'true'); } catch {}
      showPopoverForCounter(c, r);
    };
    const movingIntoPopover = (e) => {
      const p = ensurePopover();
      const t = e && e.relatedTarget;
      return p && t && (t === p || p.contains(t));
    };
    more.addEventListener('pointerenter', () => {
      if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
      clearMenuOpenTimer();
      menuOpenTimer = setTimeout(() => {
        try { if (!more.isConnected || !more.matches(':hover')) return; } catch {}
        openMore();
        clearMenuOpenTimer();
      }, 150);
    });
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      clearMenuOpenTimer();
      const pe = ensurePopover();
      const isOpen = !pe.classList.contains('hidden') && currentPopoverFor === c.id;
      if (isOpen) { hidePopover(); try { more.removeAttribute('aria-expanded'); } catch {} }
      else openMore();
      // 防止移动端按钮保持焦点样式
      try { more.blur(); } catch {}
    });
    more.addEventListener('pointerleave', (e) => { clearMenuOpenTimer(); if (!movingIntoPopover(e)) scheduleHidePopover(); });
    // 确保 touch/pointer 抬起后不保留选中态
    more.addEventListener('pointerup', (e) => { try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} }, { passive: true });
    more.addEventListener('touchend', (e) => { try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} }, { passive: true });

    right.append(minus, plus, more);
    card.append(left, right);
    if (lastAddedId === c.id) {
      card.classList.add('enter');
      setTimeout(() => card.classList.remove('enter'), 300);
      lastAddedId = null;
    }
    container.appendChild(card);

    // animate bump
    if (lastBumpId === c.id) {
      badge.classList.add('flip');
      setTimeout(() => badge.classList.remove('flip'), 420);
      lastBumpId = null;
    }
    // pending rename name animation
    if (pendingNameAnim && pendingNameAnim.id === c.id) {
      try { runNameAnimation(name, pendingNameAnim.old, pendingNameAnim.neo); } catch {}
      pendingNameAnim = null;
    }
  }
  // After render, enable drag-and-drop sorting
  setupDnD();
  // After render, ensure the container is tall enough for at least N cards
  ensureMinCounterArea(3);
}

function runNameAnimation(nameEl, oldText, newText) {
  const text = String(newText || '');
  nameEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const span = document.createElement('span');
    span.className = 'char';
    span.textContent = ch;
    span.style.animationDelay = (i * 0.02) + 's';
    frag.appendChild(span);
  }
  nameEl.appendChild(frag);
  requestAnimationFrame(() => {
    nameEl.querySelectorAll('.char').forEach((s) => s.classList.add('show'));
  });
  setTimeout(() => { nameEl.textContent = newText; }, Math.max(200, text.length * 20) + 220);
}

// Drag & drop sorting (HTML5 DnD)
function setupDnD() {
  const container = el('#counters');
  const cards = Array.from(container.querySelectorAll('.card'));
  // On touch devices, disable HTML5 drag-n-drop to avoid accidental long-press drags
  // Users can use the "更多" menu (上移/下移/置顶/置底) instead on mobile.
  try {
    if (isTouchDevice()) {
      cards.forEach((card) => {
        try { card.removeAttribute('draggable'); } catch {}
        card.classList.remove('dragging', 'drag-origin', 'drop-top', 'drop-bottom');
      });
      return;
    }
  } catch {}
  cards.forEach((card) => {
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', (e) => {
      // Avoid starting drag from interactive controls
      if (e.target && e.target.closest && e.target.closest('button, input, label, select, textarea')) {
        e.preventDefault();
        return;
      }
      dragId = card.dataset.id;
      card.classList.add('dragging', 'drag-origin');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragId);
        createDragImage(card, e);
      } catch {}
    });
    card.addEventListener('dragend', () => {
      dragId = null;
      card.classList.remove('dragging', 'drag-origin');
      clearDropIndicators();
      removeDragImage();
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      const y = e.clientY;
      const isTop = y < rect.top + rect.height / 2;
      card.classList.toggle('drop-top', isTop);
      card.classList.toggle('drop-bottom', !isTop);
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drop-top', 'drop-bottom');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const overCard = card;
      const overId = overCard.dataset.id;
      const overRect = overCard.getBoundingClientRect();
      const isTop = e.clientY < overRect.top + overRect.height / 2;
      clearDropIndicators();
      if (!dragId || dragId === overId) return;
      const srcIdx = state.counters.findIndex((x) => x.id === dragId);
      const dstIdxBase = state.counters.findIndex((x) => x.id === overId);
      let dstIdx = isTop ? dstIdxBase : dstIdxBase + 1;
      if (dstIdx > srcIdx) dstIdx -= 1; // adjust for removal
      if (srcIdx < 0 || dstIdx < 0 || srcIdx === dstIdx) return;
      // FLIP: capture positions before reflow
      pendingFlip = measureCardPositions();
      reorderCounters(srcIdx, dstIdx);
    });
  });
  // allow dropping to end when over empty area
  container.addEventListener('dragover', (e) => { e.preventDefault(); });
  container.addEventListener('drop', (e) => {
    if (!dragId) return;
    const targetCard = e.target.closest && e.target.closest('.card');
    if (targetCard) return; // handled above
    const srcIdx = state.counters.findIndex((x) => x.id === dragId);
    const dstIdx = state.counters.length - 1; // move to end
    if (srcIdx < 0 || srcIdx === dstIdx) return;
    pendingFlip = measureCardPositions();
    reorderCounters(srcIdx, dstIdx);
  });
}

function clearDropIndicators() {
  els('.card.drop-top').forEach((n) => n.classList.remove('drop-top'));
  els('.card.drop-bottom').forEach((n) => n.classList.remove('drop-bottom'));
}

function measureCardPositions() {
  const map = {};
  els('#counters .card').forEach((card) => {
    const id = card.dataset.id;
    map[id] = card.getBoundingClientRect().top;
  });
  return map;
}

function applyFlipAnimations(prev) {
  const cards = els('#counters .card');
  cards.forEach((card) => {
    const id = card.dataset.id;
    if (!(id in prev)) return;
    const oldTop = prev[id];
    const newTop = card.getBoundingClientRect().top;
    const dy = oldTop - newTop;
    if (Math.abs(dy) < 1) return;
    card.style.transition = 'none';
    card.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      card.style.transition = 'transform .18s ease';
      card.style.transform = 'translateY(0)';
      setTimeout(() => { card.style.transition = ''; card.style.transform = ''; }, 220);
    });
  });
}

function reorderCounters(srcIdx, dstIdx) {
  const arr = state.counters.slice();
  const [moved] = arr.splice(srcIdx, 1);
  arr.splice(dstIdx, 0, moved);
  state.counters = arr;
  save();
  render();
  if (pendingFlip) {
    applyFlipAnimations(pendingFlip);
    pendingFlip = null;
  }
}

function createDragImage(card, e) {
  try {
    const rect = card.getBoundingClientRect();
    const clone = card.cloneNode(true);
    clone.classList.add('drag-image');
    clone.style.width = rect.width + 'px';
    clone.style.height = rect.height + 'px';
    clone.style.position = 'absolute';
    clone.style.top = '-1000px';
    clone.style.left = '-1000px';
    clone.style.pointerEvents = 'none';
    document.body.appendChild(clone);
    dragImageEl = clone;
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    e.dataTransfer.setDragImage(clone, offsetX, offsetY);
  } catch {}
}

function removeDragImage() {
  if (dragImageEl && dragImageEl.parentNode) {
    dragImageEl.parentNode.removeChild(dragImageEl);
  }
  dragImageEl = null;
}

// History modal
function openHistory(id) {
  const c = state.counters.find((x) => x.id === id);
  if (!c) return;
  const dialog = el('#history-dialog');
  const list = el('#history-list');
  const meta = el('#history-meta');
  list.innerHTML = '';
  // Header meta: name + current value, visually separated
  meta.innerHTML = '';
  const nameDiv = document.createElement('div');
  nameDiv.className = 'history-name';
  nameDiv.textContent = c.name;
  const curDiv = document.createElement('div');
  curDiv.className = 'history-current';
  const label = document.createElement('span'); label.className = 'label'; label.textContent = '当前值';
  const val = document.createElement('span'); val.className = 'value'; val.textContent = String(c.count);
  curDiv.append(label, val);
  meta.append(nameDiv, curDiv);

  if (!c.history.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '暂无记录';
    list.appendChild(li);
  } else {
    c.history.forEach((h, idx) => {
      const li = document.createElement('li');
      const left = document.createElement('div');
      left.className = 'left';
      left.textContent = fmtTime(h.ts);
      const right = document.createElement('div');
      right.className = 'right';
      const pill = document.createElement('span');
      pill.className = 'pill ' + (h.delta > 0 ? 'add' : 'sub');
      pill.textContent = h.delta > 0 ? `+${h.delta}` : `${h.delta}`;
      right.appendChild(pill);

      const appendNoteAndEdit = () => {
        // Note text
        if (h.note) {
          const noteSpan = document.createElement('span');
          noteSpan.className = 'history-note';
          noteSpan.textContent = h.note;
          right.appendChild(noteSpan);
        }
        // Edit note inline button
        const editBtn = document.createElement('button');
        editBtn.className = 'ghost';
        editBtn.textContent = h.note ? '编辑备注' : '添加备注';
        editBtn.style.marginLeft = '8px';
        const editHandler = () => {
          // Enter editing mode: hide time(left) via CSS, show editor with slide-in
          li.classList.add('editing');
          const wrap = document.createElement('div');
          wrap.className = 'note-edit fade-slide-in';
          const input = document.createElement('input');
          input.type = 'text';
          input.placeholder = '填写备注…';
          input.value = h.note || '';
          const saveBtn = document.createElement('button');
          saveBtn.className = 'primary';
          saveBtn.textContent = '保存';
          const cancelBtn = document.createElement('button');
          cancelBtn.textContent = '取消';
          wrap.append(input, saveBtn, cancelBtn);
          // swap right -> editor
          const currentRight = li.querySelector('.right');
          if (currentRight) li.replaceChild(wrap, currentRight);
          // trigger appear transition
          requestAnimationFrame(() => wrap.classList.add('show'));
          input.focus();
          try { input.select(); } catch {}

          const restoreView = () => {
            // rebuild right view
            const newRight = document.createElement('div');
            newRight.className = 'right fade-slide-in';
            const pill2 = document.createElement('span');
            pill2.className = 'pill ' + (h.delta > 0 ? 'add' : 'sub');
            pill2.textContent = h.delta > 0 ? `+${h.delta}` : `${h.delta}`;
            newRight.appendChild(pill2);
            if (h.note) {
              const noteSpan2 = document.createElement('span');
              noteSpan2.className = 'history-note';
              noteSpan2.textContent = h.note;
              newRight.appendChild(noteSpan2);
            }
            // re-add edit button
            const againBtn = document.createElement('button');
            againBtn.className = 'ghost';
            againBtn.textContent = h.note ? '编辑备注' : '添加备注';
            againBtn.style.marginLeft = '8px';
            againBtn.onclick = editHandler; // reuse handler
            newRight.appendChild(againBtn);
            li.replaceChild(newRight, wrap);
            requestAnimationFrame(() => newRight.classList.add('show'));
            li.classList.remove('editing');
          };

          const onFinish = (commit) => {
            if (commit) {
              c.history[idx].note = input.value.trim();
              h.note = c.history[idx].note; // keep local ref updated
              c.updatedAt = nowISO();
              save();
            }
            restoreView();
          };
          saveBtn.onclick = () => onFinish(true);
          cancelBtn.onclick = () => onFinish(false);
          // Submit on Enter/Escape
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onFinish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onFinish(false); }
          });
        };
        editBtn.onclick = editHandler;
        right.appendChild(editBtn);
      };

      appendNoteAndEdit();
      li.append(left, right);
      list.appendChild(li);
    });
  }

  dialog.returnValue = '';
  openModal(dialog);
}

function openRename(id, currentName) {
  const dialog = el('#rename-dialog');
  const input = el('#rename-input');
  input.value = currentName || '';
  // Prepare subtle slide-in for input and actions (unified with other UI)
  try {
    const actions = dialog.querySelector('.modal-actions');
    input.classList.remove('fade-slide-in', 'show');
    actions && actions.classList.remove('fade-slide-in', 'show');
    // Force reflow so next class addition triggers transition even on repeated opens
    // eslint-disable-next-line no-unused-expressions
    void input.offsetWidth;
    input.classList.add('fade-slide-in');
    actions && actions.classList.add('fade-slide-in');
    requestAnimationFrame(() => {
      input.classList.add('show');
      actions && actions.classList.add('show');
    });
  } catch {}
  openModal(dialog);
  input.focus();
  try { input.select(); } catch {}
  // Remove any previously attached listeners by cloning the button
  const okOld = el('#rename-ok');
  const ok = okOld.cloneNode(true);
  okOld.parentNode.replaceChild(ok, okOld);
  ok.onclick = () => {
    const v = input.value.trim();
    if (v) { pendingNameAnim = { id, old: currentName || '', neo: v }; renameCounter(id, v); }
    closeModal(dialog);
  };
  // Submit on Enter
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      ok.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeModal(dialog);
    }
  };
}

let __exportingJSON = false;
async function exportJSON() {
  if (__exportingJSON) return; // 防抖，避免重复触发两次系统窗口
  __exportingJSON = true;
  try {
    const data = JSON.stringify(state, null, 2);
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const filename = `计数伴侣-${stamp}.json`;

    const hasFSA = (typeof window !== 'undefined' && 'showSaveFilePicker' in window);
    if (hasFSA) {
      // 在支持 FSA 的环境（桌面 Chrome/Edge/PWA）不再进行任何回退，避免取消后又弹出第二个下载窗口
      try {
        const fh = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'JSON 文件', accept: { 'application/json': ['.json'] } }],
          excludeAcceptAllOption: false,
        });
        const writable = await fh.createWritable();
        await writable.write(new Blob([data], { type: 'application/json' }));
        await writable.close();
      } catch (e) {
        // 包含用户取消、权限拒绝等情况：直接结束（不做回退），这样只会出现一个系统窗口
        console.debug('SaveFilePicker closed or failed', e);
      }
      return; // FSA 路径结束，无论成功或取消，都不继续弹其它窗口
    }

    // 2) Web Share（如果支持带文件分享）
    try {
      if (navigator.canShare && window.File) {
        const file = new File([data], filename, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: '计数伴侣导出', text: filename });
          return;
        }
      }
    } catch (e) {
      console.debug('Web Share failed', e);
    }

    // 3) a[download] 触发浏览器下载（旧但通用）
    try {
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 1000);
      return;
    } catch (e) {
      console.debug('Anchor download fallback failed', e);
    }

    // 4) 最后兜底：复制到剪贴板（需要用户手动粘贴保存）
    try {
      await navigator.clipboard.writeText(data);
      alert('已将 JSON 文本复制到剪贴板，可粘贴到文件中保存。');
    } catch {
      alert('无法触发下载或复制。请打开开发者工具，手动复制导出的 JSON。');
    }
  } finally {
    __exportingJSON = false;
  }
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      if (!obj || !Array.isArray(obj.counters)) throw new Error('无效数据');
      state = obj;
      save();
      render();
    } catch (e) {
      alert('导入失败：' + e.message);
    }
  };
  reader.readAsText(file);
}

function clearAll() {
  confirmDialog({ title: '清空所有数据', text: '确认清空所有计数器与历史吗？此操作不可撤销。', danger: true, okText: '清空' })
    .then((ok) => {
      if (!ok) return;
      try { clearMenuOpenTimer(); hidePopover(); } catch {}
      const cards = Array.from(document.querySelectorAll('#counters .card'));
      if (cards.length) {
        let remaining = cards.length;
        cards.forEach((card, i) => {
          const cs = getComputedStyle(card);
          const rect = card.getBoundingClientRect();
          card.style.height = rect.height + 'px';
          card.style.marginTop = cs.marginTop;
          card.style.marginBottom = cs.marginBottom;
          card.style.paddingTop = cs.paddingTop;
          card.style.paddingBottom = cs.paddingBottom;
          void card.offsetHeight;
          card.classList.add('leaving');
          setTimeout(() => {
            card.style.height = '0px';
            card.style.marginTop = '0px';
            card.style.marginBottom = '0px';
            card.style.paddingTop = '0px';
            card.style.paddingBottom = '0px';
          }, i * 20);
          const onEnd = () => {
            card.removeEventListener('transitionend', onEnd);
            if (--remaining === 0) {
              state = { counters: [], ui: state.ui || { panel: { x: null, y: null, w: null, h: null }, theme: 'pink' } };
              save();
              render();
            }
          };
          card.addEventListener('transitionend', onEnd);
          setTimeout(onEnd, 320 + i * 20);
        });
      } else {
        state = { counters: [], ui: state.ui || { panel: { x: null, y: null, w: null, h: null }, theme: 'pink' } };
        save();
        render();
      }
    });
}

function resetCounter(id) {
  const c = state.counters.find(x => x.id === id);
  if (!c) return;
  c.count = 0;
  c.history = [];
  c.updatedAt = nowISO();
  save();
  render();
}

// Layout mode
const FULLSCREEN_LAYOUT = true; // Web/PWA: occupy the whole window

// Draggable panel
function isTauri() {
  try {
    if (typeof window !== 'undefined') {
      if ('__TAURI__' in window) return true;
      if ((navigator.userAgent || '').includes('Tauri')) return true;
      if (window.location && window.location.search && window.location.search.includes('tauri=1')) return true;
    }
  } catch {}
  return false;
}

function setupDrag() {
  const panel = el('#panel');
  const header = el('#panel-header');
  // In Tauri, let the OS move the window via drag region instead of JS moving the panel.
  if (isTauri() || FULLSCREEN_LAYOUT) {
    if (header) {
      // Disable drag region in fullscreen web layout
      if (!FULLSCREEN_LAYOUT) header.setAttribute('data-tauri-drag-region', '');
    }
    return; // skip JS drag handlers inside Tauri
  }
  let dragging = false;
  let startX = 0, startY = 0, origX = 0, origY = 0;

  const getRect = () => panel.getBoundingClientRect();

  header.addEventListener('mousedown', (e) => {
    dragging = true;
    const r = getRect();
    startX = e.clientX; startY = e.clientY;
    origX = r.left; origY = r.top;
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = `${origX + dx}px`;
    panel.style.top = `${origY + dy}px`;
    panel.style.right = 'auto';
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.userSelect = '';
    const r = panel.getBoundingClientRect();
    state.ui.panel.x = r.left;
    state.ui.panel.y = r.top;
    save();
  });
}

function setupUI() {
  el('#btn-add').addEventListener('click', () => addCounter());
  el('#file-import').addEventListener('change', (e) => {
    try {
      const target = e && e.target ? e.target : null;
      const f = target && target.files ? target.files[0] : null;
      if (f) importJSON(f);
      if (target) target.value = '';
    } catch {}
  });
  el('#btn-clear').addEventListener('click', clearAll);
  el('#history-close').addEventListener('click', () => closeModal(el('#history-dialog')));
  el('#rename-close').addEventListener('click', () => closeModal(el('#rename-dialog')));
  // Animate Esc/backdrop dismiss
  const histDlg = el('#history-dialog');
  const renDlg = el('#rename-dialog');
  if (histDlg) histDlg.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(histDlg); });
  if (renDlg) renDlg.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(renDlg); });

  // Opacity: only meaningful in desktop shell (floating panel). In web/PWA we hide it.
  const opacityEl = el('#opacity');
  const opacityWrap = opacityEl ? opacityEl.closest('.opacity-label') : null;
  if (FULLSCREEN_LAYOUT) {
    if (opacityWrap) opacityWrap.style.display = 'none';
    // Ensure no residual opacity is applied in fullscreen layout
    el('#panel').style.opacity = '1';
  } else if (opacityEl) {
    opacityEl.addEventListener('input', (e) => {
      const v = Number(e.target.value) / 100;
      el('#panel').style.opacity = String(v);
    });
  }

  // Theme toggle button: cycles pink -> mint -> sky; label always shows current theme
  const themeBtn = el('#theme-toggle');
  const themes = ['pink','mint','sky'];
  let current = (state.ui && state.ui.theme) ? state.ui.theme : 'pink';
  applyTheme(current);
  if (themeBtn) {
    const label = (t) => ({pink:'主题·粉', mint:'主题·薄荷', sky:'主题·蓝'})[t] || '主题';
    themeBtn.textContent = label(current);
    const cycle = () => {
      const idx = themes.indexOf(current);
      current = themes[(idx + 1) % themes.length];
      state.ui.theme = current;
      applyTheme(current);
      save();
      themeBtn.textContent = label(current);
    };
    themeBtn.addEventListener('click', cycle);
  }

  // Click outside closes floating popover
  document.addEventListener('click', () => hidePopover());
  document.addEventListener('click', (e) => {
    try {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (now < noteSuppressCloseUntil) return;
    } catch {}
    if (noteIgnoreNextClick > 0) { noteIgnoreNextClick -= 1; return; }
    hideNotePopover();
  });
  // Avoid sticky :focus styles on buttons after tap/click
  const blurActiveButton = () => {
    try {
      const ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON') { ae.blur(); }
    } catch {}
  };
  document.addEventListener('pointerup', blurActiveButton, { passive: true });
  document.addEventListener('mouseup', blurActiveButton, { passive: true });
  document.addEventListener('touchend', blurActiveButton, { passive: true });
  
  // 为触屏提供“弹一下的阴影”反馈：按下加类，抬手稍后移除
  (function setupTapFlash(){
    const isTouchLike = (e) => {
      try {
        if (e && typeof e.pointerType === 'string') return e.pointerType !== 'mouse';
      } catch {}
      return isTouchDevice(); // 回退
    };
    const addFlash = (btn) => { try { if (!btn.disabled) btn.classList.add('tap-flash'); } catch {} };
    const clearFlash = () => {
      try {
        const list = document.querySelectorAll('button.tap-flash');
        // 稍微延长停留时间，让动画不要“一闪而过”
        list.forEach((b) => setTimeout(() => { try { b.classList.remove('tap-flash'); } catch {} }, 360));
      } catch {}
    };
    document.addEventListener('pointerdown', (e) => {
      if (!isTouchLike(e)) return; // 只对触控/笔生效，避免影响桌面 hover
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (btn) addFlash(btn);
    }, true);
    document.addEventListener('pointerup', (e) => { if (isTouchLike(e)) clearFlash(); }, true);
    document.addEventListener('pointercancel', (e) => { if (isTouchLike(e)) clearFlash(); }, true);
    // 兜底：某些老设备没有 Pointer 事件
    document.addEventListener('touchend', clearFlash, true);
    document.addEventListener('mouseup', clearFlash, true);
    document.addEventListener('dragend', clearFlash, true);
  })();
  document.addEventListener('click', (e) => {
    try {
      const btn = (e.target && e.target.closest) ? e.target.closest('button') : null;
      if (btn) btn.blur();
    } catch {}
  });

  // On touch devices, immediately defocus any button as soon as it receives focus
  // This prevents the persistent "selected" state after tapping buttons on mobile.
  try {
    if (isTouchDevice()) {
      document.addEventListener('focusin', (e) => {
        try {
          const t = e.target;
          if (t && t.tagName === 'BUTTON') {
            // Defer a tick to avoid interfering with click handlers
            setTimeout(() => { try { t.blur(); } catch {} }, 0);
          }
        } catch {}
      }, true);
    }
  } catch {}

  // Global header menu (导入/导出)
  const gbtn = el('#btn-global-menu');
  if (gbtn) {
    const openMenu = () => {
      const r = gbtn.getBoundingClientRect();
      showGlobalMenu(r);
    };
    const movingIntoPopover = (e) => {
      const p = ensurePopover();
      const t = e && e.relatedTarget;
      return p && t && (t === p || p.contains(t));
    };
    gbtn.addEventListener('pointerenter', () => {
      if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
      clearMenuOpenTimer();
      menuOpenTimer = setTimeout(() => {
        try { if (!gbtn.isConnected || !gbtn.matches(':hover')) return; } catch {}
        openMenu();
        clearMenuOpenTimer();
      }, 150);
    });
    gbtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearMenuOpenTimer();
      const pe = ensurePopover();
      const isOpen = !pe.classList.contains('hidden') && currentPopoverFor === 'global';
      if (isOpen) { hidePopover(); try { gbtn.removeAttribute('aria-expanded'); } catch {} }
      else { try { gbtn.setAttribute('aria-expanded','true'); } catch {}; openMenu(); }
      // 防止移动端按钮保持焦点样式
      try { gbtn.blur(); } catch {}
    });
    gbtn.addEventListener('pointerleave', (e) => { clearMenuOpenTimer(); if (!movingIntoPopover(e)) scheduleHidePopover(); });
    // 确保 touch/pointer 抬起后不保留选中态
    gbtn.addEventListener('pointerup', (e) => { try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} }, { passive: true });
    gbtn.addEventListener('touchend', (e) => { try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} }, { passive: true });
  }
}

function closeAllMenus() { /* replaced by hidePopover */ }

function applyPanelRect() {
  const panel = el('#panel');
  const rect = (state.ui && state.ui.panel) ? state.ui.panel : {};
  if (!FULLSCREEN_LAYOUT) {
    if (rect.w) panel.style.width = rect.w + 'px';
    if (rect.h) panel.style.height = rect.h + 'px';
    if (rect.x != null && rect.y != null) {
      panel.style.left = rect.x + 'px';
      panel.style.top = rect.y + 'px';
      panel.style.right = 'auto';
    }
  }
}

function setupResizeObserver() {
  const panel = el('#panel');
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        // Persist width and height only when floating layout is used
        if (!FULLSCREEN_LAYOUT) {
          state.ui.panel.w = Math.round(cr.width);
          state.ui.panel.h = Math.round(cr.height);
          save();
        }
        updateCompactClass();
      }
    });
    ro.observe(panel);
  } else {
    // Fallback for older browsers: update layout hints on window resize
    window.addEventListener('resize', updateCompactClass);
  }
  updateCompactClass();
}

function updateCompactClass() {
  const panel = el('#panel');
  const w = panel.getBoundingClientRect().width;
  if (w < 320) panel.classList.add('compact');
  else panel.classList.remove('compact');
  // Re-apply min height constraints on resize
  ensureMinCounterArea(3);
}

function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
}

function init() {
  load();
  try { if (isTouchDevice()) document.documentElement.classList.add('no-hover'); } catch {}
  setupUI();
  setupDrag();
  applyPanelRect();
  setupResizeObserver();
  setupKeyboardAvoidance();
  render();
}

document.addEventListener('DOMContentLoaded', init);

// Ensure counters area can show at least N cards without scroll (subject to viewport)
function ensureMinCounterArea(minCards = 3) {
  try {
    const container = el('#counters');
    if (!container) return;
    // Remove runtime min-height enforcement; let flex layout control height to eliminate bottom blanks
    container.style.minHeight = '';
  } catch {}
}

// Keyboard avoidance on mobile: keep focused input just above the keyboard
function isChromeMobile() {
  try {
    const ua = navigator.userAgent || '';
    return /Chrome\//.test(ua) && /(Mobile|Android)/i.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);
  } catch { return false; }
}

function setupKeyboardAvoidance() {
  const vv = window.visualViewport;
  let activeInput = null;
  let originalTransforms = new Map(); // element -> original transform string
  const BASE_GAP = 12; // base gap above the keyboard
  const EXTRA_BAR = isChromeMobile() ? 28 : 0; // extra lift for Chrome mobile which adds accessory bar
  const GAP = BASE_GAP + EXTRA_BAR;

  const isTextField = (node) => node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') && !node.disabled && node.type !== 'hidden';
  const getContainerFor = (node) => {
    if (!node) return null;
    const notePop = node.closest && node.closest('#note-popover');
    if (notePop) return notePop; // special: fixed popover with its own positioning
    const modal = node.closest && node.closest('.modal');
    if (modal) return modal;
    return document.querySelector('#panel');
  };

  const storeTransform = (node) => {
    if (!originalTransforms.has(node)) originalTransforms.set(node, node.style.transform || '');
  };

  const restoreTransforms = () => {
    // Restore any moved elements
    for (const [node, tr] of originalTransforms.entries()) {
      try { node.style.transform = tr; node.classList.remove('kb-avoid'); } catch {}
    }
    originalTransforms.clear();
    // For note popover, also restore its top if we tweaked it
    try {
      const pop = document.querySelector('#note-popover');
      if (pop && pop.dataset.kbAdjusted === '1') {
        delete pop.dataset.kbAdjusted;
        // Re-run its own placement if still open by nudging hide/show cycle lightly
        // Otherwise just clear inline shift; top/left were set when opened already
      }
    } catch {}
  };

  const adjust = () => {
    if (!vv || !activeInput || !document.contains(activeInput)) { restoreTransforms(); return; }
    const container = getContainerFor(activeInput);
    if (!container) { restoreTransforms(); return; }
    // Compute overlap relative to the visual viewport (accounts for offsetTop on iOS)
    const r = activeInput.getBoundingClientRect();
    const vvTop = vv.offsetTop || 0;
    const vvHeight = vv.height || window.innerHeight;
    const bottomRelToVV = r.bottom - vvTop;
    const overlap = bottomRelToVV + GAP - vvHeight;
    const shift = Math.max(0, Math.ceil(overlap));

    if (container.id === 'note-popover') {
      // Reposition the fixed popover upward just enough
      const popRect = container.getBoundingClientRect();
      const maxTop = (vvTop + vvHeight) - popRect.height - GAP;
      let curTop = parseFloat(container.style.top || '0');
      // style.top is in px relative to layout viewport; adjust by delta needed
      // Compute desired top so that input sits above keyboard
      const desiredTop = Math.min(popRect.top, maxTop);
      const delta = desiredTop - popRect.top; // negative or zero
      if (delta !== 0) {
        storeTransform(container); // we won't use transform, but keep API consistent
        container.classList.add('kb-avoid');
        container.style.top = `${Math.max(8, curTop + delta)}px`;
        container.dataset.kbAdjusted = '1';
      }
      return;
    }

    // For dialogs or the main panel, translate vertically by -shift
    if (shift > 0) {
      storeTransform(container);
      const base = originalTransforms.get(container) || '';
      container.classList.add('kb-avoid');
      container.style.transform = `${base ? base + ' ' : ''}translateY(${-shift}px)`;
    } else {
      restoreTransforms();
    }
  };

  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (isTextField(t)) {
      activeInput = t;
      // Slight delay allows UA to finish viewport resize
      setTimeout(adjust, 0);
    }
  });
  document.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t === activeInput) {
      activeInput = null;
      setTimeout(restoreTransforms, 50);
    }
  });
  if (vv) {
    vv.addEventListener('resize', adjust);
    vv.addEventListener('scroll', adjust);
  } else {
    window.addEventListener('resize', adjust);
    window.addEventListener('scroll', adjust, true);
  }
}

// Global menu popover content
function showGlobalMenu(anchorRect) {
  const elp = ensurePopover();
  if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
  elp.classList.remove('hiding');
  elp.innerHTML = '';
  const mk = (text, cls, handler) => {
    const b = document.createElement('button');
    b.className = 'item' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.addEventListener('click', (e) => { e.stopPropagation(); handler(); hidePopover(); });
    try { b.style.animationDelay = (elp.children.length * 0.05) + 's'; } catch {}
    return b;
  };
  elp.appendChild(mk('导入 JSON…', '', () => {
    const inp = el('#file-import');
    if (inp) inp.click();
  }));
  elp.appendChild(mk('导出 JSON', '', () => exportJSON()));
  elp.appendChild(mk('强制刷新（更新缓存）', '', () => forceUpdateAssets()));

  const vw = window.innerWidth, vh = window.innerHeight;
  elp.style.left = '0px'; elp.style.top = '0px';
  elp.classList.remove('hidden');
  const rect = elp.getBoundingClientRect();
  const pw = rect.width || 200;
  const ph = rect.height || 120;
  let left = Math.min(anchorRect.right, vw - pw - 8);
  let top;
  const spaceBelow = vh - anchorRect.bottom;
  if (spaceBelow >= ph + 12) {
    top = Math.min(anchorRect.bottom + 6, vh - ph - 8);
  } else {
    top = Math.max(8, anchorRect.top - ph - 6);
  }
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  elp.style.left = `${left}px`;
  elp.style.top = `${top}px`;
  currentPopoverFor = 'global';
}

// 手动强制更新：清理缓存、唤醒新 SW 并重载
async function forceUpdateAssets() {
  const CACHE_PREFIX = 'counter-buddy-web-';
  const clearCaches = async () => {
    try {
      if (!('caches' in window)) return;
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
    } catch {}
  };
  const hardReload = () => {
    try {
      const url = new URL(location.href);
      url.searchParams.set('v', String(Date.now()));
      location.replace(url.toString());
    } catch { location.reload(); }
  };
  try {
    await clearCaches();
    if (!('serviceWorker' in navigator)) { hardReload(); return; }
    let reloaded = false;
    const onCtrl = () => { if (reloaded) return; reloaded = true; hardReload(); };
    try { navigator.serviceWorker.addEventListener('controllerchange', onCtrl, { once: true }); } catch {}
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { hardReload(); return; }
    try { reg.active && reg.active.postMessage({ type: 'CLEAR_CACHES' }); } catch {}
    try { reg.waiting && reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch {}
    try { reg.installing && reg.installing.postMessage({ type: 'SKIP_WAITING' }); } catch {}
    try { await reg.update(); } catch {}
    // 若 1s 内没有触发 controllerchange，则强制重载
    setTimeout(() => { if (!reloaded) hardReload(); }, 1000);
  } catch { hardReload(); }
}
