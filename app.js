// Counter Buddy (Web) - No global hotkeys; page-only demo
// Data model: Counter { id, name, count, history: [{ ts, delta }], createdAt, updatedAt }

const el = (sel) => document.querySelector(sel);
const els = (sel) => Array.from(document.querySelectorAll(sel));

const storeKey = 'counter-buddy-state-v2';
const syncStoreKey = 'counter-buddy-sync-v1'; // { binId, apiKey, auto? }
const syncMetaKey = 'counter-buddy-sync-meta-v1'; // { etag?, lastSyncedAt?, pending?:bool }
const SCHEMA_VERSION = 1; // 云端数据的简单版本号（用于未来迁移）
let __syncTimer = null; // 本地变更后的节流定时器
let __syncPending = false; // 是否有待同步任务（离线或被节流）
let __syncInFlight = false; // 是否正在同步，避免并发
let __autoSyncInstalled = false; // 避免重复安装事件监听
let state = {
  counters: [],
  // 删除墓碑列表：[{ id, deletedAt }]
  tombstones: [],
  // 历史记录删除墓碑：[{ counterId, ts, deletedAt }]
  historyTombstones: [],
  ui: {
    panel: { x: null, y: null, w: null, h: null },
    theme: 'pink',
    // 本地视图偏好：是否查看“已归档”
    showArchived: false,
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
const TAP_FLASH_MS = 180; // 固定的点击反馈时长（ms），统一所有按钮

// --- 同步（JSONBin）最小配置工具 ---
function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(syncStoreKey);
    if (!raw) return { binId: '', apiKey: '', auto: false };
    const obj = JSON.parse(raw);
    return { binId: String(obj.binId || ''), apiKey: String(obj.apiKey || ''), auto: !!obj.auto };
  } catch { return { binId: '', apiKey: '', auto: false }; }
}

function saveSyncConfig(cfg) {
  try { localStorage.setItem(syncStoreKey, JSON.stringify({ binId: cfg.binId || '', apiKey: cfg.apiKey || '', auto: !!cfg.auto })); } catch {}
}

function loadSyncMeta() {
  try { const raw = localStorage.getItem(syncMetaKey); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function saveSyncMeta(next) {
  try { localStorage.setItem(syncMetaKey, JSON.stringify(next || {})); } catch {}
}

// 云状态图标：根据同步状态更新右上角云图标的颜色/动画
function setCloudIndicator(state = 'idle', tip = '') {
  // state 可选：idle | syncing | ok | offline | error
  try {
    const btn = document.getElementById('cloud-indicator');
    if (!btn) return;
    const prev = btn.getAttribute('data-state') || 'idle';
    // 不使用浏览器默认 tooltip，改用应用内 popover
    try { btn.removeAttribute('title'); } catch {}
    if (tip) { try { btn.setAttribute('data-tip', tip); } catch {} }
    const label = { idle: '云同步状态', syncing: '正在同步…', ok: '已同步', offline: '离线', error: '同步失败' }[state] || '云同步状态';
    btn.setAttribute('aria-label', label);
    // 平滑停转：若从旋转切到静止（任意目标态），做一次减速到整圈的过渡，然后再切换目标态
    if (prev === 'syncing' && state !== 'syncing') {
      const svg = btn.querySelector('svg');
      if (!svg) { btn.setAttribute('data-state', state); return; }
      if (btn.dataset.spinoutRunning === '1') { btn.setAttribute('data-state', state); return; }
      try {
        btn.dataset.spinoutRunning = '1';
        // 读取当前角度
        const cs = getComputedStyle(svg);
        const m = cs.transform || 'none';
        let angle = 0;
        if (m && m !== 'none') {
          // 支持 matrix(...) 与 matrix3d(...)
          const m2d = m.match(/matrix\(([^)]+)\)/);
          const m3d = m.match(/matrix3d\(([^)]+)\)/);
          if (m2d && m2d[1]) {
            const p = m2d[1].split(',').map(Number);
            const a = p[0], b = p[1];
            angle = Math.atan2(b, a);
          } else if (m3d && m3d[1]) {
            const p = m3d[1].split(',').map(Number);
            const a = p[0];      // m11
            const b = p[1];      // m12
            angle = Math.atan2(b, a);
          } else {
            angle = 0;
          }
        }
        // 目标角度：补到下一整圈（避免 360° 与 0° 等价导致 transition 不触发，减去一个微小量）
        const twoPi = Math.PI * 2;
        const rem = ((angle % twoPi) + twoPi) % twoPi;
        const EPS = 0.02; // ~1.1°
        const target = angle - rem + (twoPi - EPS);
        // 若 angle 与 target 有效，使用过渡；否则走 CSS 回退
        if (isFinite(angle) && isFinite(target)) {
          // 停止 CSS 无限旋转，改用过渡
          svg.style.animation = 'none';
          svg.style.transform = `rotate(${angle}rad)`;
          // 下一帧启动减速过渡
          requestAnimationFrame(() => {
            svg.style.transition = 'transform .8s cubic-bezier(.05,.6,.1,1)';
            svg.style.transform = `rotate(${target}rad)`;
            let done = false;
            const finalize = () => {
              if (done) return; done = true;
              try { svg.style.transition = ''; svg.style.transform = ''; svg.style.animation = ''; } catch {}
              btn.setAttribute('data-state', state);
              delete btn.dataset.spinoutRunning;
            };
            const onDone = () => { svg.removeEventListener('transitionend', onDone); finalize(); };
            svg.addEventListener('transitionend', onDone, { once: true });
            // 兜底：若某些环境下 transitionend 未触发，定时完成
            setTimeout(finalize, 900);
          });
          return; // 直接返回，等过渡回调里再设置目标态
        } else {
          // 回退：用 CSS 一次性减速动画（不依赖读取当前角度）
          try {
            btn.setAttribute('data-spinout', '1');
            const onEnd = () => {
              svg.removeEventListener('animationend', onEnd);
              try { btn.removeAttribute('data-spinout'); } catch {}
              btn.setAttribute('data-state', state);
              delete btn.dataset.spinoutRunning;
            };
            svg.addEventListener('animationend', onEnd, { once: true });
            // 兜底：
            setTimeout(onEnd, 900);
            return;
          } catch {}
        }
      } catch {
        // 回退：若异常，直接切换
        btn.setAttribute('data-state', state);
        delete btn.dataset.spinoutRunning;
        return;
      }
    }
    // 非停转场景：直接切换
    btn.setAttribute('data-state', state);
  } catch {}
}

async function testJsonBinConnection(binId, apiKey) {
  const makeResult = (ok, msg) => ({ ok, message: msg });
  try {
    if (!binId || !apiKey) return makeResult(false, '请先填写 Bin ID 与 API Key');
    const url = `https://api.jsonbin.io/v3/b/${encodeURIComponent(binId)}/latest`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Master-Key': apiKey,
        'X-Bin-Meta': 'false'
      }
    });
    if (res.ok) {
      // 不解析内容，成功即可
      return makeResult(true, '连接成功，可读取该 Bin');
    }
    if (res.status === 404) return makeResult(false, '未找到该 Bin（Bin ID 可能不对，或该 Bin 尚未创建）');
    if (res.status === 401 || res.status === 403) return makeResult(false, '密钥无效或无权限，请检查 API Key');
    if (res.status === 429) return makeResult(false, '请求过于频繁，请稍后再试');
    return makeResult(false, `连接失败：HTTP ${res.status}`);
  } catch (e) {
    return makeResult(false, '网络错误或跨域受限，稍后再试');
  }
}

// --- 基本的云同步能力（最小可用版） ---
// 说明：
// 1) 仅覆盖策略：
//    - 上传：直接用本地 state 覆盖云端 Bin 内容（PUT /b/:id）。
//    - 拉取：直接用云端 Bin 覆盖本地 state（GET /b/:id/latest）。
//    - 不做合并与并发控制（后续可扩展 ETag/版本检查与按 updatedAt 合并）。
// 2) 安全提醒：操作前弹确认框，避免误覆盖。
// 3) 依赖“同步设置”中的 Bin ID 与 API Key；未配置时提示并打开设置对话框。

function ensureSyncConfigOrPrompt() {
  // 检查是否已配置 Bin ID 与 API Key；否则提示并打开设置对话框
  const cfg = loadSyncConfig();
  if (!cfg.binId || !cfg.apiKey) {
    try { openSyncDialog(); } catch {}
    return null;
  }
  return cfg;
}

async function pushToJsonBin() {
  const cfg = ensureSyncConfigOrPrompt();
  if (!cfg) return false;
  const ok = await confirmDialog({
    title: '上传到云端',
    text: '将用本地数据覆盖云端 Bin 内容，确认上传吗？',
    danger: false,
    okText: '上传',
    cancelText: '取消'
  });
  if (!ok) return false;
  try {
    setCloudIndicator('syncing', '正在上传到云端…');
    const url = `https://api.jsonbin.io/v3/b/${encodeURIComponent(cfg.binId)}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Master-Key': cfg.apiKey,
    };
    // 如果之前有 ETag，附带条件写入，避免覆盖远端新数据（若冲突会返回 412/409）
    try {
      const meta = loadSyncMeta();
      if (meta && meta.etag) headers['If-Match'] = meta.etag;
    } catch {}
    // 确保 order 连续化
    try { state.counters.forEach((c, i) => { if (c) c.order = i; }); } catch {}
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      // 直接存 state（保持与导出结构一致）
      body: JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION, updatedAt: nowISO(), rev: (Number(state.rev||0) + 1) }),
    });
    if (res.ok) {
      try {
        const etag = res.headers && res.headers.get && res.headers.get('ETag');
        const meta = loadSyncMeta(); meta.etag = etag || meta.etag || null; meta.lastSyncedAt = nowISO(); meta.pending = false; saveSyncMeta(meta);
      } catch {}
      setCloudIndicator('ok', '上传成功');
      return true;
    } else if (res.status === 404) {
      setCloudIndicator('error', '未找到 Bin');
    } else if (res.status === 412 || res.status === 409) {
      setCloudIndicator('error', '云端已更新');
    } else if (res.status === 401 || res.status === 403) {
      setCloudIndicator('error', '密钥无效或无权限');
    } else if (res.status === 429) {
      setCloudIndicator('error', '请求过于频繁');
    } else {
      setCloudIndicator('error', '上传失败');
    }
    return false;
  } catch (e) {
    setCloudIndicator('error', '网络或跨域错误');
    return false;
  }
}

async function pullFromJsonBin() {
  const cfg = ensureSyncConfigOrPrompt();
  if (!cfg) return false;
  const ok = await confirmDialog({
    title: '从云拉取',
    text: '将用云端数据覆盖本地数据，确认拉取吗？',
    danger: true,
    okText: '拉取',
    cancelText: '取消'
  });
  if (!ok) return false;
  try {
    setCloudIndicator('syncing', '正在从云端拉取…');
    const url = `https://api.jsonbin.io/v3/b/${encodeURIComponent(cfg.binId)}/latest`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Master-Key': cfg.apiKey,
        // 只取记录内容，不要元数据，方便直接作为 state 使用
        'X-Bin-Meta': 'false',
      }
    });
    if (!res.ok) {
      if (res.status === 404) { setCloudIndicator('error', '未找到 Bin'); }
      else if (res.status === 401 || res.status === 403) { setCloudIndicator('error', '密钥无效或无权限'); }
      else if (res.status === 429) { setCloudIndicator('error', '请求过于频繁'); }
      else { setCloudIndicator('error', '拉取失败'); }
      return false;
    }
    const obj = await res.json();
    // 记录新的 ETag（用于下次条件写入）
    try { const etag = res.headers && res.headers.get && res.headers.get('ETag'); const meta = loadSyncMeta(); meta.etag = etag || meta.etag || null; meta.lastSyncedAt = nowISO(); meta.pending = false; saveSyncMeta(meta); } catch {}
    // 基本校验：应包含 counters 数组（结构与本地存储一致）
    if (!obj || !Array.isArray(obj.counters)) { setCloudIndicator('error', '数据格式不正确'); return false; }
    // 若云端包含排序字段，则按 order 排序；否则保持原顺序
    try {
      const arr = Array.isArray(obj.counters) ? obj.counters.slice() : [];
      const hasOrder = arr.some(c => Number.isFinite(c && c.order));
      if (hasOrder) {
        arr.sort((a, b) => (Number.isFinite(a.order) ? a.order : 1e9) - (Number.isFinite(b.order) ? b.order : 1e9));
        arr.forEach((c, i) => { try { c.order = i; } catch {} });
      } else {
        arr.forEach((c, i) => { try { c.order = i; } catch {} });
      }
      // 标准化缺失字段（如 archived）
      arr.forEach((c) => { if (c && typeof c.archived !== 'boolean') c.archived = false; });
      state = { ...obj, counters: arr };
      // 应用远端主题（覆盖拉取场景应该反映 UI 偏好）
      try { if (state && state.ui && state.ui.theme) applyTheme(state.ui.theme); } catch {}
    } catch { state = obj; }
    save();
    render();
    setCloudIndicator('ok', '已从云端拉取');
    return true;
  } catch (e) {
    setCloudIndicator('error', '网络或跨域错误');
    return false;
  }
}

// --- 合并同步（双向）---
// 流程：
// 1) 读取云端最新；若 404（不存在）可提示直接上传本地以创建。
// 2) 将本地与云端按 id 合并：
//    - 同 id：以 updatedAt 较新的为“基准”，名称/计数取基准；
//      历史按“时间戳 ts 为唯一键”去重合并：同一 ts 若两端内容不同，采用“基准侧”的项覆盖；结果按时间倒序。
//      createdAt 取较早者；updatedAt 取较晚者。
//    - 仅一侧存在：直接保留。
//    - ui：以本地为准（主题/布局属于设备偏好）。
// 3) 将合并结果写回云端（PUT）并保存到本地，刷新界面。

function deepEqual(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function normalizeStateLike(obj) {
  // 简单校验：必须是对象，含 counters 数组；ui 可选
  if (!obj || typeof obj !== 'object') return null;
  const arr = Array.isArray(obj.counters) ? obj.counters : null;
  if (!arr) return null;
  // 复制一份，避免直接引用导致后续改动影响原对象
  const tombs = Array.isArray(obj.tombstones) ? obj.tombstones.slice() : [];
  const hTombs = Array.isArray(obj.historyTombstones) ? obj.historyTombstones.slice() : [];
  return { counters: arr.slice(), ui: obj.ui ? { ...obj.ui } : undefined, tombstones: tombs, historyTombstones: hTombs };
}

function mergeStates(local, remote, opts = {}) {
  const l = normalizeStateLike(local) || { counters: [], ui: {} };
  const r = normalizeStateLike(remote) || { counters: [], ui: {} };
  // 合并 tombstones：对同一 id 取较新的 deletedAt
  const tMap = new Map();
  const addT = (t) => {
    if (!t || !t.id) return;
    const prev = tMap.get(t.id);
    const ta = Date.parse(t.deletedAt || 0) || 0;
    const pb = prev ? (Date.parse(prev.deletedAt || 0) || 0) : -1;
    if (!prev || ta > pb) tMap.set(t.id, { id: t.id, deletedAt: t.deletedAt });
  };
  (Array.isArray(l.tombstones) ? l.tombstones : []).forEach(addT);
  (Array.isArray(r.tombstones) ? r.tombstones : []).forEach(addT);
  const isDeletedAfter = (id, ts) => {
    const t = tMap.get(id); if (!t) return false;
    const td = Date.parse(t.deletedAt || 0) || 0;
    const ct = Date.parse(ts || 0) || 0;
    return td > ct; // 删除时间更晚则认为被删除
  };
  // 合并历史记录墓碑：key=counterId|ts，取较新 deletedAt
  const hTMap = new Map();
  const keyOf = (cid, ts) => `${cid}|${ts}`;
  const addHT = (ht) => {
    if (!ht || !ht.counterId || !ht.ts) return;
    const key = keyOf(ht.counterId, ht.ts);
    const prev = hTMap.get(key);
    const ta = Date.parse(ht.deletedAt || 0) || 0;
    const pb = prev ? (Date.parse(prev.deletedAt || 0) || 0) : -1;
    if (!prev || ta > pb) hTMap.set(key, { counterId: ht.counterId, ts: ht.ts, deletedAt: ht.deletedAt });
  };
  (Array.isArray(l.historyTombstones) ? l.historyTombstones : []).forEach(addHT);
  (Array.isArray(r.historyTombstones) ? r.historyTombstones : []).forEach(addHT);
  const rMap = new Map(r.counters.map((c) => [c.id, c]));
  const used = new Set();
  const out = [];
  // 仅一侧存在的计数器：按历史墓碑过滤其历史，并据此重算计数
  const filterHistory = (c) => {
    try {
      const cid = c.id;
      const list = Array.isArray(c.history) ? c.history : [];
      const outHist = [];
      for (const h of list) {
        try { if (!hTMap.get(keyOf(cid, h.ts))) outHist.push({ ts: h.ts, delta: h.delta, note: h.note || '' }); } catch {}
      }
      const newCount = outHist.reduce((s, h) => s + (Number(h.delta) > 0 ? Number(h.delta) : 0), 0);
      const copy = { ...c, history: outHist, count: newCount };
      if (typeof copy.archived !== 'boolean') copy.archived = !!c.archived;
      return copy;
    } catch { return { ...c }; }
  };
  // 合并同 id 的计数器
  for (const lc of l.counters) {
    const rc = rMap.get(lc.id);
    if (!rc) {
      // 仅本地存在：若 tombstone 晚于其更新时间，则不保留（已删除）
      if (!isDeletedAfter(lc.id, lc.updatedAt)) out.push(filterHistory(lc));
      continue;
    }
    used.add(lc.id);
    // 选更新更晚的一侧作为基准
    const lt = Date.parse(lc.updatedAt || 0) || 0;
    const rt = Date.parse(rc.updatedAt || 0) || 0;
    // 若存在 tombstone 且删除时间晚于双方最新一次更新，则删除胜出：不合并该计数器
    const latestUpdate = Math.max(lt, rt);
    if (isDeletedAfter(lc.id, latestUpdate)) {
      continue;
    }
    const base = lt >= rt ? lc : rc;
    const other = lt >= rt ? rc : lc;
    // 历史合并去重：以 ts 为唯一键；基准侧优先覆盖
    const cid = lc.id;
    const histByTs = new Map();
    const pushList = (list) => {
      const arr = Array.isArray(list) ? list : [];
      for (const h of arr) {
        try {
          // Tombstone for this (counterId, ts) wins: skip
          if (hTMap.get(keyOf(cid, h.ts))) continue;
          // First writer wins per pass order; since我们先推入“基准侧”，其值将保留
          if (!histByTs.has(h.ts)) {
            histByTs.set(h.ts, { ts: h.ts, delta: h.delta, note: h.note || '' });
          }
        } catch {}
      }
    };
    // 先基准侧，再另一侧（保证同 ts 时以基准侧为准）
    pushList(base.history);
    pushList(other.history);
    const hist = Array.from(histByTs.values());
    // 时间倒序
    hist.sort((a, b) => (Date.parse(b.ts || 0) || 0) - (Date.parse(a.ts || 0) || 0));
    // 按合并后的历史重算计数（仅统计正增量），避免删除历史后计数被远端较大值“拉回”
    const newCount = hist.reduce((s, h) => s + (Number(h.delta) > 0 ? Number(h.delta) : 0), 0);
    const merged = {
      id: base.id,
      name: base.name,
      count: newCount,
      history: hist,
      createdAt: (Date.parse(lc.createdAt || 0) || 0) <= (Date.parse(rc.createdAt || 0) || 0) ? (lc.createdAt || rc.createdAt) : (rc.createdAt || lc.createdAt),
      updatedAt: (lt >= rt ? lc.updatedAt : rc.updatedAt) || new Date().toISOString(),
      // 同步排列顺序：若双方存在，取基准侧；否则取另一侧；最后统一整理
      order: (Number.isFinite(base.order) ? base.order : (Number.isFinite(other.order) ? other.order : NaN)),
      archived: !!base.archived,
    };
    out.push(merged);
  }
  // 加入仅存在于云端的计数器
  for (const rc of r.counters) {
    if (used.has(rc.id)) continue;
    // 若 tombstone 晚于其更新时间，则不保留（被删除）
    if (!isDeletedAfter(rc.id, rc.updatedAt)) out.push(filterHistory(rc));
  }
  // 统一排序策略：以“发起本次同步的一侧”为准（最后一次同步赢）
  // 默认偏好本地顺序（本设备触发同步）。
  const prefer = (opts && opts.order === 'remote') ? 'remote' : 'local';
  const buildOrderMap = (arr) => {
    const m = new Map();
    try {
      if (Array.isArray(arr)) {
        // 根据 order 字段排序；无则按当前索引
        const withIdx = arr.map((c, i) => ({ id: c && c.id, idx: Number.isFinite(c && c.order) ? Number(c.order) : i }))
          .filter(x => x && x.id);
        withIdx.sort((a, b) => a.idx - b.idx);
        withIdx.forEach((x, i2) => m.set(x.id, i2));
      }
    } catch {}
    return m;
  };
  const lOrder = buildOrderMap(l.counters);
  const rOrder = buildOrderMap(r.counters);
  out.sort((a, b) => {
    const aid = a.id, bid = b.id;
    const liA = lOrder.has(aid) ? lOrder.get(aid) : Infinity;
    const liB = lOrder.has(bid) ? lOrder.get(bid) : Infinity;
    const riA = rOrder.has(aid) ? rOrder.get(aid) : Infinity;
    const riB = rOrder.has(bid) ? rOrder.get(bid) : Infinity;
    if (prefer === 'local') {
      const tierA = Number.isFinite(liA) ? 0 : 1;
      const tierB = Number.isFinite(liB) ? 0 : 1;
      if (tierA !== tierB) return tierA - tierB;
      const aPos = (tierA === 0) ? liA : riA;
      const bPos = (tierB === 0) ? liB : riB;
      return (aPos - bPos);
    } else {
      const tierA = Number.isFinite(riA) ? 0 : 1;
      const tierB = Number.isFinite(riB) ? 0 : 1;
      if (tierA !== tierB) return tierA - tierB;
      const aPos = (tierA === 0) ? riA : liA;
      const bPos = (tierB === 0) ? riB : liB;
      return (aPos - bPos);
    }
  });
  out.forEach((c, i) => { try { c.order = i; } catch {} });
  // ui 取本地（设备偏好）
  const ui = l.ui || r.ui || { panel: { x: null, y: null, w: null, h: null }, theme: 'pink' };
  // 清理已保留计数器对应的 tombstones，避免后续再次误删
  const keptIds = new Set(out.map(c => c.id));
  const mergedTombs = Array.from(tMap.values()).filter(t => !keptIds.has(t.id));
  // 历史墓碑（全部保留，避免另一端尚未清理时被回收）
  const mergedHistoryTombs = Array.from(hTMap.values());
  return { counters: out, ui, tombstones: mergedTombs, historyTombstones: mergedHistoryTombs };
}

async function syncWithJsonBin(statusEl, silent = false) {
  const cfg = ensureSyncConfigOrPrompt();
  if (!cfg) return;
  const setStatus = (t, isError = false) => {
    try { if (statusEl) { statusEl.textContent = t; statusEl.classList.toggle('error', !!isError); } } catch {}
  };
  try {
    setCloudIndicator('syncing', '正在同步…');
    setStatus('读取云端…');
    const url = `https://api.jsonbin.io/v3/b/${encodeURIComponent(cfg.binId)}/latest`;
    const headers = { 'X-Master-Key': cfg.apiKey, 'X-Bin-Meta': 'false' };
    // 条件 GET：如已缓存 ETag，提供 If-None-Match，若 304 表示远端无更新
    try { const meta = loadSyncMeta(); if (meta && meta.etag) headers['If-None-Match'] = meta.etag; } catch {}
    const res = await fetch(url, { method: 'GET', headers });
    if (res.status === 304) {
      // 远端未变化：如本地有改动则直接 PUT 写回；否则视为完成
      const meta = loadSyncMeta();
      if (!meta || !meta.pending) { setStatus('已是最新'); setCloudIndicator('ok', '已是最新'); if (!statusEl && !silent) alert('已是最新'); return; }
      // 仅有本地改动（包括仅顺序变化）：直接按本地状态写回，避免读取空 304 响应体
      setStatus('写回云端…');
      try { setCloudIndicator('syncing', '写回云端…'); } catch {}
      const putUrl = `https://api.jsonbin.io/v3/b/${encodeURIComponent(cfg.binId)}`;
      const putHeaders = { 'Content-Type': 'application/json', 'X-Master-Key': cfg.apiKey };
      if (meta && meta.etag) putHeaders['If-Match'] = meta.etag;
      // 确保 order 连续化
      try { state.counters.forEach((c, i) => { if (c) c.order = i; }); } catch {}
      const payload = { ...state, schemaVersion: SCHEMA_VERSION, updatedAt: nowISO(), rev: (Number(state.rev||0) + 1) };
      const putRes = await fetch(putUrl, { method: 'PUT', headers: putHeaders, body: JSON.stringify(payload) });
      if (!putRes.ok) {
        if (putRes.status === 412 || putRes.status === 409) {
          // 新并发版本：拉取最新并按“本地优先顺序”合并后重试一次
          const latest = await fetch(url, { method: 'GET', headers: { 'X-Master-Key': cfg.apiKey, 'X-Bin-Meta': 'false' } });
          if (latest.ok) {
            const latestObj = await latest.json();
            try { const et = latest.headers && latest.headers.get && latest.headers.get('ETag'); const m2 = loadSyncMeta(); m2.etag = et || m2.etag || null; saveSyncMeta(m2); } catch {}
            const merged2 = mergeStates(state, latestObj, { order: 'local' });
            const payload2 = { ...merged2, schemaVersion: SCHEMA_VERSION, updatedAt: nowISO(), rev: (Number(merged2.rev||0) + 1) };
            const headers2 = { 'Content-Type': 'application/json', 'X-Master-Key': cfg.apiKey };
            try { const m = loadSyncMeta(); if (m && m.etag) headers2['If-Match'] = m.etag; } catch {}
            const retry = await fetch(putUrl, { method: 'PUT', headers: headers2, body: JSON.stringify(payload2) });
            if (!retry.ok) { setStatus('同步失败：冲突未解决（HTTP ' + retry.status + '）', true); setCloudIndicator('error', '冲突未解决'); return; }
            state = merged2; save(); render();
            try { const et2 = retry.headers && retry.headers.get && retry.headers.get('ETag'); const m3 = loadSyncMeta(); m3.etag = et2 || m3.etag || null; m3.lastSyncedAt = nowISO(); m3.pending = false; saveSyncMeta(m3); } catch {}
            setStatus('同步完成'); setCloudIndicator('ok', '同步完成'); if (!statusEl && !silent) alert('同步完成');
            return;
          } else {
            setStatus('同步失败：无法获取最新版本', true); setCloudIndicator('error', '无法获取最新'); return;
          }
        }
        setStatus('同步失败：写回云端失败（HTTP ' + putRes.status + '）', true); setCloudIndicator('error', '写回失败');
        return;
      }
      // 成功：更新 ETag 与本地标记
      try { const et = putRes.headers && putRes.headers.get && putRes.headers.get('ETag'); const m = loadSyncMeta(); m.etag = et || m.etag || null; m.lastSyncedAt = nowISO(); m.pending = false; saveSyncMeta(m); } catch {}
      setStatus('同步完成'); setCloudIndicator('ok', '同步完成'); if (!statusEl && !silent) alert('同步完成');
      return;
    }
    if (res.status === 404) {
      // 云端不存在：询问是否创建并上传本地
      const ok = await confirmDialog({ title: '创建云端数据', text: '云端不存在数据，是否用本地数据创建？', danger: false, okText: '创建并上传', cancelText: '取消' });
      if (!ok) { setStatus('已取消'); return; }
      await pushToJsonBin();
      setStatus('已创建云端数据'); setCloudIndicator('ok', '已创建云端数据');
      return;
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) { setStatus('同步失败：密钥无效或无权限', true); setCloudIndicator('error', '密钥无效或无权限'); return; }
      if (res.status === 429) { setStatus('同步失败：请求过于频繁', true); setCloudIndicator('error', '请求过于频繁'); return; }
      setStatus('同步失败：HTTP ' + res.status, true); setCloudIndicator('error', '同步失败');
      return;
    }
    const remote = await res.json();
    // 更新 ETag
    try { const etag = res.headers && res.headers.get && res.headers.get('ETag'); const meta = loadSyncMeta(); meta.etag = etag || meta.etag || null; saveSyncMeta(meta); } catch {}
    // 根据是否存在本地待同步变更决定顺序偏好：
    // - 有本地待同步（本设备是“最后上传”的候选）：按本地顺序合并
    // - 否则（其他设备被动同步）：按远端顺序合并，并避免仅因顺序差异而回写
    const metaNow = loadSyncMeta();
    const hasPending = !!(metaNow && metaNow.pending);
    const preferOrder = hasPending ? 'local' : 'remote';
    const merged = mergeStates(state, remote, { order: preferOrder });
    const changedLocal = !deepEqual(merged, state);
    // 仅在“本地有待同步”时才考虑写回云端，防止被动设备把顺序再覆盖回去
    const changedRemote = hasPending && !deepEqual(merged, remote);
    if (changedRemote) {
      setStatus('写回云端…');
      try { setCloudIndicator('syncing', '写回云端…'); } catch {}
      const putUrl = `https://api.jsonbin.io/v3/b/${encodeURIComponent(cfg.binId)}`;
      const meta = loadSyncMeta();
      const putHeaders = { 'Content-Type': 'application/json', 'X-Master-Key': cfg.apiKey };
      if (meta && meta.etag) putHeaders['If-Match'] = meta.etag;
      const payload = { ...merged, schemaVersion: SCHEMA_VERSION, updatedAt: nowISO(), rev: (Number(merged.rev||0) + 1) };
      const putRes = await fetch(putUrl, { method: 'PUT', headers: putHeaders, body: JSON.stringify(payload) });
      if (!putRes.ok) {
        if (putRes.status === 412 || putRes.status === 409) {
          setStatus('云端已变化，正在自动合并…');
          // 冲突：重新获取一次最新并重试一次合并写入（避免死循环，只尝试一次）
          const latest = await fetch(url, { method: 'GET', headers: { 'X-Master-Key': cfg.apiKey, 'X-Bin-Meta': 'false' } });
          if (latest.ok) {
            const latestObj = await latest.json();
            try { const et = latest.headers && latest.headers.get && latest.headers.get('ETag'); const m2 = loadSyncMeta(); m2.etag = et || m2.etag || null; saveSyncMeta(m2); } catch {}
            const merged2 = mergeStates(state, latestObj, { order: preferOrder });
            const payload2 = { ...merged2, schemaVersion: SCHEMA_VERSION, updatedAt: nowISO(), rev: (Number(merged2.rev||0) + 1) };
            const headers2 = { 'Content-Type': 'application/json', 'X-Master-Key': cfg.apiKey };
            try { const m = loadSyncMeta(); if (m && m.etag) headers2['If-Match'] = m.etag; } catch {}
            const retry = await fetch(putUrl, { method: 'PUT', headers: headers2, body: JSON.stringify(payload2) });
            if (!retry.ok) { setStatus('同步失败：冲突未解决（HTTP ' + retry.status + '）', true); setCloudIndicator('error', '冲突未解决'); return; }
            // 成功：写本地
            state = merged2; save(); render();
            try { const et2 = retry.headers && retry.headers.get && retry.headers.get('ETag'); const m3 = loadSyncMeta(); m3.etag = et2 || m3.etag || null; m3.lastSyncedAt = nowISO(); m3.pending = false; saveSyncMeta(m3); } catch {}
            setStatus('同步完成'); setCloudIndicator('ok', '同步完成'); if (!statusEl && !silent) alert('同步完成'); return;
          } else {
            setStatus('同步失败：无法获取最新版本', true); setCloudIndicator('error', '无法获取最新'); return;
          }
        }
        setStatus('同步失败：写回云端失败（HTTP ' + putRes.status + '）', true); setCloudIndicator('error', '写回失败');
        return;
      }
      // 更新 ETag 与本地标记
      try { const et = putRes.headers && putRes.headers.get && putRes.headers.get('ETag'); const m = loadSyncMeta(); m.etag = et || m.etag || null; m.lastSyncedAt = nowISO(); m.pending = false; saveSyncMeta(m); } catch {}
    }
    if (changedLocal) {
      state = merged;
      if (hasPending) { save(); } else { saveSilent(); }
      render();
    }
    setStatus('同步完成'); setCloudIndicator('ok', '同步完成');
    if (!statusEl && !silent) alert('同步完成');
  } catch (e) {
    setStatus('同步失败：网络错误或跨域受限', true); setCloudIndicator('error', '网络或跨域错误');
  }
}

// --- 自动同步：节流写入 + 启动拉取 + 离线重试 ---
function markDirtyAndScheduleSync() {
  const cfg = loadSyncConfig();
  if (!cfg.auto) return; // 未开启自动同步则不触发
  __syncPending = true;
  // 离线时等待 online 再同步
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (__syncInFlight) return; // 正在同步，等这次完成
  if (__syncTimer) { try { clearTimeout(__syncTimer); } catch {} }
  // 5 秒节流：合并多次 save()
  __syncTimer = setTimeout(() => {
    __syncTimer = null;
    __syncPending = false;
    __syncInFlight = true;
    syncWithJsonBin(null, true).finally(() => { __syncInFlight = false; });
  }, 5000);
}

function setupAutoSync() {
  if (__autoSyncInstalled) return; // 已安装，避免重复绑定
  const cfg = loadSyncConfig();
  if (!cfg.binId || !cfg.apiKey) return;
  // 初始：条件 GET 检查并合并
  if (cfg.auto) {
    // 尽早触发但避免阻塞首屏
    setTimeout(() => { __syncInFlight = true; syncWithJsonBin(null, true).finally(() => { __syncInFlight = false; }); }, 300);
  }
  // 监听网络恢复：若有待同步则执行
  try {
    window.addEventListener('online', () => {
      setCloudIndicator('ok', '网络已连接');
      const m = loadSyncMeta();
      if (m && m.pending) { __syncInFlight = true; syncWithJsonBin(null, true).finally(() => { __syncInFlight = false; }); }
    });
    window.addEventListener('offline', () => { setCloudIndicator('offline', '离线'); });
  } catch {}
  __autoSyncInstalled = true;
}

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

// Enable closing a dialog when clicking on its backdrop
function enableBackdropClose(dialog, handler) {
  if (!dialog) return;
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      if (typeof handler === 'function') handler();
      else closeModal(dialog);
    }
  });
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

    const finish = (val) => {
      dlg.removeEventListener('click', onBackdrop);
      closeModal(dlg);
      resolve(val);
    };
    const onBackdrop = (e) => { if (e.target === dlg) finish(false); };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }, { once: true });
    dlg.addEventListener('click', onBackdrop);
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

// Simple app-style alert dialog (OK only)
function infoDialog({ title = '提示', text = '', okText = '知道了' } = {}) {
  return new Promise((resolve) => {
    const dlg = el('#info-dialog');
    if (!dlg) { try { alert(text || title); } catch {} resolve(true); return; }
    const titleEl = el('#info-title');
    const textEl = el('#info-text');
    const okOld = el('#info-ok');
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = text;
    const okBtn = okOld ? okOld.cloneNode(true) : null;
    if (okOld && okBtn) okOld.parentNode.replaceChild(okBtn, okOld);
    if (okBtn) okBtn.textContent = okText || '知道了';
    const finish = () => { closeModal(dlg); resolve(true); };
    if (okBtn) okBtn.onclick = finish;
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(); }, { once: true });
    enableBackdropClose(dlg, finish);
    openModal(dlg);
  });
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
  try {
    document.querySelectorAll('.btn-ellipsis[aria-expanded="true"]').forEach(b => {
      b.removeAttribute('aria-expanded');
      b.classList.remove('tap-flash'); // 关闭时立即移除点击高亮
    });
  } catch {}
}

function showPopoverForCounter(counter, anchorRect) {
  const elp = ensurePopover();
  if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
  elp.classList.remove('hiding');
  elp.classList.remove('tip');
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
  if (!counter.archived) {
    elp.appendChild(mk('重命名', '', () => openRename(counter.id, counter.name)));
  }
  // Touch-friendly reorder options作为 DnD 的回退
  if (isTouchDevice() && !counter.archived) {
    elp.appendChild(mk('上移', '', () => moveCounterById(counter.id, -1)));
    elp.appendChild(mk('下移', '', () => moveCounterById(counter.id, +1)));
    elp.appendChild(mk('置顶', '', () => moveCounterToEdge(counter.id, 'top')));
    elp.appendChild(mk('置底', '', () => moveCounterToEdge(counter.id, 'bottom')));
  }
  if (!counter.archived) {
    elp.appendChild(mk('重置（清零并清空历史）', '', async () => {
      const ok = await confirmDialog({ title: '重置计数器', text: `确认重置 “${counter.name}” 吗？这会将计数清零并删除所有历史。`, danger: true, okText: '重置' });
      if (ok) resetCounter(counter.id);
    }));
  }
  // Archive / Unarchive
  if (!counter.archived) {
    elp.appendChild(mk('归档', '', async () => {
      const ok = true; // 归档无需确认，直接执行
      if (ok) setArchived(counter.id, true);
    }));
  } else {
    elp.appendChild(mk('取消归档', '', async () => { setArchived(counter.id, false); }));
  }
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
let noteFocusTimer = null; // delayed focus timer for quick-note input
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
  if (noteFocusTimer) { try { clearTimeout(noteFocusTimer); } catch {} noteFocusTimer = null; }
}

function showQuickNote(anchorRect, onCommit, placeholder = '填写备注…', options = null) {
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
  // Reduce autofill interference and keep neutral typing experience
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('inputmode', 'text');
  input.setAttribute('enterkeyhint', 'done');
  input.setAttribute('name', 'quick-note');
  const ok = document.createElement('button'); ok.className = 'primary';
  // Dynamic OK label for record mode
  const dynamicOk = options && options.dynamicOk;
  const emptyLabel = (options && options.emptyLabel) || '直接记录';
  const filledLabel = (options && options.filledLabel) || '添加记录';
  const defaultLabel = (options && options.defaultLabel) || '保存';
  const updateOkLabel = () => {
    if (!dynamicOk) { ok.textContent = defaultLabel; return; }
    const hasText = !!input.value.trim();
    ok.textContent = hasText ? filledLabel : emptyLabel;
  };
  updateOkLabel();
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
    // 缩短保护窗口，避免需要点两次才能关闭（保留对“长按合成 click”的防抖）
    noteSuppressCloseUntil = now + 250;
  } catch { noteSuppressCloseUntil = Date.now() + 250; }
  noteIgnoreNextClick = 1; // 吞掉弹出后的第一个全局 click
  // 统一延时 250ms 再聚焦，规避长按抬手与系统合成 click 造成的闪退
  if (noteFocusTimer) { try { clearTimeout(noteFocusTimer); } catch {} }
  noteFocusTimer = setTimeout(() => {
    try {
      // 仅当浮层仍然可见时再聚焦
      const hidden = p.classList.contains('hidden');
      if (!hidden) { input.focus(); input.select && input.select(); }
    } catch {}
    noteFocusTimer = null;
  }, 250);
  const finish = (commit) => {
    if (commit && noteCommit) { const v = input.value.trim(); try { noteCommit(v); } catch {} }
    hideNotePopover();
  };
  ok.onclick = () => finish(true);
  cancel.onclick = () => finish(false);
  input.addEventListener('input', updateOkLabel);
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
  // 确保保存时包含稳定的排序字段
  try { state.counters.forEach((c, i) => { if (c) c.order = i; }); } catch {}
  localStorage.setItem(storeKey, JSON.stringify(state));
  // 本地数据更新：标记待同步并节流触发自动同步（若已开启）
  try { const meta = loadSyncMeta(); meta.pending = true; saveSyncMeta(meta); } catch {}
  markDirtyAndScheduleSync();
}

// 保存但不标记待同步（用于“从云端合并/拉取”写入本地时，避免触发二次上传）
function saveSilent() {
  try { state.counters.forEach((c, i) => { if (c) c.order = i; }); } catch {}
  localStorage.setItem(storeKey, JSON.stringify(state));
}

function load() {
  try {
    const raw = localStorage.getItem(storeKey);
    if (raw) state = JSON.parse(raw);
    if (!state.ui) state.ui = { panel: { x: null, y: null, w: null, h: null }, theme: 'pink', showArchived: false };
    if (state.ui && typeof state.ui.showArchived !== 'boolean') { try { state.ui.showArchived = false; } catch {} }
    if (!Array.isArray(state.tombstones)) state.tombstones = [];
    if (!Array.isArray(state.historyTombstones)) state.historyTombstones = [];
    // 若存在排序字段，优先按其排序；并标准化为 0..N-1
    try {
      if (Array.isArray(state.counters)) {
        const anyOrder = state.counters.some(c => Number.isFinite(c && c.order));
        if (anyOrder) {
          state.counters.sort((a, b) => (Number.isFinite(a.order) ? a.order : 1e9) - (Number.isFinite(b.order) ? b.order : 1e9));
        }
        state.counters.forEach((c, i) => { if (c) c.order = i; });
        // 标准化缺失字段
        state.counters.forEach((c) => { if (c && typeof c.archived !== 'boolean') c.archived = false; });
      }
    } catch {}
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
    archived: false,
  };
  state.counters.unshift(c);
  lastAddedId = c.id;
  // 若 tombstones 中存在同 id（理论上不会，因为 uid 新生成），清理之
  try { if (Array.isArray(state.tombstones)) state.tombstones = state.tombstones.filter(t => t && t.id !== c.id); } catch {}
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
        // 记录删除 tombstone，以便同步时在云端也删除
        try {
          if (!Array.isArray(state.tombstones)) state.tombstones = [];
          const t = { id, deletedAt: nowISO() };
          const i = state.tombstones.findIndex(x => x && x.id === id);
          if (i >= 0) {
            const prev = state.tombstones[i];
            const pa = Date.parse(prev.deletedAt || 0) || 0;
            const na = Date.parse(t.deletedAt || 0) || 0;
            if (na > pa) state.tombstones[i] = t;
          } else {
            state.tombstones.push(t);
          }
        } catch {}
        save();
        render();
      };
      card.addEventListener('transitionend', finish);
      setTimeout(finish, 280);
      return;
    }
  } catch {}
  state.counters = state.counters.filter((c) => c.id !== id);
  try {
    if (!Array.isArray(state.tombstones)) state.tombstones = [];
    const t = { id, deletedAt: nowISO() };
    const i = state.tombstones.findIndex(x => x && x.id === id);
    if (i >= 0) {
      const prev = state.tombstones[i];
      const pa = Date.parse(prev.deletedAt || 0) || 0;
      const na = Date.parse(t.deletedAt || 0) || 0;
      if (na > pa) state.tombstones[i] = t;
    } else {
      state.tombstones.push(t);
    }
  } catch {}
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

function setArchived(id, archived = true) {
  const c = state.counters.find((x) => x.id === id);
  if (!c) return;
  try { clearMenuOpenTimer(); hidePopover(); } catch {}
  // 先立即更新状态并保存（标记待同步），以便用户快速点击云同步时不会错过这次变更
  c.archived = !!archived;
  c.updatedAt = nowISO();
  // 保存但暂不 render，避免卡片立刻被移除导致没有离场动画
  save();
  // 若当前列表中存在该卡片，则做离场动画后再刷新视图
  try {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card && card.isConnected) {
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
        try { card.removeEventListener('transitionend', finish); } catch {}
        render();
      };
      card.addEventListener('transitionend', finish);
      setTimeout(finish, 300);
      return;
    }
  } catch {}
  // 不在当前列表（或未找到 DOM 卡片）：状态已保存，这里只需刷新
  render();
}

function toggleArchivedViewAnimated() {
  const container = el('#counters');
  const finishSwitch = () => {
    try { state.ui.showArchived = !state.ui.showArchived; save(); render(); } catch {}
    try {
      const news = Array.from(document.querySelectorAll('#counters .card'));
      news.forEach((n, j) => {
        n.classList.add('enter');
        setTimeout(() => { try { n.classList.remove('enter'); } catch {} }, 320 + j * 5);
      });
    } catch {}
  };
  if (!container) { finishSwitch(); return; }
  const cards = Array.from(container.querySelectorAll('.card'));
  if (!cards.length) { finishSwitch(); return; }
  let remaining = cards.length;
  cards.forEach((card, i) => {
    try {
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
        try {
          card.style.height = '0px';
          card.style.marginTop = '0px';
          card.style.marginBottom = '0px';
          card.style.paddingTop = '0px';
          card.style.paddingBottom = '0px';
        } catch {}
      }, i * 8);
      const onEnd = () => {
        try { card.removeEventListener('transitionend', onEnd); } catch {}
        if (--remaining === 0) {
          finishSwitch();
        }
      };
      card.addEventListener('transitionend', onEnd);
      setTimeout(onEnd, 340 + i * 8);
    } catch {
      if (--remaining === 0) finishSwitch();
    }
  });
}

function addHistory(c, delta, note) {
  c.history.unshift({ ts: nowISO(), delta, note: note || '' });
  // keep last N if needed; for now, keep all
}

// Minimal UI refresh for a single counter card (avoid full re-render flicker)
function updateCounterView(id, animate = true) {
  try {
    const c = state.counters.find((x) => x.id === id);
    if (!c) return;
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (!card) return;
    const badge = card.querySelector('.badge');
    if (badge) {
      badge.textContent = String(c.count);
      if (animate) {
        try {
          badge.classList.remove('flip');
          void badge.offsetWidth;
          badge.classList.add('flip');
          setTimeout(() => badge.classList.remove('flip'), 500);
        } catch {}
      }
    }
    const minus = card.querySelector('.btn-minus');
    if (minus) minus.disabled = c.count <= 0;
    const meta = card.querySelector('.stack .muted');
    if (meta) meta.textContent = `更新 ${timeAgo(c.updatedAt)}`;
  } catch {}
}

// Add a record entry (delta = 0) without changing count
function addRecord(id, note) {
  const c = state.counters.find((x) => x.id === id);
  if (!c) return;
  if (c.archived) { try { infoDialog({ title: '已归档', text: '该计数器已归档。如需操作，请先取消归档。', okText: '知道了' }); } catch {} return; }
  addHistory(c, 0, note || '');
  c.updatedAt = nowISO();
  save();
  render();
  // 视觉反馈：添加“记录”（0 增量）后在卡片右上角短暂提示
  try { flashRecordIndicator(id, note ? '已添加记录' : '已记录'); } catch {}
}

// 在卡片的操作区中、放在“−1”按钮之前展示一次性的“已记录”提示
function flashRecordIndicator(id, text = '已记录') {
  try {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (!card) return;
    const actions = card.querySelector('.actions');
    const minus = actions && actions.querySelector('.btn-minus');
    if (!actions || !minus) return;
    // 若已有提示，先移除，避免堆叠
    try { actions.querySelectorAll('.record-indicator').forEach(n => n.remove()); } catch {}
    const tip = document.createElement('div');
    tip.className = 'record-indicator';
    tip.textContent = text;
    actions.insertBefore(tip, minus);
    // 下一帧触发进入动画
    requestAnimationFrame(() => tip.classList.add('show'));
    const cleanup = () => { try { tip.remove(); } catch {} };
    // 可见时长：约 1.6s 后开始淡出；仅监听“淡出”这一次的过渡结束
    setTimeout(() => {
      try {
        tip.classList.add('hide');
        const onEnd = (e) => { if (e.propertyName === 'opacity') cleanup(); };
        tip.addEventListener('transitionend', onEnd, { once: true });
      } catch { cleanup(); }
    }, 1600);
    // 兜底清理：若某些环境未触发 transitionend，稍后强制移除
    setTimeout(cleanup, 2600);
  } catch {}
}

function inc(id, delta = +1, note) {
  const c = state.counters.find((x) => x.id === id);
  if (!c) return;
    if (c.archived) { try { infoDialog({ title: '已归档', text: '该计数器已归档。如需操作，请先取消归档。', okText: '知道了' }); } catch {} return; }
  if (delta < 0) {
    if (c.count <= 0) return; // 下限保护：不允许负数
    // 撤销：删除最近的一条 +1 历史并回退计数（作为“删除历史”处理，写入墓碑以同步到云端）
    const idx = c.history.findIndex((h) => h && h.delta > 0);
    if (idx !== -1) {
      const removed = c.history[idx];
      c.history.splice(idx, 1);
      // 写历史墓碑，确保其它设备合并时也会删除该条
      try {
        if (!Array.isArray(state.historyTombstones)) state.historyTombstones = [];
        const tomb = { counterId: id, ts: removed && removed.ts, deletedAt: nowISO() };
        if (tomb.ts) {
          const j = state.historyTombstones.findIndex(t => t && t.counterId === id && t.ts === tomb.ts);
          if (j >= 0) {
            const prev = state.historyTombstones[j];
            const pa = Date.parse(prev.deletedAt || 0) || 0;
            const na = Date.parse(tomb.deletedAt || 0) || 0;
            if (na > pa) state.historyTombstones[j] = tomb;
          } else {
            state.historyTombstones.push(tomb);
          }
        }
      } catch {}
    }
    c.count = Math.max(0, c.count - 1);
    // 不记录 -1 的历史
  } else {
    c.count = Math.max(0, c.count + delta);
    addHistory(c, delta, note);
  }
  c.updatedAt = nowISO();
  lastBumpId = id;
  save();
  // 局部刷新，避免整卡重建导致按压反馈类名被打断
  updateCounterView(id, true);
}

function fmtTime(s) {
  const d = new Date(s);
  const pad = (n) => String(n).padStart(2, '0');
  // 显示：月、日、时、分（不含年与秒）
  return `${d.getMonth() + 1}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Split into date and time strings for two-line layout in history list
function fmtDateParts(s) {
  const d = new Date(s);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getMonth() + 1}月${pad(d.getDate())}日`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return [date, time];
}

function render() {
  const container = el('#counters');
  container.innerHTML = '';
  const viewArchived = !!(state && state.ui && state.ui.showArchived);
  // Update archived toggle button label
  try {
    const btn = document.querySelector('#btn-archived');
    if (btn) btn.textContent = viewArchived ? '返回' : '查看归档';
  } catch {}
  const list = Array.isArray(state.counters) ? state.counters.filter(c => !!c && (!!c.archived === viewArchived)) : [];
  if (!list.length) {
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.padding = '8px';
    hint.textContent = viewArchived ? '暂无归档计数器。' : '还没有计数器，点上方 “+ 新建计数器” 创建一个。';
    container.appendChild(hint);
    // Even在空列表时也应用最小高度策略（预留三张卡的空间）
    ensureMinCounterArea(3);
    return;
  }

  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = c.id;
    if (c.archived) { card.classList.add('archived'); card.dataset.archived = '1'; }

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
    // Remove tooltip; keep accessible label
    try { minus.setAttribute('aria-label', '减少 1'); } catch {}
    minus.className = 'btn-minus ghost round btn-icon';
    // Local tap feedback to ensure visibility even without global handlers
    const minusTapOn = () => { try { minus.classList.add('tap-flash'); } catch {} };
    const minusTapOff = () => { try { minus.classList.remove('tap-flash'); } catch {} };
    minus.addEventListener('pointerdown', minusTapOn);
    minus.addEventListener('pointerup', () => setTimeout(minusTapOff, TAP_FLASH_MS), { passive: true });
    minus.addEventListener('pointercancel', minusTapOff, { passive: true });
    minus.addEventListener('touchstart', minusTapOn, { passive: true });
    minus.addEventListener('touchend', () => setTimeout(minusTapOff, TAP_FLASH_MS), { passive: true });
    // Use click listener to blur after action to avoid sticky focus
    minus.addEventListener('click', (e) => { inc(c.id, -1); try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} });
    const plus = document.createElement('button');
    plus.textContent = '+1';
    plus.className = 'primary round btn-icon';
    // Remove tooltip; keep accessible label
    try { plus.setAttribute('aria-label', '增加 1'); } catch {}
    plus.className += ' btn-plus';
    // Click to +1；长按或 Shift 点击弹“快速备注”应用内浮窗
    let holdTimer = null; let consumedByHold = false; let handledThisTap = false;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
    plus.addEventListener('pointerdown', (e) => {
      consumedByHold = false;
      handledThisTap = false;
      try { plus.classList.add('tap-flash'); } catch {}
      clearHold();
      holdTimer = setTimeout(() => {
        consumedByHold = true;
        if (c.archived) { try { infoDialog({ title: '已归档', text: '该计数器已归档。如需操作，请先取消归档。', okText: '知道了' }); } catch {} return; }
        const r = plus.getBoundingClientRect();
        showQuickNote(r, (note) => inc(c.id, +1, note || ''));
      }, LONG_PRESS_MS);
    });
    plus.addEventListener('pointerup', (e) => {
      clearHold();
      if (!consumedByHold) {
        if (e.shiftKey) {
          if (c.archived) { try { infoDialog({ title: '已归档', text: '该计数器已归档。如需操作，请先取消归档。', okText: '知道了' }); } catch {} }
          else {
            const r = plus.getBoundingClientRect();
            showQuickNote(r, (note) => inc(c.id, +1, note || ''));
          }
        } else {
          inc(c.id, +1);
        }
        handledThisTap = true;
      } else {
        // 若是长按触发的备注，阻断后续的合成 click，避免打断输入聚焦
        try { e.preventDefault(); } catch {}
      }
      // Remove local tap effect shortly after release（统一固定时长）
      setTimeout(() => { try { plus.classList.remove('tap-flash'); } catch {} }, TAP_FLASH_MS);
      try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {}
    });
    // iOS Safari（老版本）等无 Pointer Events 的回退处理
    // 仅在不支持 PointerEvent 的环境下绑定 touch 版本，避免移动端重复触发（pointerup + touchend）导致 +1 两次
    try {
      if (!("PointerEvent" in window)) {
        plus.addEventListener('touchstart', () => { consumedByHold = false; handledThisTap = false; try { plus.classList.add('tap-flash'); } catch {} clearHold(); holdTimer = setTimeout(() => { consumedByHold = true; if (c.archived) { try { infoDialog({ title: '已归档', text: '该计数器已归档。如需操作，请先取消归档。', okText: '知道了' }); } catch {} return; } const r = plus.getBoundingClientRect(); showQuickNote(r, (note) => inc(c.id, +1, note || '')); }, LONG_PRESS_MS); }, { passive: true });
        plus.addEventListener('touchend', (e) => {
          clearHold();
          if (!consumedByHold && !handledThisTap) { inc(c.id, +1); handledThisTap = true; }
          setTimeout(() => { try { plus.classList.remove('tap-flash'); } catch {} }, TAP_FLASH_MS);
          try { e.preventDefault(); } catch {}
          try { plus.blur(); } catch {}
        }, { passive: false });
      }
    } catch {}
    // 再加一层 click 兜底：
    // - 若此次 click 来源于“长按”触发的快速备注，则吞掉 click，避免冒泡到 document 触发关闭
    // - 否则在未被 pointer/touch 处理时执行 +1，兼容老设备
    plus.addEventListener('click', (e) => {
      if (consumedByHold) { e.preventDefault(); e.stopPropagation(); return; }
      if (!handledThisTap) { inc(c.id, +1); handledThisTap = true; }
      try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {}
    });
    plus.addEventListener('pointerleave', clearHold);
    // 屏蔽长按产生的系统上下文菜单，避免干扰备注输入
    plus.addEventListener('contextmenu', (e) => { try { e.preventDefault(); } catch {} });

    // Quick record button (note without changing count)
    const quick = document.createElement('button');
    quick.className = 'tonal round btn-icon';
    // Use aria-label for accessibility without browser tooltip
    try { quick.setAttribute('aria-label', '快速记录'); } catch {}
    quick.textContent = '记';
    quick.addEventListener('click', (e) => {
      e.stopPropagation();
      if (c.archived) { try { infoDialog({ title: '已归档', text: '该计数器已归档。如需操作，请先取消归档。', okText: '知道了' }); } catch {} return; }
      const r = quick.getBoundingClientRect();
      showQuickNote(r, (note) => addRecord(c.id, note || ''), '快速记录…', {
        dynamicOk: true,
        emptyLabel: '直接记录',
        filledLabel: '添加记录',
        defaultLabel: '保存',
      });
      try { quick.blur(); } catch {}
    });
    // minus disabled at 0
    // 为了在归档时仍可点击并弹出提示，不在归档态禁用按钮
    minus.disabled = (!c.archived) ? (c.count <= 0) : false;

    // More button -> floating popover
    const more = document.createElement('button');
    // Use aria-label for accessibility without browser tooltip
    try { more.setAttribute('aria-label', '更多'); } catch {}
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
      if (isOpen) {
        hidePopover();
        try { more.removeAttribute('aria-expanded'); } catch {}
        // 关闭时立刻移除“点击高亮”，避免延迟消退
        try { more.classList.remove('tap-flash'); } catch {}
      } else {
        openMore();
      }
      // 防止移动端按钮保持焦点样式
      try { more.blur(); } catch {}
    });
    // Local tap shadow feedback for more button (three dots)
    const mTapOn = () => { try { more.classList.remove('tap-flash'); void more.offsetWidth; more.classList.add('tap-flash'); } catch {} };
    const mTapOff = () => { try { more.classList.remove('tap-flash'); } catch {} };
    more.addEventListener('pointerdown', mTapOn);
    more.addEventListener('pointerup', () => setTimeout(mTapOff, TAP_FLASH_MS), { passive: true });
    more.addEventListener('pointercancel', mTapOff, { passive: true });
    more.addEventListener('touchstart', mTapOn, { passive: true });
    more.addEventListener('touchend', () => setTimeout(mTapOff, TAP_FLASH_MS), { passive: true });
    more.addEventListener('pointerleave', (e) => {
      // 触屏上不要在 pointerleave 立刻隐藏，避免点击后立刻关闭导致“只闪一下”
      try { if (isTouchDevice()) return; } catch {}
      clearMenuOpenTimer();
      if (!movingIntoPopover(e)) scheduleHidePopover();
    });
    // 确保 touch/pointer 抬起后不保留选中态
    more.addEventListener('pointerup', (e) => { try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} }, { passive: true });
    more.addEventListener('touchend', (e) => { try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} }, { passive: true });

    right.append(minus, plus, quick, more);
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

  // Touch 设备：禁用指针拖拽（用“更多”菜单排序）
  try {
    if (isTouchDevice()) {
      cards.forEach((card) => card.classList.remove('dragging', 'drag-origin', 'drop-top', 'drop-bottom'));
      return;
    }
  } catch {}

  // 自定义 Pointer 拖拽（可用滚轮，配合边缘自动滚动）
  let autoScrollRAF = null; let lastClientY = 0;
  const EDGE = 90, MAX_SPEED = 12; const ease = (t) => t * t;
  // FLIP helpers for sibling animations (exclude the floating dragged card)
  const measureTops = () => {
    const map = {};
    const list = Array.from(container.querySelectorAll('.card'));
    for (const n of list) {
      if (n.classList.contains('dragging')) continue;
      const id = n.dataset.id;
      map[id] = n.getBoundingClientRect().top;
    }
    return map;
  };
  const applyFlipMaps = (prev, next) => {
    try {
      const list = Array.from(container.querySelectorAll('.card'));
      for (const n of list) {
        if (n.classList.contains('dragging')) continue;
        const id = n.dataset.id;
        if (!(id in prev) || !(id in next)) continue;
        const dy = prev[id] - next[id];
        if (Math.abs(dy) < 0.5) continue;
        // Pre-promote to reduce text flicker during FLIP
        n.style.willChange = 'transform';
        n.style.transition = 'none';
        n.style.transform = `translate3d(0, ${dy}px, 0)`;
        requestAnimationFrame(() => {
          n.style.transition = 'transform .20s cubic-bezier(.2,.7,.2,1)';
          n.style.transform = 'translate3d(0, 0, 0)';
          setTimeout(() => { try { n.style.transition = ''; n.style.transform = ''; n.style.willChange = ''; } catch {} }, 260);
        });
      }
    } catch {}
  };
  const startAutoScroll = () => {
    if (autoScrollRAF) return;
    const step = () => {
      if (!dragId) { autoScrollRAF = null; return; }
      try {
        const rect = container.getBoundingClientRect();
        let dy = 0;
        if (lastClientY < rect.top + EDGE) { const t = Math.max(0, rect.top + EDGE - lastClientY) / EDGE; dy = -Math.ceil(ease(t) * MAX_SPEED); }
        else if (lastClientY > rect.bottom - EDGE) { const t = Math.max(0, lastClientY - (rect.bottom - EDGE)) / EDGE; dy = Math.ceil(ease(t) * MAX_SPEED); }
        if (dy) container.scrollBy(0, dy);
      } catch {}
      autoScrollRAF = requestAnimationFrame(step);
    };
    autoScrollRAF = requestAnimationFrame(step);
  };
  const stopAutoScroll = () => { if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; } };

  const onPointerDown = (e, card) => {
    // 禁止对归档项目进行拖拽排序（需先取消归档）
    try {
      if ((card && card.dataset && card.dataset.archived === '1') || (state && state.ui && state.ui.showArchived)) {
        return;
      }
    } catch {}
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button, input, label, select, textarea')) return;
    // 将实际的“开始拖动”逻辑封装
    const startDrag = (ev) => {
      try { card.setPointerCapture && card.setPointerCapture(ev.pointerId); } catch {}
      const srcIdx = state.counters.findIndex((x) => x.id === card.dataset.id);
      if (srcIdx < 0) return;
      dragId = card.dataset.id;
      const cardRect = card.getBoundingClientRect();
      const contRect = container.getBoundingClientRect();
      const offsetY = ev.clientY - cardRect.top;
      lastClientY = ev.clientY;
      document.body.classList.add('dragging-global');
      document.body.style.userSelect = 'none';
      try { container.style.touchAction = 'none'; } catch {}
      try { hidePopover(); } catch {}

      // 先测量，再同时把卡片从文档流拿起并插入占位，统一做一次 FLIP，避免两次跳变
      const prevMapOnPickup = measureTops();
      // 浮动原卡片（先脱离文档流）
      card.classList.add('dragging');
      const prev = { position: card.style.position, left: card.style.left, top: card.style.top, width: card.style.width, zIndex: card.style.zIndex, pointerEvents: card.style.pointerEvents };
      card.__prevStyle = prev;
      card.style.position = 'fixed';
      card.style.left = cardRect.left + 'px';
      card.style.top = (ev.clientY - offsetY) + 'px';
      card.style.width = cardRect.width + 'px';
      card.style.zIndex = '1001';
      card.style.pointerEvents = 'none';
      // 占位器：保持文档流
      const ph = document.createElement('div');
      ph.style.height = cardRect.height + 'px';
      ph.style.margin = getComputedStyle(card).margin;
      ph.className = 'card-placeholder';
      card.parentNode.insertBefore(ph, card);
      // 插占位+卡片脱流 后量一次，触发其它卡片的 FLIP 动画以体现“补位”
      applyFlipMaps(prevMapOnPickup, measureTops());

    // 用于节流：仅当占位符的索引变化时才进行 FLIP
    let lastPhIndex = Array.from(container.children).indexOf(ph);

    // 提起时的轻微上浮动画（transform/阴影走过渡，不影响跟手性）
    card.style.transition = 'transform .14s ease, box-shadow .14s ease';
    try { card.style.transform = 'translateY(-2px) scale(1.01)'; } catch {}

      const onMove = (ev) => {
        lastClientY = ev.clientY || lastClientY;
        card.style.top = (ev.clientY - offsetY) + 'px';
        startAutoScroll();
      // 判断插入位置
      const contentY = container.scrollTop + (ev.clientY - contRect.top);
      const siblings = Array.from(container.querySelectorAll('.card')).filter(n => n !== card);
      let target = null;
      for (const sib of siblings) {
        const center = sib.offsetTop + sib.offsetHeight / 2;
        if (contentY < center) { target = sib; break; }
      }
      const beforeIndex = lastPhIndex;
      let newIndex;
      if (target) {
        newIndex = Array.from(container.children).indexOf(target);
      } else {
        newIndex = container.children.length; // append to end
      }
      if (newIndex !== beforeIndex && !(target === ph.nextSibling)) {
        const prevMap = measureTops();
        if (target) container.insertBefore(ph, target); else container.appendChild(ph);
        lastPhIndex = Array.from(container.children).indexOf(ph);
        applyFlipMaps(prevMap, measureTops());
      }
      };
      const endDrag = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', endDrag, true);
        stopAutoScroll();
        document.body.classList.remove('dragging-global');
        document.body.style.userSelect = '';
      // 计算目标索引
      const src = state.counters.findIndex((x) => x.id === dragId);
      let dstIdxBase = state.counters.length;
      const before = ph.nextElementSibling && ph.nextElementSibling.classList.contains('card') ? ph.nextElementSibling : null;
      if (before) {
        const beforeId = before.dataset.id; dstIdxBase = state.counters.findIndex((x) => x.id === beforeId);
      }
      let dst = dstIdxBase; if (dst > src) dst -= 1;
      // 目标位置（占位符）
      let targetRect = null;
      try { targetRect = ph.getBoundingClientRect(); } catch {}

      // 立即开始将浮动卡片滑入占位符位置，避免“松手后卡片不动”的延迟感
      if (targetRect) {
        try {
          card.style.transition = 'top .18s cubic-bezier(.2,.7,.2,1), left .18s cubic-bezier(.2,.7,.2,1), transform .18s ease, box-shadow .18s ease';
          card.style.left = targetRect.left + 'px';
          card.style.top = targetRect.top + 'px';
          card.style.transform = 'none';
        } catch {}
      }

      const cleanupNoMove = () => {
        // 回原位：还原样式并移除占位符
        const s = card.__prevStyle || {};
        card.style.position = s.position || '';
        card.style.left = s.left || '';
        card.style.top = s.top || '';
        card.style.width = s.width || '';
        card.style.zIndex = s.zIndex || '';
        card.style.pointerEvents = s.pointerEvents || '';
        card.style.transition = '';
        card.style.transform = '';
        try { card.style.touchAction = ''; } catch {}
        card.classList.remove('dragging');
        try { ph.parentNode && ph.parentNode.removeChild(ph); } catch {}
        dragId = null;
      };

      const cleanupMove = () => {
        // 为避免重渲染产生“卡片一分为二”的闪烁，先移除浮动卡片，再重排
        try { card.parentNode && card.parentNode.removeChild(card); } catch {}
        reorderCounters(src, dst); // render() 会清掉占位符
        dragId = null;
      };

      // 在滑入动画结束后执行最终重排/复位；加兜底定时器
      let handled = false;
      const onSlideEnd = (ev) => {
        if (handled) return; handled = true;
        try { card.removeEventListener('transitionend', onSlideEnd, true); } catch {}
        if (src >= 0 && dst >= 0 && src !== dst) cleanupMove(); else cleanupNoMove();
      };
        try { card.addEventListener('transitionend', onSlideEnd, true); } catch {}
        setTimeout(onSlideEnd, 220);
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', endDrag, true);
    };

    // 桌面：立即开始
    e.preventDefault();
    startDrag(e);
  };

  cards.forEach((card) => {
    try { card.removeAttribute('draggable'); } catch {}
    card.addEventListener('pointerdown', (e) => onPointerDown(e, card));
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
    card.style.willChange = 'transform';
    card.style.transition = 'none';
    card.style.transform = `translate3d(0, ${dy}px, 0)`;
    requestAnimationFrame(() => {
      card.style.transition = 'transform .18s ease';
      card.style.transform = 'translate3d(0, 0, 0)';
      setTimeout(() => { card.style.transition = ''; card.style.transform = ''; card.style.willChange = ''; }, 220);
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
  const readonly = !!c.archived;
  const dialog = el('#history-dialog');
  const list = el('#history-list');
  // Reset any min-height lock from previous runs
  try { list.style.minHeight = ''; } catch {}
  const meta = el('#history-meta');
  // Helper: ensure only one inline editor open at a time
  const cancelAnyEditing = (exceptLi) => {
    try {
      const editing = Array.from(list.querySelectorAll('li.editing'));
      for (const li of editing) {
        if (exceptLi && li === exceptLi) continue;
        const cancelBtn = li.querySelector('.note-edit button:not(.primary)');
        if (cancelBtn) { cancelBtn.click(); continue; }
        // Fallback: rebuild to default view using data-index
        const idx = Number(li.dataset.idx || -1);
        const ts = li.dataset.ts;
        let rec = null;
        if (ts) rec = c.history.find((h) => h && h.ts === ts) || null;
        if (!rec && idx >= 0 && idx < c.history.length) rec = c.history[idx];
        if (!rec) { li.classList.remove('editing'); continue; }
        const right = document.createElement('div');
        right.className = 'right';
        // Controls first (float right), then note so the first line shows note on the left
        const pill = document.createElement('span');
        const cls = (rec.delta > 0) ? 'add' : (rec.delta < 0 ? 'sub' : 'note');
        pill.className = 'pill ' + cls;
        pill.textContent = (rec.delta > 0) ? `+${rec.delta}` : (rec.delta < 0 ? `${rec.delta}` : '记录');
        if (!readonly) {
          const delBtn = document.createElement('button');
          delBtn.className = 'btn-icon btn-icon-sm btn-danger round';
          // Icon-only: add aria-label instead of title
          try { delBtn.setAttribute('aria-label', '删除记录'); } catch {}
          delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          delBtn.onclick = () => deleteHistoryEntryByTs(id, rec.ts);
          const editBtn = document.createElement('button'); editBtn.className = 'ghost'; editBtn.textContent = rec.note ? '编辑' : '添加'; editBtn.style.marginLeft = '8px';
          editBtn.onclick = () => { try { li.querySelector('button.ghost')?.click(); } catch {} };
          // Append floats in reverse for right-floating layout: delete -> edit -> pill
          right.appendChild(delBtn);
          right.appendChild(editBtn);
        }
        right.appendChild(pill);
        if (rec.note) { const ns = document.createElement('span'); ns.className = 'history-note'; ns.textContent = rec.note; right.appendChild(ns); }
        const cur = li.querySelector('.note-edit, .right');
        if (cur) li.replaceChild(right, cur);
        li.classList.remove('editing');
      }
    } catch {}
  };
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
      li.dataset.idx = String(idx);
      li.dataset.ts = h.ts;
      const left = document.createElement('div');
      left.className = 'left';
      const [dStr, tStr] = fmtDateParts(h.ts);
      left.innerHTML = `<div class="d">${dStr}</div><div class="t">${tStr}</div>`;
      const right = document.createElement('div');
      right.className = 'right';
      const pill = document.createElement('span');
      const pcls = (h.delta > 0) ? 'add' : (h.delta < 0 ? 'sub' : 'note');
      pill.className = 'pill ' + pcls;
      pill.textContent = (h.delta > 0) ? `+${h.delta}` : (h.delta < 0 ? `${h.delta}` : '记录');

      const appendNoteAndEdit = () => {
        if (readonly) {
          // 只读：不提供编辑/删除控件，仅展示徽章与备注
          right.appendChild(pill);
          if (h.note) { const noteSpan = document.createElement('span'); noteSpan.className = 'history-note'; noteSpan.textContent = h.note; right.appendChild(noteSpan); }
          return;
        }
        // Edit note inline button (float right)
        const editBtn = document.createElement('button');
        editBtn.className = 'ghost';
        editBtn.textContent = h.note ? '编辑' : '添加';
        editBtn.style.marginLeft = '8px';
        const editHandler = () => {
          // 保证同一时间仅一个编辑器
          cancelAnyEditing(li);
          // Enter editing mode: hide time(left) via CSS, show editor with slide-in
          li.classList.add('editing');
          const wrap = document.createElement('div');
          wrap.className = 'note-edit';
          const input = document.createElement('input');
          input.type = 'text';
          input.placeholder = '填写备注…';
          // Reduce autofill and keep neutral typing
          input.setAttribute('autocomplete', 'off');
          input.setAttribute('autocapitalize', 'off');
          input.setAttribute('autocorrect', 'off');
          input.setAttribute('spellcheck', 'false');
          input.setAttribute('inputmode', 'text');
          input.setAttribute('enterkeyhint', 'done');
          input.setAttribute('name', 'history-note');
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
            const p2cls = (h.delta > 0) ? 'add' : (h.delta < 0 ? 'sub' : 'note');
            pill2.className = 'pill ' + p2cls;
            pill2.textContent = (h.delta > 0) ? `+${h.delta}` : (h.delta < 0 ? `${h.delta}` : '记录');
            const againBtn = document.createElement('button');
            againBtn.className = 'ghost';
            againBtn.textContent = h.note ? '编辑' : '添加';
            againBtn.style.marginLeft = '8px';
            againBtn.onclick = editHandler; // reuse handler
            const delBtn2 = document.createElement('button');
            delBtn2.className = 'btn-icon btn-icon-sm btn-danger round';
            // Icon-only: add aria-label instead of title
            try { delBtn2.setAttribute('aria-label', '删除记录'); } catch {}
            delBtn2.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            delBtn2.onclick = () => deleteHistoryEntryByTs(id, h.ts);
            // Append in reverse for right-floating
            newRight.appendChild(delBtn2);
            newRight.appendChild(againBtn);
            newRight.appendChild(pill2);
            if (h.note) {
              const noteSpan2 = document.createElement('span');
              noteSpan2.className = 'history-note';
              noteSpan2.textContent = h.note;
              newRight.appendChild(noteSpan2);
            }
            li.replaceChild(newRight, wrap);
            requestAnimationFrame(() => newRight.classList.add('show'));
            li.classList.remove('editing');
          };

          const onFinish = (commit) => {
            if (commit) {
              const j = c.history.findIndex((x) => x && x.ts === h.ts);
              if (j !== -1) {
                c.history[j].note = input.value.trim();
                h.note = c.history[j].note; // keep local ref updated
                c.updatedAt = nowISO();
                save();
              }
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
        // Delete icon button (float right)
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-icon btn-icon-sm btn-danger round';
        // Icon-only: add aria-label instead of title
        try { delBtn.setAttribute('aria-label', '删除记录'); } catch {}
        delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        delBtn.onclick = () => deleteHistoryEntryByTs(id, h.ts);
        // Append floats in reverse order for right-floating: delete -> edit -> pill
        right.appendChild(delBtn);
        right.appendChild(editBtn);
        right.appendChild(pill);
        // Note text (comes last so first line uses leftover space)
        if (h.note) {
          const noteSpan = document.createElement('span');
          noteSpan.className = 'history-note';
          noteSpan.textContent = h.note;
          right.appendChild(noteSpan);
        }
      };

      appendNoteAndEdit();
      li.append(left, right);
      list.appendChild(li);
    });
  }

  dialog.returnValue = '';
  openModal(dialog);
}

// Reverted experimental two-part note layout

// Delete a single history record by index (does not change count)
function deleteHistoryEntry(id, idx) {
  const c = state.counters.find((x) => x.id === id);
  if (!c) return;
  const i = Number(idx);
  if (!(i >= 0 && i < c.history.length)) return;
  const ts = c.history[i]?.ts;
  if (!ts) return;
  deleteHistoryEntryByTs(id, ts);
}

// Stable delete by record timestamp (avoids index drift during concurrent animations)
function deleteHistoryEntryByTs(id, ts) {
  try {
    const c = state.counters.find(x => x && x.id === id);
    if (c && c.archived) { infoDialog({ title: '已归档', text: '该计数器已归档。如需操作，请先取消归档。', okText: '知道了' }); return; }
  } catch {}
  const c = state.counters.find((x) => x.id === id);
  if (!c) return;
  const i = c.history.findIndex((h) => h && h.ts === ts);
  if (i === -1) return;

  let committed = false;
  const rec = c.history[i];
  try {
    const sel = `#history-list li[data-ts="${CSS.escape(ts)}"]`;
    const li = document.querySelector(sel);
    if (li) {
      const h = li.getBoundingClientRect().height;
      // Lock current height so siblings can smoothly move up during collapse
      li.style.height = h + 'px';
      // Ensure transition styles are active before changing properties
      li.style.transition = 'height .22s ease, margin .22s ease, padding .22s ease, opacity .18s ease, transform .18s ease, border-color .2s ease';
      // Force reflow
      // eslint-disable-next-line no-unused-expressions
      li.offsetHeight;
      li.classList.add('leaving');
      // Keep list height stable if this is the last item
      const listEl = el('#history-list');
      const isLast = (c.history.length === 1);
      if (isLast && listEl) {
        try { listEl.style.minHeight = h + 'px'; } catch {}
      }
      const onEnd = (e) => {
        if (e && e.target !== li) return;
        if (e && e.propertyName && e.propertyName !== 'height') return;
        li.removeEventListener('transitionend', onEnd);
        commitDelete(listEl, isLast);
      };
      li.addEventListener('transitionend', onEnd);
      const t = setTimeout(() => { if (!committed) commitDelete(listEl, isLast); }, 360);
      // store timeout on element to cancel if needed
      try { li._delTimer = t; } catch {}
      return;
    }
  } catch {}

  commitDelete();

  function commitDelete(listEl, wasLast) {
    if (committed) return; committed = true;
    const j = c.history.findIndex((h) => h && h.ts === ts);
    if (j === -1) { if (listEl) listEl.style.minHeight = ''; openHistory(id); return; }
    // adjust count only when removing +delta entries; notes (0) do not affect count
    const d = c.history[j]?.delta || 0;
    const countChanged = d > 0;
    if (countChanged) c.count = Math.max(0, c.count - d);
    c.history.splice(j, 1);
    c.updatedAt = nowISO();
    // 记录历史删除墓碑，以便合并时过滤并在云端清除
    try {
      if (!Array.isArray(state.historyTombstones)) state.historyTombstones = [];
      const tomb = { counterId: id, ts, deletedAt: nowISO() };
      // 若已存在同 key，则仅保留较新的 deletedAt
      const idx = state.historyTombstones.findIndex(t => t && t.counterId === id && t.ts === ts);
      if (idx >= 0) {
        const prev = state.historyTombstones[idx];
        const pa = Date.parse(prev.deletedAt || 0) || 0;
        const na = Date.parse(tomb.deletedAt || 0) || 0;
        if (na > pa) state.historyTombstones[idx] = tomb;
      } else {
        state.historyTombstones.push(tomb);
      }
    } catch {}
    save();
    // Update main card view (avoid full re-render to prevent flicker)
    updateCounterView(id, countChanged);
    // If the deleted one was the last record, avoid full re-render to prevent flash
    if (wasLast && listEl) {
      try {
        listEl.innerHTML = '';
        const empty = document.createElement('li');
        empty.className = 'muted fade-in-up';
        empty.textContent = '暂无记录';
        listEl.appendChild(empty);
        requestAnimationFrame(() => empty.classList.add('show'));
        // Update the current value in meta directly
        const valEl = el('#history-meta .history-current .value');
        if (valEl) {
          valEl.textContent = String(c.count);
          if (countChanged) {
            try {
              valEl.classList.remove('flip');
              void valEl.offsetWidth; // reflow to restart animation
              valEl.classList.add('flip');
              setTimeout(() => valEl.classList.remove('flip'), 500);
            } catch {}
          }
        }
      } catch {}
      // Do not release minHeight here to keep container height unchanged until dialog closes
    } else {
      openHistory(id);
      // Animate the updated value after re-render only if count changed
      if (countChanged) {
        requestAnimationFrame(() => {
          try {
            const valEl = el('#history-meta .history-current .value');
            if (valEl) {
              valEl.classList.remove('flip');
              void valEl.offsetWidth;
              valEl.classList.add('flip');
              setTimeout(() => valEl.classList.remove('flip'), 500);
            }
          } catch {}
        });
      }
      if (listEl) listEl.style.minHeight = '';
    }
  }
}

function openRename(id, currentName) {
  const dialog = el('#rename-dialog');
  const input = el('#rename-input');
  input.value = currentName || '';
  // Prepare subtle slide-in for input and actions (unified with other UI)
  try {
    input.classList.remove('fade-slide-in', 'show');
    // Force reflow so next class addition triggers transition even on repeated opens
    // eslint-disable-next-line no-unused-expressions
    void input.offsetWidth;
    input.classList.add('fade-slide-in');
    requestAnimationFrame(() => {
      input.classList.add('show');
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
      if (!Array.isArray(state.tombstones)) state.tombstones = [];
      if (!Array.isArray(state.historyTombstones)) state.historyTombstones = [];
      try { if (Array.isArray(state.counters)) state.counters.forEach(c => { if (c && typeof c.archived !== 'boolean') c.archived = false; }); } catch {}
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
              state = { counters: [], tombstones: [], historyTombstones: [], ui: state.ui || { panel: { x: null, y: null, w: null, h: null }, theme: 'pink' } };
              save();
              render();
            }
          };
          card.addEventListener('transitionend', onEnd);
          setTimeout(onEnd, 320 + i * 20);
        });
      } else {
        state = { counters: [], tombstones: [], historyTombstones: [], ui: state.ui || { panel: { x: null, y: null, w: null, h: null }, theme: 'pink' } };
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
  const btnArchived = el('#btn-archived');
  if (btnArchived) {
    btnArchived.addEventListener('click', () => toggleArchivedViewAnimated());
  }
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
  if (histDlg) {
    histDlg.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(histDlg); });
    enableBackdropClose(histDlg);
  }
  if (renDlg) {
    renDlg.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(renDlg); });
    enableBackdropClose(renDlg);
  }

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
    // Local tap shadow feedback for theme button
    const onTapOn = () => { try { themeBtn.classList.remove('tap-flash'); void themeBtn.offsetWidth; themeBtn.classList.add('tap-flash'); } catch {} };
    const onTapOff = () => { try { themeBtn.classList.remove('tap-flash'); } catch {} };
    themeBtn.addEventListener('pointerdown', onTapOn);
    themeBtn.addEventListener('pointerup', () => setTimeout(onTapOff, TAP_FLASH_MS), { passive: true });
    themeBtn.addEventListener('pointercancel', onTapOff, { passive: true });
    themeBtn.addEventListener('touchstart', onTapOn, { passive: true });
    themeBtn.addEventListener('touchend', () => setTimeout(onTapOff, TAP_FLASH_MS), { passive: true });
  }

  // Click outside closes floating popover
  document.addEventListener('click', () => hidePopover());
  document.addEventListener('click', (e) => {
    try {
      // 若点击发生在备注浮层内部，直接忽略（不依赖冒泡阻断，兼容部分移动端事件行为）
      const inNote = e && e.target && e.target.closest && e.target.closest('#note-popover');
      if (inNote) return;
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (now < noteSuppressCloseUntil) return;
    } catch {}
    if (noteIgnoreNextClick > 0) { noteIgnoreNextClick -= 1; return; }
    hideNotePopover();
  });
  // Quicker close on outside tap: handle at pointerdown capture to avoid the extra click needed after blur
  document.addEventListener('pointerdown', (e) => {
    try {
      const inNote = e && e.target && e.target.closest && e.target.closest('#note-popover');
      if (inNote) return;
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (now < noteSuppressCloseUntil) return;
    } catch {}
    if (noteIgnoreNextClick > 0) { noteIgnoreNextClick -= 1; return; }
    hideNotePopover();
  }, true);
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
    const addFlash = (btn) => {
      try {
        if (!btn || btn.disabled) return;
        // 重新触发过渡：先移除、强制重排、再添加
        btn.classList.remove('tap-flash');
        // 强制 reflow 以重置过渡状态
        void btn.offsetWidth;
        btn.classList.add('tap-flash');
      } catch {}
    };
    const clearFlash = () => {
      try {
        const list = document.querySelectorAll('button.tap-flash');
        // 统一固定反馈时长，独立于按压时长
        list.forEach((b) => setTimeout(() => { try { b.classList.remove('tap-flash'); } catch {} }, TAP_FLASH_MS));
      } catch {}
    };
    // Pointer-friendly path
    document.addEventListener('pointerdown', (e) => {
      if (!isTouchLike(e)) return; // 只对触控/笔生效，避免影响桌面 hover
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (btn) addFlash(btn);
    }, true);
    // Fallback for browsers without Pointer Events
    document.addEventListener('touchstart', (e) => {
      const t = (e.target && e.target.closest) ? e.target.closest('button') : null;
      if (t) addFlash(t);
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
      if (isOpen) {
        hidePopover();
        try { gbtn.removeAttribute('aria-expanded'); } catch {}
        // 关闭时立刻移除“点击高亮”，与 PC 离开即取消一致
        try { gbtn.classList.remove('tap-flash'); } catch {}
      } else {
        try { gbtn.setAttribute('aria-expanded','true'); } catch {}
        openMenu();
      }
      // 防止移动端按钮保持焦点样式
      try { gbtn.blur(); } catch {}
    });
    // Local tap shadow feedback for global menu button
    const gTapOn = () => { try { gbtn.classList.remove('tap-flash'); void gbtn.offsetWidth; gbtn.classList.add('tap-flash'); } catch {} };
    const gTapOff = () => { try { gbtn.classList.remove('tap-flash'); } catch {} };
    gbtn.addEventListener('pointerdown', gTapOn);
    gbtn.addEventListener('pointerup', () => setTimeout(gTapOff, TAP_FLASH_MS), { passive: true });
    gbtn.addEventListener('pointercancel', gTapOff, { passive: true });
    gbtn.addEventListener('touchstart', gTapOn, { passive: true });
    gbtn.addEventListener('touchend', () => setTimeout(gTapOff, TAP_FLASH_MS), { passive: true });
    gbtn.addEventListener('pointerleave', (e) => {
      try { if (isTouchDevice()) return; } catch {}
      clearMenuOpenTimer();
      if (!movingIntoPopover(e)) scheduleHidePopover();
    });
    // 确保 touch/pointer 抬起后不保留选中态
    gbtn.addEventListener('pointerup', (e) => { try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} }, { passive: true });
    gbtn.addEventListener('touchend', (e) => { try { e.currentTarget && e.currentTarget.blur && e.currentTarget.blur(); } catch {} }, { passive: true });
  }
}

function closeAllMenus() { /* replaced by hidePopover */ }

// -- Cloud indicator interactions --
function bindCloudIndicator() {
  const cloudBtn = el('#cloud-indicator');
  if (!cloudBtn || cloudBtn.dataset.bound === '1') return;
  cloudBtn.dataset.bound = '1';

  const openCloudTip = () => {
    const p = ensurePopover();
    if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
    p.innerHTML = '';
    p.classList.remove('hiding');
    p.classList.add('tip');
    const tip = document.createElement('div');
    tip.className = 'item';
    const state = cloudBtn.getAttribute('data-state') || 'idle';
    const custom = cloudBtn.getAttribute('data-tip') || '';
    const statusText = custom || ({ idle: '同步未开始', syncing: '正在同步…', ok: '已同步', offline: '离线', error: '同步失败' }[state] || '云同步状态');
    let extra = '';
    try { const m = loadSyncMeta(); if (m && m.lastSyncedAt) extra = `（上次：${timeAgo(m.lastSyncedAt)}）`; } catch {}
    tip.textContent = `${statusText}${extra}`;
    p.appendChild(tip);
    const r = cloudBtn.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    p.style.left = '0px'; p.style.top = '0px';
    p.classList.remove('hidden');
    const pr = p.getBoundingClientRect();
    const pw = pr.width || 120; const ph = pr.height || 32;
    let left = Math.min(Math.max((r.left + r.right) / 2 - pw / 2, 8), vw - pw - 8);
    let top = Math.min(r.bottom + 8, vh - ph - 8); if (top < 8) top = 8;
    p.style.left = `${Math.round(left)}px`;
    p.style.top = `${Math.round(top)}px`;
    currentPopoverFor = 'cloud';
  };
  const movingIntoPopover = (e) => {
    const p = ensurePopover();
    const t = e && e.relatedTarget;
    return p && t && (t === p || p.contains(t));
  };
  const onEnter = () => { if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; } openCloudTip(); };
  const onLeave = (e) => { if (!movingIntoPopover(e)) scheduleHidePopover(); };
  cloudBtn.addEventListener('pointerenter', onEnter);
  cloudBtn.addEventListener('mouseenter', onEnter);
  cloudBtn.addEventListener('pointerleave', onLeave);
  cloudBtn.addEventListener('mouseleave', onLeave);

  let suppressNextClick = false;
  cloudBtn.addEventListener('click', async (e) => {
    if (suppressNextClick) { suppressNextClick = false; e.preventDefault(); e.stopPropagation(); return; }
    e.stopPropagation();
    try {
      if (__syncInFlight) { try { openCloudTip(); } catch {} return; }
      const cfg = loadSyncConfig();
      if (!cfg || !cfg.binId || !cfg.apiKey) { openSyncDialog(); return; }
      __syncInFlight = true;
      setCloudIndicator('syncing', '正在同步…');
      try { openCloudTip(); } catch {}
      await syncWithJsonBin(null, true);
    } finally { __syncInFlight = false; }
  });
  cloudBtn.addEventListener('pointerup', () => { try { cloudBtn.blur(); } catch {} }, { passive: true });
  cloudBtn.addEventListener('touchend', () => { try { cloudBtn.blur(); } catch {} }, { passive: true });

  // Touch long-press to show tip
  let cloudHoldTimer = null; let cloudHoldFired = false;
  const clearHold = () => { if (cloudHoldTimer) { clearTimeout(cloudHoldTimer); cloudHoldTimer = null; } };
  cloudBtn.addEventListener('pointerdown', () => {
    if (!isTouchDevice()) return;
    cloudHoldFired = false; clearHold();
    cloudHoldTimer = setTimeout(() => { cloudHoldTimer = null; cloudHoldFired = true; openCloudTip(); }, 500);
  }, { passive: true });
  cloudBtn.addEventListener('pointerup', () => {
    if (!isTouchDevice()) return;
    if (cloudHoldFired) { suppressNextClick = true; scheduleHidePopover(200); }
    clearHold();
  }, { passive: true });
  cloudBtn.addEventListener('pointercancel', () => { if (isTouchDevice()) clearHold(); }, { passive: true });
}

// 全局事件委托兜底（hover/click）：避免因个别时序问题导致初次未绑定
function installCloudDelegates() {
  if (window.__cloudDelegatesInstalled) return;
  window.__cloudDelegatesInstalled = true;
  const isCloud = (t) => !!(t && t.closest && t.closest('#cloud-indicator'));
  const openTipFor = (btn) => {
    const p = ensurePopover();
    if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
    p.innerHTML = '';
    p.classList.remove('hiding');
    p.classList.add('tip');
    const tip = document.createElement('div');
    tip.className = 'item';
    const state = btn.getAttribute('data-state') || 'idle';
    const custom = btn.getAttribute('data-tip') || '';
    const statusText = custom || ({ idle: '同步未开始', syncing: '正在同步…', ok: '已同步', offline: '离线', error: '同步失败' }[state] || '云同步状态');
    let extra = '';
    try { const m = loadSyncMeta(); if (m && m.lastSyncedAt) extra = `（上次：${timeAgo(m.lastSyncedAt)}）`; } catch {}
    tip.textContent = `${statusText}${extra}`;
    p.appendChild(tip);
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    p.style.left = '0px'; p.style.top = '0px';
    p.classList.remove('hidden');
    const pr = p.getBoundingClientRect();
    const pw = pr.width || 120; const ph = pr.height || 32;
    let left = Math.min(Math.max((r.left + r.right) / 2 - pw / 2, 8), vw - pw - 8);
    let top = Math.min(r.bottom + 8, vh - ph - 8); if (top < 8) top = 8;
    p.style.left = `${Math.round(left)}px`;
    p.style.top = `${Math.round(top)}px`;
    currentPopoverFor = 'cloud';
  };
  document.addEventListener('mouseover', (e) => {
    const btn = isCloud(e.target) ? e.target.closest('#cloud-indicator') : null;
    if (!btn) return;
    try { openTipFor(btn); } catch {}
  }, true);
  document.addEventListener('mouseout', (e) => {
    const btn = isCloud(e.target) ? e.target.closest('#cloud-indicator') : null;
    if (!btn) return;
    scheduleHidePopover();
  }, true);
  document.addEventListener('click', async (e) => {
    const btn = isCloud(e.target) ? e.target.closest('#cloud-indicator') : null;
    if (!btn) return;
    e.stopPropagation();
    try {
      if (__syncInFlight) { try { openTipFor(btn); } catch {} return; }
      const cfg = loadSyncConfig();
      if (!cfg || !cfg.binId || !cfg.apiKey) { openSyncDialog(); return; }
      __syncInFlight = true;
      setCloudIndicator('syncing', '正在同步…');
      try { openTipFor(btn); } catch {}
      await syncWithJsonBin(null, true);
    } finally { __syncInFlight = false; }
  }, true);
}

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
  // 避免单点异常阻断后续初始化流程
  try { setupUI(); } catch {}
  // 预创建悬浮气泡容器，避免首次悬停/长按时的创建延迟
  try { ensurePopover(); } catch {}
  // 提前绑定云按钮与全局兜底，避免首次未响应
  try { bindCloudIndicator(); } catch {}
  try { installCloudDelegates(); } catch {}
  try { setupDrag(); } catch {}
  try { applyPanelRect(); } catch {}
  try { setupResizeObserver(); } catch {}
  try { setupKeyboardAvoidance(); } catch {}
  try { setupFooter(); } catch {}
  try { render(); } catch {}
  // 启动自动同步逻辑（如已配置且开启）
  try { setupAutoSync(); } catch {}
  // 初始化云图标状态（在线/离线）
  try { if (typeof navigator !== 'undefined' && navigator.onLine === false) setCloudIndicator('offline', '离线'); } catch {}
  // 首次使用：默认弹出“使用帮助”
  try { maybeShowFirstRunHelp(); } catch {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM 已可用，立即初始化，避免等待事件派发造成的可感知延迟
  init();
}

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
  const BASE_GAP = 12; // base gap above keyboard or accessory bar
  const GAP = BASE_GAP; // rely on visualViewport to include any accessory bars
  const EXTRA_SAFE = 28; // extra clearance to unify behavior across browsers (covers Chrome accessory bar)

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
    if (!activeInput || !document.contains(activeInput)) { restoreTransforms(); return; }
    const container = getContainerFor(activeInput);
    if (!container) { restoreTransforms(); return; }
    // 统一用“页面坐标”计算遮挡，避免不同浏览器对 rect/visualViewport 基准不一致
    const r = activeInput.getBoundingClientRect();
    const pageScrollY = (window.scrollY || window.pageYOffset || 0);
    // Visual viewport metrics
    const vvOffsetTop = vv ? (vv.offsetTop || 0) : 0; // relative to layout viewport, for fixed elements
    const vvClientHeight = vv ? (vv.height || window.innerHeight) : window.innerHeight;
    // Visual viewport bottom in page coordinates (for document elements)
    const vvPageTop = vv ? ((typeof vv.pageTop === 'number') ? vv.pageTop : (pageScrollY + vvOffsetTop)) : pageScrollY;
    const pageVVBottom = vvPageTop + vvClientHeight;
    const pageElBottom = r.bottom + pageScrollY;
    const overlap = pageElBottom + GAP - pageVVBottom;
    let shift = Math.max(0, Math.ceil(overlap));

    if (container.id === 'note-popover') {
      // Reposition the fixed popover upward just enough
      const popRect = container.getBoundingClientRect();
      const maxTop = (vvOffsetTop + vvClientHeight) - popRect.height - GAP;
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

    // For dialogs or the main panel, translate vertically by -shift（相对其原始 transform）
    if (shift > 0) {
      // Unify across browsers by adding a small extra clearance (matches Quark/stock browser behavior)
      if (!(container && container.id === 'note-popover')) {
        shift += EXTRA_SAFE;
      }
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
      // Run a second pass after viewport/IME settles
      setTimeout(adjust, 90);
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

// Footer: only repo link and privacy dialog
function setupFooter() {
  const footer = document.querySelector('.app-footer');
  if (!footer) return;
  // year
  const y = document.querySelector('#footer-year');
  if (y) y.textContent = String(new Date().getFullYear());
  // repo link (can be customized via data-repo on footer)
  const repoUrl = footer.getAttribute('data-repo') || '';
  const repoEl = document.querySelector('#footer-repo');
  if (repoEl) {
    if (repoUrl) repoEl.href = repoUrl; else repoEl.remove();
  }
  // privacy dialog
  const openBtn = document.querySelector('#footer-privacy');
  const closeBtn = document.querySelector('#privacy-close');
  const dlg = document.querySelector('#privacy-dialog');
  if (openBtn && dlg) openBtn.addEventListener('click', () => openModal(dlg));
  if (closeBtn && dlg) closeBtn.addEventListener('click', () => closeModal(dlg));
  enableBackdropClose(dlg);

  // help dialog
  const helpOpen = document.querySelector('#footer-help');
  const helpClose = document.querySelector('#help-close');
  const helpDlg = document.querySelector('#help-dialog');
  if (helpOpen && helpDlg) helpOpen.addEventListener('click', () => openModal(helpDlg));
  if (helpClose && helpDlg) helpClose.addEventListener('click', () => closeModal(helpDlg));
  enableBackdropClose(helpDlg);
}

// Global menu popover content
function showGlobalMenu(anchorRect) {
  const elp = ensurePopover();
  if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
  elp.classList.remove('hiding');
  elp.classList.remove('tip');
  elp.innerHTML = '';
  const mk = (text, cls, handler) => {
    const b = document.createElement('button');
    b.className = 'item' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.addEventListener('click', (e) => { e.stopPropagation(); handler(); hidePopover(); });
    try { b.style.animationDelay = (elp.children.length * 0.05) + 's'; } catch {}
    return b;
  };
  // 导入/导出放在最上面
  elp.appendChild(mk('导入 JSON…', '', () => {
    const inp = el('#file-import');
    if (inp) inp.click();
  }));
  elp.appendChild(mk('导出 JSON', '', () => exportJSON()));
  // 仅保留“同步设置…”等常用项
  elp.appendChild(mk('同步设置…', '', () => {
    try {
      const dlg = el('#sync-dialog');
      if (dlg) openSyncDialog();
    } catch {}
  }));

  //（已移除触屏拖动排序切换项）

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

// 首次打开设备时弹出帮助：使用 localStorage 做轻量标记（不随云端同步）
function maybeShowFirstRunHelp() {
  try {
    const KEY = 'counter-buddy-help-shown-v1';
    if (localStorage.getItem(KEY)) return; // 已显示过
    const dlg = document.querySelector('#help-dialog');
    if (!dlg) return;
    // 稍微延时，避免与首屏渲染/自动同步的提示重叠
    setTimeout(() => {
      try { openModal(dlg); localStorage.setItem(KEY, '1'); } catch {}
    }, 300);
  } catch {}
}

// 旧的“强制刷新（更新缓存）”已在 GitHub Pages 部署下取消暴露入口

// --- 同步设置对话框 ---
function openSyncDialog() {
  const dlg = el('#sync-dialog');
  const inId = el('#sync-binid');
  const inKey = el('#sync-apikey');
  const inAuto = el('#sync-auto');
  const status = el('#sync-status');
  const cfg = loadSyncConfig();
  if (inId) inId.value = cfg.binId || '';
  if (inKey) inKey.value = cfg.apiKey || '';
  if (inAuto) inAuto.checked = !!cfg.auto;
  if (status) status.textContent = '';
  // 通过克隆按钮重置监听器（与其它对话框保持一致的写法）
  const testOld = el('#sync-test');
  const saveOld = el('#sync-save');
  const pullOld = el('#sync-pull');
  const uploadOld = el('#sync-upload');
  const unlinkOld = el('#sync-unlink');
  if (testOld) {
    const testBtn = testOld.cloneNode(true);
    testOld.parentNode.replaceChild(testBtn, testOld);
    testBtn.onclick = async () => {
      if (status) status.textContent = '测试中…';
      const id = inId ? inId.value.trim() : '';
      const key = inKey ? inKey.value.trim() : '';
      try {
        const res = await testJsonBinConnection(id, key);
        if (status) status.textContent = res.message || (res.ok ? '连接成功' : '连接失败');
        status && status.classList && status.classList.toggle('error', !res.ok);
      } catch { if (status) status.textContent = '测试失败'; }
    };
  }
  if (saveOld) {
    const saveBtn = saveOld.cloneNode(true);
    saveOld.parentNode.replaceChild(saveBtn, saveOld);
    saveBtn.onclick = () => {
      const id = inId ? inId.value.trim() : '';
      const key = inKey ? inKey.value.trim() : '';
      const auto = inAuto ? !!inAuto.checked : false;
      saveSyncConfig({ binId: id, apiKey: key, auto });
      if (status) status.textContent = '已保存本机设置';
      // 若开启了自动同步，确保自动同步逻辑已安装
      try { if (auto) setupAutoSync(); } catch {}
      // 稍作停留后关闭，给用户反馈
      setTimeout(() => closeModal(dlg), 300);
    };
  }
  // 同步设置输入框：回车直接保存，Esc 关闭（与桌面一致）
  const bindEnterEsc = (inp) => {
    if (!inp) return;
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); try { el('#sync-save').click(); } catch {} }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModal(dlg); }
    };
  };
  bindEnterEsc(inId);
  bindEnterEsc(inKey);
  // 已移除“同步（合并）”按钮：改为点击右上角云图标执行手动同步
  if (pullOld) {
    // 拉取：覆盖本地
    const pullBtn = pullOld.cloneNode(true);
    pullOld.parentNode.replaceChild(pullBtn, pullOld);
    pullBtn.onclick = async () => {
      if (status) status.textContent = '拉取中…';
      const ok = await pullFromJsonBin();
      if (status) status.textContent = ok ? '已完成从云端拉取（覆盖本地）' : '已取消或失败';
    };
  }
  if (uploadOld) {
    const uploadBtn = uploadOld.cloneNode(true);
    uploadOld.parentNode.replaceChild(uploadBtn, uploadOld);
    uploadBtn.onclick = async () => {
      if (status) status.textContent = '上传中…';
      const ok = await pushToJsonBin();
      if (status) status.textContent = ok ? '已上传到云端（覆盖云端）' : '已取消或失败';
    };
  }
  if (unlinkOld) {
    const unlinkBtn = unlinkOld.cloneNode(true);
    unlinkOld.parentNode.replaceChild(unlinkBtn, unlinkOld);
    unlinkBtn.onclick = async () => {
      const ok = await confirmDialog({ title: '解除绑定', text: '将清除本机保存的 Bin ID 与 API Key，不影响云端数据。继续？', danger: true, okText: '解除' });
      if (!ok) return;
      try {
        localStorage.removeItem(syncStoreKey);
        localStorage.removeItem(syncMetaKey);
      } catch {}
      if (inId) inId.value = '';
      if (inKey) inKey.value = '';
      if (inAuto) inAuto.checked = false;
      if (status) status.textContent = '已解除绑定（仅清除本机设置）';
    };
  }
  // API Key 显示/隐藏切换按钮：避免残留旧监听器，统一用克隆重绑
  const toggleOld = el('#sync-apikey-toggle');
  if (toggleOld) {
    const toggleBtn = toggleOld.cloneNode(true);
    toggleOld.parentNode.replaceChild(toggleBtn, toggleOld);
    toggleBtn.onclick = () => {
      if (!inKey) return;
      const isPwd = inKey.type === 'password';
      inKey.type = isPwd ? 'text' : 'password';
      toggleBtn.textContent = isPwd ? '隐藏' : '显示';
      toggleBtn.setAttribute('aria-pressed', String(isPwd));
      try { inKey.focus(); } catch {}
    };
  }
  // 关闭按钮
  const closeOld = el('#sync-close');
  if (closeOld) {
    const btn = closeOld.cloneNode(true);
    closeOld.parentNode.replaceChild(btn, closeOld);
    btn.onclick = () => closeModal(dlg);
  }
  // Esc/点击遮罩关闭
  if (dlg) {
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(dlg); }, { once: true });
    enableBackdropClose(dlg);
    // 高级设置：为 details 添加平滑展开/收起动画（含关闭动画）
    try {
      const adv = dlg.querySelector('details.advanced');
      if (adv && !adv.dataset.animBound) {
        adv.dataset.animBound = '1';
        const summary = adv.querySelector('summary');
        const content = adv.querySelector('.adv-content');
        if (summary && content) {
          summary.addEventListener('click', (e) => {
            e.preventDefault();
            const isOpen = adv.hasAttribute('open');
            const prefersReduced = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            if (prefersReduced) { if (isOpen) adv.removeAttribute('open'); else adv.setAttribute('open', ''); return; }
            content.style.overflow = 'hidden';
            // 为避免内容过长时出现“跳动感”，记录 summary 在滚动容器内的位置，之后做微调以保持锚点视觉稳定
            const scroller = dlg.querySelector('.modal-body');
            const beforeTop = (() => {
              try {
                if (!scroller) return null;
                const a = summary.getBoundingClientRect();
                const b = scroller.getBoundingClientRect();
                return a.top - b.top;
              } catch { return null; }
            })();
            if (isOpen) {
              // 收起：箭头提前旋回（避免视觉延迟），收起速度保持偏快
              adv.setAttribute('data-closing', '');
              const start = content.scrollHeight;
              try { content.style.transitionProperty = 'height'; content.style.transitionTimingFunction = 'cubic-bezier(.2,.7,.2,1)'; content.style.transitionDuration = '0.24s'; } catch {}
              try { content.style.height = start + 'px'; } catch {}
              try { void content.offsetHeight; } catch {}
              try { content.style.height = '0px'; } catch {}
              const onEnd = () => {
                try {
                  content.style.height = '';
                  adv.removeAttribute('open');
                  adv.removeAttribute('data-closing');
                  // 清理临时过渡设置，交回给 CSS
                  content.style.transitionProperty = '';
                  content.style.transitionTimingFunction = '';
                  content.style.transitionDuration = '';
                } catch {}
                content.removeEventListener('transitionend', onEnd);
              };
              content.addEventListener('transitionend', onEnd);
              // 调整滚动使 summary 位置尽量保持
              if (scroller && beforeTop != null) {
                try {
                  requestAnimationFrame(() => {
                    const a = summary.getBoundingClientRect();
                    const b = scroller.getBoundingClientRect();
                    const afterTop = a.top - b.top;
                    scroller.scrollTop += (afterTop - beforeTop);
                  });
                } catch {}
              }
            } else {
              // 展开：先设置 open 让箭头立即旋下，展开速度放慢一些
              adv.setAttribute('open', '');
              const end = content.scrollHeight;
              try { content.style.transitionProperty = 'height'; content.style.transitionTimingFunction = 'cubic-bezier(.2,.7,.2,1)'; content.style.transitionDuration = '0.32s'; } catch {}
              try { content.style.height = '0px'; } catch {}
              try { void content.offsetHeight; } catch {}
              try { content.style.height = end + 'px'; } catch {}
              const onEnd = () => {
                try {
                  content.style.height = '';
                  // 清理临时过渡设置，交回给 CSS
                  content.style.transitionProperty = '';
                  content.style.transitionTimingFunction = '';
                  content.style.transitionDuration = '';
                } catch {}
                content.removeEventListener('transitionend', onEnd);
              };
              content.addEventListener('transitionend', onEnd);
              // 调整滚动使 summary 位置尽量保持
              if (scroller && beforeTop != null) {
                try {
                  requestAnimationFrame(() => {
                    const a = summary.getBoundingClientRect();
                    const b = scroller.getBoundingClientRect();
                    const afterTop = a.top - b.top;
                    scroller.scrollTop += (afterTop - beforeTop);
                  });
                } catch {}
              }
            }
          });
        }
      }
    } catch {}
    openModal(dlg);
    // 聚焦到第一个输入框
    setTimeout(() => { try { inId && inId.focus(); inId && inId.select && inId.select(); } catch {} }, 0);
  }
  // Bind cloud indicator interactions (idempotent) at the end once DOM is ready
  try { bindCloudIndicator(); } catch {}
}
