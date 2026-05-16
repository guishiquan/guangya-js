// ==UserScript==
// @name         光鸭云盘 aria2 助手
// @namespace    guangyapan.aria2-helper
// @version      0.1.0
// @description  在光鸭云盘网页里把勾选的文件夹/文件递归展开，调用官方签名直链 API，再批量推送到 aria2，保留云端目录结构。
// @author       gui
// @match        https://guangyapan.com/*
// @match        https://*.guangyapan.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.guangyapan.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ===== 常量 =====
  const SCRIPT_NAME = '光鸭→aria2';
  const ROOT_ID = 'gyp-aria2-helper-root';
  const API_HOST = 'https://api.guangyapan.com';
  const LIST_PATH = '/userres/v1/file/get_file_list';
  const DOWNLOAD_PATH = '/userres/v1/get_res_download_url';
  const STORAGE_AUTH_KEY = 'GYP_ARIA2_AUTH';
  const STORAGE_CONFIG_KEY = 'GYP_ARIA2_CONFIG';
  const DEFAULT_CONFIG = Object.freeze({
    rpcUrl: 'http://127.0.0.1:6800/jsonrpc',
    secret: '',
    downloadRoot: '/downloads/guangyapan',
    resolveConcurrency: 3,
    multicallBatch: 50,
    manualAuth: { authorization: '', did: '', dt: '' },
  });
  const LIST_PAGE_SIZE = 100;
  const MAX_PAGES_PER_DIR = 200;
  const MAX_FILES = 10000;
  const MAX_DIRS = 600;
  const LOG_RING_MAX = 200;

  // ===== 运行时状态 =====
  const STATE = {
    config: deepClone(DEFAULT_CONFIG),
    capturedAuth: { authorization: '', did: '', dt: '' },
    dirCache: Object.create(null),   // parentId -> {items, capturedAt}
    lastDirParentId: '',
    lastListUrl: '',                  // 从拦截响应里学到的真实 URL，用于自己往外打
    lastDownloadUrl: '',
    logs: [],                         // ring buffer
    ui: null,                         // 见 mountPanel
    busy: false,
    debug: false,
    hookInstalled: false,
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // ===== 日志 =====
  function pushLog(msg, level = 'info') {
    const line = {
      ts: new Date().toISOString().slice(11, 19),
      level,
      msg: String(msg == null ? '' : msg),
    };
    STATE.logs.push(line);
    if (STATE.logs.length > LOG_RING_MAX) {
      STATE.logs.splice(0, STATE.logs.length - LOG_RING_MAX);
    }
    try {
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
        `[${SCRIPT_NAME}] ${line.msg}`
      );
    } catch (_) { /* console may not exist in some sandboxes */ }
    if (STATE.ui && typeof STATE.ui.renderLog === 'function') {
      try { STATE.ui.renderLog(); } catch (_) { /* ignore */ }
    }
  }
  const log = (m) => pushLog(m, 'info');
  const warn = (m) => pushLog(m, 'warn');
  const errorLog = (m) => pushLog(m, 'error');

  // ===== 存储 =====
  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const value = GM_getValue(key, undefined);
        if (value !== undefined) return value;
      }
    } catch (_) { /* ignore */ }
    return fallback;
  }
  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
      }
    } catch (_) { /* ignore */ }
  }
  function loadConfig() {
    const raw = gmGet(STORAGE_CONFIG_KEY, null);
    const merged = deepClone(DEFAULT_CONFIG);
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(merged)) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) {
          if (key === 'manualAuth' && raw.manualAuth && typeof raw.manualAuth === 'object') {
            merged.manualAuth = {
              authorization: String(raw.manualAuth.authorization || ''),
              did: String(raw.manualAuth.did || ''),
              dt: String(raw.manualAuth.dt || ''),
            };
          } else {
            merged[key] = raw[key];
          }
        }
      }
    }
    merged.resolveConcurrency = Math.max(1, Math.min(8, Number(merged.resolveConcurrency) || 3));
    merged.multicallBatch = Math.max(1, Math.min(200, Number(merged.multicallBatch) || 50));
    STATE.config = merged;
  }
  function saveConfig() {
    gmSet(STORAGE_CONFIG_KEY, STATE.config);
  }
  function loadCapturedAuth() {
    const raw = gmGet(STORAGE_AUTH_KEY, null);
    if (raw && typeof raw === 'object') {
      STATE.capturedAuth = {
        authorization: normalizeAuthorization(raw.authorization || ''),
        did: String(raw.did || ''),
        dt: String(raw.dt || ''),
      };
    }
  }
  function persistCapturedAuth() {
    gmSet(STORAGE_AUTH_KEY, STATE.capturedAuth);
  }

  // ===== 认证 =====
  function normalizeAuthorization(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return /^Bearer\s+/i.test(text) ? text : `Bearer ${text}`;
  }

  function saveCapturedHeader(name, value) {
    const lower = String(name).toLowerCase();
    const text = String(value || '').trim();
    if (!text) return;
    let changed = false;
    if (lower === 'authorization') {
      const normalized = normalizeAuthorization(text);
      if (STATE.capturedAuth.authorization !== normalized) {
        STATE.capturedAuth.authorization = normalized;
        changed = true;
      }
    } else if (lower === 'did' || lower === 'dt') {
      if (STATE.capturedAuth[lower] !== text) {
        STATE.capturedAuth[lower] = text;
        changed = true;
      }
    }
    if (changed) {
      persistCapturedAuth();
      if (STATE.ui && typeof STATE.ui.renderAuthStatus === 'function') {
        try { STATE.ui.renderAuthStatus(); } catch (_) { /* ignore */ }
      }
    }
  }

  // 手填非空字段优先，否则取最近捕获
  function getAuth() {
    const manual = STATE.config.manualAuth || {};
    const cap = STATE.capturedAuth;
    return {
      authorization: normalizeAuthorization(manual.authorization) || cap.authorization,
      did: (manual.did && manual.did.trim()) || cap.did,
      dt: (manual.dt && manual.dt.trim()) || cap.dt,
    };
  }

  function authStatusSummary() {
    const a = getAuth();
    const have = [];
    const miss = [];
    (a.authorization ? have : miss).push('Bearer');
    (a.did ? have : miss).push('did');
    (a.dt ? have : miss).push('dt');
    if (!miss.length) return { ok: true, text: '已就绪：' + have.join(' / ') };
    return { ok: false, text: `缺少 ${miss.join(' / ')}（请在云盘里浏览一次目录或在设置里手填）` };
  }

  // ===== GM_xmlhttpRequest Promise 封装 =====
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用，请检查脚本管理器权限'));
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url: opts.url,
          headers: opts.headers || {},
          data: typeof opts.data === 'string' ? opts.data : undefined,
          timeout: Number(opts.timeout) || 30000,
          anonymous: false,
          onload: (res) => resolve({
            status: res.status,
            responseText: typeof res.responseText === 'string' ? res.responseText : '',
            responseHeaders: res.responseHeaders || '',
          }),
          onerror: (err) => reject(new Error(`网络错误：${(err && err.error) || '未知'} | ${opts.method || 'GET'} ${opts.url}`)),
          ontimeout: () => reject(new Error(`请求超时 | ${opts.method || 'GET'} ${opts.url}`)),
          onabort: () => reject(new Error('请求被中止')),
        });
      } catch (e) {
        reject(new Error(`GM_xmlhttpRequest 调用失败：${e && e.message || e}`));
      }
    });
  }

  // ===== 拦截器：在页面上下文里注入 <script> 补丁 fetch/XHR，通过 CustomEvent 把抓到的 auth + list 响应传回 userscript 沙箱 =====
  // 为何用注入：Tampermonkey 严格模式下，从 userscript 直接改 unsafeWindow.fetch 不会渗透到页面打包好的引用里；
  // 把代码作为 <script> 注入页面 DOM 由页面引擎执行，是 userscript 社区通用的稳态做法。
  const CAPTURE_EVENT = '__GYP_ARIA2_CAPTURE__';

  function installInterceptors() {
    const code = `
(() => {
  if (window.__gypAria2HookInstalled) return;
  window.__gypAria2HookInstalled = true;

  const EVENT = ${JSON.stringify(CAPTURE_EVENT)};

  function emit(detail) {
    try { window.dispatchEvent(new CustomEvent(EVENT, { detail })); } catch (_) {}
  }

  function normalizeHeaders(h) {
    const out = {};
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      for (const [k, v] of h.entries()) out[String(k).toLowerCase()] = v;
      return out;
    }
    if (Array.isArray(h)) {
      for (const [k, v] of h) out[String(k).toLowerCase()] = v;
      return out;
    }
    if (typeof h === 'object') {
      for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = v;
    }
    return out;
  }

  function isGuangya(url) {
    return typeof url === 'string' && /guangyapan/i.test(url);
  }
  function looksLikeListUrl(url) {
    return typeof url === 'string' && /(?:get_file_list|getFileList|file[_-]?list|\\/list(?:[?\\/]|$))/i.test(url);
  }
  function looksLikeListBody(bodyText) {
    if (typeof bodyText !== 'string' || !bodyText) return false;
    return /"parentId"\\s*:/i.test(bodyText);
  }

  function handleListCapture(url, reqBody, text) {
    if (!isGuangya(url)) return;
    if (!looksLikeListUrl(url) && !looksLikeListBody(reqBody)) return;
    emit({ kind: 'list', url, reqBody: reqBody || '', text: text || '' });
  }

  const origFetch = window.fetch && window.fetch.bind(window);
  if (origFetch) {
    window.fetch = function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const headers = normalizeHeaders((init && init.headers) || (input && input.headers));
      const body = init && typeof init.body === 'string' ? init.body : '';
      if (isGuangya(url)) {
        emit({ kind: 'seen', via: 'fetch', url });
        for (const name of ['authorization', 'did', 'dt']) {
          if (headers[name]) emit({ kind: 'auth', name, value: headers[name] });
        }
      }
      const p = origFetch(input, init);
      if (isGuangya(url) && (looksLikeListUrl(url) || looksLikeListBody(body))) {
        p.then((res) => {
          if (!res || !res.ok) return;
          let clone;
          try { clone = res.clone(); } catch (_) { return; }
          clone.text().then((text) => handleListCapture(url, body, text)).catch(() => {});
        }).catch(() => {});
      }
      return p;
    };
  }

  const rawOpen = XMLHttpRequest.prototype.open;
  const rawSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const rawSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__gypAria2Url = String(url || '');
    this.__gypAria2Body = '';
    return rawOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(name, value) {
    const url = this.__gypAria2Url;
    if (isGuangya(url)) {
      const lname = String(name).toLowerCase();
      if (lname === 'authorization' || lname === 'did' || lname === 'dt') {
        emit({ kind: 'auth', name: lname, value: String(value) });
      }
    }
    return rawSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const url = this.__gypAria2Url;
    if (typeof body === 'string') this.__gypAria2Body = body;
    if (isGuangya(url)) {
      emit({ kind: 'seen', via: 'xhr', url });
      this.addEventListener('load', () => {
        if (this.status >= 200 && this.status < 300) {
          handleListCapture(url, this.__gypAria2Body || '', this.responseText || '');
        }
      });
    }
    return rawSend.apply(this, arguments);
  };

  emit({ kind: 'hook-installed' });
})();
`;
    try {
      const el = document.createElement('script');
      el.textContent = code;
      // 关键：先挂事件监听器再注入，避免 hook-installed 事件先发后听导致漏掉
      window.addEventListener(CAPTURE_EVENT, (event) => {
        const detail = event && event.detail;
        if (!detail || typeof detail !== 'object') return;
        try {
          if (detail.kind === 'hook-installed') {
            STATE.hookInstalled = true;
            log('已注入页面拦截器');
            if (STATE.ui && typeof STATE.ui.renderDirStatus === 'function') STATE.ui.renderDirStatus();
          } else if (detail.kind === 'seen') {
            if (STATE.debug) log(`[seen ${detail.via}] ${shortUrl(detail.url)}`);
          } else if (detail.kind === 'auth' && detail.name && detail.value) {
            saveCapturedHeader(detail.name, detail.value);
          } else if (detail.kind === 'list') {
            const reqBody = safeJsonParse(detail.reqBody);
            const data = safeJsonParse(detail.text);
            const items = data ? extractItems(data) : [];
            if (STATE.debug) {
              log(`[list] ${shortUrl(detail.url)} → ${items.length} 项`);
              if (data && items.length === 0) dumpResponseShape(detail.url, data, detail.text);
            }
            cacheListResponse(reqBody, data, items, detail.url);
          }
        } catch (e) {
          warn('处理捕获事件出错：' + (e && e.message || e));
        }
      });

      (document.documentElement || document.head || document.body).appendChild(el);
      el.remove();
    } catch (e) {
      errorLog('注入拦截器失败：' + (e && e.message || e));
    }
  }

  function shortUrl(url) {
    if (typeof url !== 'string') return '';
    if (url.length <= 80) return url;
    return url.slice(0, 50) + '...' + url.slice(-25);
  }

  function dumpResponseShape(url, data, rawText) {
    try {
      const topKeys = data && typeof data === 'object' ? Object.keys(data) : [];
      log(`[shape] ${shortUrl(url)} 顶层 keys = ${JSON.stringify(topKeys)}`);
      // 把响应里前 2 层每个数组的长度也打出来，便于定位列表所在路径
      const arrays = [];
      (function walk(node, path) {
        if (!node || typeof node !== 'object' || path.length > 3) return;
        if (Array.isArray(node)) {
          arrays.push({ path: path.join('.'), len: node.length, sample: node[0] });
          return;
        }
        for (const [k, v] of Object.entries(node)) walk(v, path.concat(k));
      })(data, []);
      const arrs = arrays.slice(0, 5).map((a) => `${a.path}[${a.len}]`).join(', ');
      log(`[shape] 数组分布：${arrs || '(无)'}`);
      if (arrays[0] && arrays[0].sample && typeof arrays[0].sample === 'object') {
        log(`[shape] 第一个数组首元素 keys = ${JSON.stringify(Object.keys(arrays[0].sample))}`);
      }
      const snippet = (rawText || '').slice(0, 300).replace(/\s+/g, ' ');
      log(`[shape] 原始首段：${snippet}`);
    } catch (e) {
      warn('dumpResponseShape 失败：' + (e && e.message || e));
    }
  }

  function cacheListResponse(requestBody, responseData, precomputedItems, capturedUrl) {
    if (!responseData) return;
    const items = Array.isArray(precomputedItems) ? precomputedItems : extractItems(responseData);
    if (!items.length) return;
    const parentId = String(
      (requestBody && (requestBody.parentId || requestBody.parent_id)) ||
      items[0].parentId ||
      ''
    );
    if (!parentId) return;
    const bucket = STATE.dirCache[parentId] || { items: [], capturedAt: 0 };
    const seen = new Set(bucket.items.map((it) => it.fileId));
    for (const it of items) {
      if (it.fileId && !seen.has(it.fileId)) {
        bucket.items.push(it);
        seen.add(it.fileId);
      }
    }
    bucket.capturedAt = Date.now();
    STATE.dirCache[parentId] = bucket;
    STATE.lastDirParentId = parentId;
    if (capturedUrl && typeof capturedUrl === 'string') {
      STATE.lastListUrl = capturedUrl;
    }
    if (STATE.ui && typeof STATE.ui.renderDirStatus === 'function') {
      try { STATE.ui.renderDirStatus(); } catch (_) { /* ignore */ }
    }
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  // ===== 列表条目提取 =====
  // 字段别名表：响应里项目对象可能用任一种命名，挑第一个非空值
  const ID_KEYS = [
    'fileId', 'id', 'resourceId', 'resId', 'bizId', 'objId',
    'shareFileId', 'share_file_id', 'dirId', 'dir_id',
    'folderId', 'folder_id', 'fileID', 'file_id',
  ];
  const NAME_KEYS = [
    'name', 'fileName', 'file_name', 'filename',
    'resName', 'resourceName', 'title', 'displayName', 'display_name',
    'originalName', 'original_name', 'fileFullName', 'fullName',
    'dirName', 'dir_name', 'folderName', 'folder_name',
  ];
  const PARENT_KEYS = ['parentId', 'parent_id', 'pid', 'parentFileId', 'parent_file_id'];
  const SIZE_KEYS = ['fileSize', 'size', 'bytes', 'file_size', 'contentLength', 'content_length'];
  const FILE_EXT_RE = /\.[a-z0-9]{1,8}$/i;
  const LIST_KEY_RE = /^(?:data|list|items|rows|records|files|fileList|file_list|children|child_list|childList|result|resourceList|res_list)$/i;
  const DIR_TYPE_RE = /dir|folder|directory|catalog/i;
  const FILE_TYPE_RE = /file|video|image|audio|doc|text|subtitle|torrent/i;

  function findFirstValueByKeys(node, keys) {
    if (node == null) return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const v = findFirstValueByKeys(child, keys);
        if (v != null) return v;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(node, key) && node[key] != null && node[key] !== '') {
        return node[key];
      }
    }
    for (const v of Object.values(node)) {
      const found = findFirstValueByKeys(v, keys);
      if (found != null) return found;
    }
    return null;
  }

  function pickFirst(obj, keys) {
    for (const k of keys) {
      const v = obj[k];
      if (v != null && v !== '') return v;
    }
    return undefined;
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = pickFirst(raw, ID_KEYS);
    const rawName = pickFirst(raw, NAME_KEYS);
    if (id == null) return null;
    if (typeof rawName !== 'string') return null;
    const name = rawName.trim();
    const sid = String(id).trim();
    if (!sid || !name) return null;
    return {
      fileId: sid,
      name,
      parentId: String(pickFirst(raw, PARENT_KEYS) || '').trim(),
      isDir: guessIsDirectory(raw, name),
      fileSize: Number(pickFirst(raw, SIZE_KEYS) || 0) || 0,
      raw,
    };
  }

  // 目录判别：按 5 类信号依次判断（显式布尔 → 类型字段 → 目录暗示字段 → dirId 异于 fileId → 启发式）
  function guessIsDirectory(obj, name) {
    if (!obj || typeof obj !== 'object') return false;
    // 1) 显式布尔字段
    for (const k of ['isDir', 'is_dir', 'isFolder', 'is_folder', 'folder', 'directory', 'dir']) {
      const v = obj[k];
      if (v === true || v === 'true' || v === 1 || v === '1') return true;
      if (v === false || v === 'false' || v === 0 || v === '0') return false;
    }
    // 2) 类型字段文本判断
    for (const k of ['itemType', 'item_type', 'nodeType', 'node_type', 'type', 'kind',
      'fileType', 'file_type', 'resType', 'res_type', 'bizType', 'biz_type']) {
      const v = obj[k];
      if (v == null || v === '') continue;
      const s = String(v).toLowerCase();
      if (DIR_TYPE_RE.test(s)) return true;
      if (FILE_TYPE_RE.test(s)) return false;
    }
    // 3) 目录暗示字段（任一存在即视为目录）
    for (const k of ['dirName', 'dir_name', 'folderName', 'folder_name',
      'folderId', 'folder_id',
      'childCount', 'childrenCount', 'children_count',
      'dirCount', 'dir_count', 'folderCount', 'folder_count',
      'subCount', 'sub_count']) {
      if (obj[k] != null && obj[k] !== '') return true;
    }
    // 4) dirId 存在且 != fileId → 目录
    const dirId = String(obj.dirId || obj.dir_id || '').trim();
    const fileId = String(obj.fileId || obj.id || '').trim();
    if (dirId && fileId && dirId !== fileId) return true;
    // 5) 名字无扩展名 且 SIZE_KEYS 全为 0/空 → 偏向目录
    const hasExt = FILE_EXT_RE.test(name || '');
    const hasSize = SIZE_KEYS.some((k) => Number(obj[k] || 0) > 0);
    if (!hasExt && !hasSize) return true;
    return false;
  }

  function isDirectory(item) {
    return Boolean(item && item.isDir === true);
  }

  // 遍历响应 JSON，按「路径关键字」+「项数」打分，挑分数最高的数组作为列表
  function extractItems(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const candidates = [];
    const seen = new WeakSet();

    function walk(node, path, depth) {
      if (!node || typeof node !== 'object' || depth > 6) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        const items = node.map(normalizeItem).filter(Boolean);
        const lastKey = path[path.length - 1] || '';
        const lastIsListKey = LIST_KEY_RE.test(lastKey);
        const dataAncestor = path.indexOf('data') !== -1;
        const score = items.length
          + (lastIsListKey ? 500 : 0)
          + (dataAncestor ? 50 : 0);
        if (items.length || lastIsListKey) {
          candidates.push({ items, score, path: path.join('.') });
        }
        for (const child of node) walk(child, path, depth + 1);
        return;
      }
      for (const [k, v] of Object.entries(node)) walk(v, path.concat(k), depth + 1);
    }
    walk(payload, [], 0);

    if (!candidates.length) return [];
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].items;
  }

  // ===== 光鸭 API =====
  function getListUrl() {
    return STATE.lastListUrl || (API_HOST + LIST_PATH);
  }
  function getApiDownloadUrl() {
    if (STATE.lastDownloadUrl) return STATE.lastDownloadUrl;
    if (STATE.lastListUrl) {
      // 同一前缀下把列表路径换成下载路径
      return STATE.lastListUrl.replace(/\/file\/get_file_list(\?.*)?$/i, '/get_res_download_url');
    }
    return API_HOST + DOWNLOAD_PATH;
  }

  async function gypPost(url, body) {
    const auth = getAuth();
    if (!auth.authorization) {
      throw new Error('未捕获到光鸭 authorization，请在云盘里浏览一次目录刷新登录态');
    }
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      authorization: auth.authorization,
    };
    if (auth.did) headers.did = auth.did;
    if (auth.dt) headers.dt = auth.dt;
    const res = await gmRequest({
      method: 'POST',
      url,
      headers,
      data: JSON.stringify(body),
      timeout: 30000,
    });
    if (!(res.status >= 200 && res.status < 300)) {
      const snip = (res.responseText || '').slice(0, 200);
      throw new Error(`HTTP ${res.status}: ${snip}`);
    }
    const data = safeJsonParse(res.responseText);
    if (!data) throw new Error('响应不是合法 JSON');
    return data;
  }

  async function listFiles(parentId, page = 1, pageSize = LIST_PAGE_SIZE) {
    const body = { parentId: String(parentId), pageSize, orderBy: 0, sortType: 0 };
    if (page > 1) body.page = page;
    return gypPost(getListUrl(), body);
  }

  async function resolveDirectUrl(fileId) {
    const payload = await gypPost(getApiDownloadUrl(), { fileId: String(fileId) });
    const url = findFirstValueByKeys(payload, ['signedURL', 'signedUrl', 'downloadUrl', 'download_url', 'url']);
    if (!url) throw new Error('接口返回成功，但没拿到 signedURL');
    return String(url).trim();
  }

  // ===== 勾选检测 =====
  function normalizeName(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function collectCheckedItems() {
    const parentId = STATE.lastDirParentId;
    const dir = parentId ? STATE.dirCache[parentId] : null;
    if (!dir || !dir.items || !dir.items.length) {
      throw new Error('当前目录列表尚未拦截到。请先在页面进入并刷新一次目标目录');
    }

    const root = document.getElementById(ROOT_ID);
    const allCheckboxes = Array.from(document.querySelectorAll(
      'input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]'
    ));
    const checkboxes = allCheckboxes.filter((node) => !(root && root.contains(node)));
    if (!checkboxes.length) {
      throw new Error('没勾选任何文件夹/文件');
    }

    const picked = [];
    const missed = [];
    const seen = new Set();
    for (const box of checkboxes) {
      const row = box.closest('[role="row"], tr, li, [class*="row"], [class*="item"]');
      if (!row || (root && root.contains(row))) continue;
      const text = normalizeName(row.textContent || '');
      if (!text) continue;
      const hit = dir.items.find((it) => it.name && text.includes(normalizeName(it.name)));
      if (hit) {
        if (!seen.has(hit.fileId)) {
          seen.add(hit.fileId);
          picked.push(hit);
        }
      } else {
        // 截掉过长行文本，只取首 40 字方便排错
        missed.push(text.slice(0, 40));
      }
    }
    if (missed.length) {
      throw new Error(`有 ${missed.length} 行勾选未匹配上当前目录缓存：${missed.slice(0, 3).join('、')}。请刷新该目录后再试`);
    }
    return picked;
  }

  // ===== 递归展开 =====
  async function expandSelection(checked, onProgress) {
    const files = [];
    const queue = checked.map((it) => ({ item: it, relPath: it.name }));
    const visited = new Set();
    let dirsExpanded = 0;

    while (queue.length) {
      const { item, relPath } = queue.shift();
      if (!isDirectory(item)) {
        files.push({
          fileId: item.fileId,
          name: item.name,
          relPath,
          size: item.fileSize || 0,
        });
        if (files.length > MAX_FILES) {
          throw new Error(`文件过多（>${MAX_FILES}），请缩小勾选范围`);
        }
        if (onProgress) onProgress({ files: files.length, dirs: dirsExpanded, current: relPath });
        continue;
      }
      const key = item.fileId;
      if (!key || visited.has(key)) continue;
      visited.add(key);
      dirsExpanded += 1;
      if (dirsExpanded > MAX_DIRS) {
        throw new Error(`目录过多（>${MAX_DIRS}），请缩小勾选范围`);
      }
      if (onProgress) onProgress({ files: files.length, dirs: dirsExpanded, current: `${relPath}/` });

      for (let page = 1; page <= MAX_PAGES_PER_DIR; page++) {
        const payload = await listFiles(key, page);
        const items = extractItems(payload);
        for (const child of items) {
          queue.push({ item: child, relPath: `${relPath}/${child.name}` });
        }
        if (items.length < LIST_PAGE_SIZE) break;
      }
    }
    return files;
  }

  // ===== 并发限制器 =====
  async function pMap(items, worker, concurrency = 3) {
    const ret = new Array(items.length);
    let idx = 0;
    async function next() {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        ret[i] = await worker(items[i], i);
      }
    }
    const runners = [];
    for (let k = 0; k < Math.min(concurrency, items.length); k++) runners.push(next());
    await Promise.all(runners);
    return ret;
  }

  // ===== aria2 =====
  function aria2RpcRaw(method, params) {
    const cfg = STATE.config;
    const rpcUrl = String(cfg.rpcUrl || '').trim();
    if (!rpcUrl) return Promise.reject(new Error('未配置 aria2 RPC URL'));
    const body = {
      jsonrpc: '2.0',
      id: `gyp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      params,
    };
    return gmRequest({
      method: 'POST',
      url: rpcUrl,
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify(body),
      timeout: 20000,
    }).then((res) => {
      if (!(res.status >= 200 && res.status < 300)) {
        throw new Error(`aria2 HTTP ${res.status}: ${(res.responseText || '').slice(0, 200)}`);
      }
      const json = safeJsonParse(res.responseText);
      if (!json) throw new Error('aria2 响应不是合法 JSON');
      if (json.error) {
        throw new Error(`aria2 错误 ${json.error.code}: ${json.error.message}`);
      }
      return json.result;
    });
  }

  function aria2Rpc(method, params = []) {
    const secret = String(STATE.config.secret || '').trim();
    const finalParams = secret ? [`token:${secret}`, ...params] : params;
    return aria2RpcRaw(method, finalParams);
  }

  async function testAria2() {
    const version = await aria2Rpc('aria2.getVersion');
    return version;
  }

  function splitDirAndOut(downloadRoot, relPath) {
    const segs = String(relPath || '').split('/').map((s) => s.trim()).filter(Boolean);
    const filename = segs.pop() || '未命名';
    const root = String(downloadRoot || '').replace(/\/+$/, '');
    const dir = segs.length ? `${root}/${segs.join('/')}` : root;
    return { dir, out: filename };
  }

  async function pushBatch(entries) {
    const secret = String(STATE.config.secret || '').trim();
    const methods = entries.map((e) => ({
      methodName: 'aria2.addUri',
      params: [
        ...(secret ? [`token:${secret}`] : []),
        [e.url],
        {
          dir: e.dir,
          out: e.out,
          'user-agent': 'Mozilla/5.0',
          referer: 'https://guangyapan.com/',
        },
      ],
    }));
    // system.multicall 的 token 在 aria2 里实际是不需要外层 token 的——参数包内已有
    const result = await aria2RpcRaw('system.multicall', [methods]);
    return Array.isArray(result) ? result : [];
  }

  // ===== Pipeline =====
  async function pushSelectionToAria2(opts = {}) {
    if (STATE.busy) throw new Error('已有任务在跑，请稍后');
    STATE.busy = true;
    if (STATE.ui) STATE.ui.setBusy(true);
    try {
      const cfg = STATE.config;
      if (!String(cfg.rpcUrl || '').trim()) throw new Error('请先在「设置」里填 aria2 RPC URL');
      if (!String(cfg.downloadRoot || '').trim()) throw new Error('请先在「设置」里填下载根目录');

      const checked = collectCheckedItems();
      log(`勾选 ${checked.length} 项：${checked.map((it) => it.name).join('、')}`);

      const files = await expandSelection(checked, (p) => {
        if (STATE.ui) STATE.ui.setProgress(`展开中：${p.dirs} 目录 / ${p.files} 文件 — ${p.current}`);
      });
      if (!files.length) {
        log('展开后没有可下载的文件（勾选项可能都是空文件夹）');
        return { pushed: 0, failed: 0, files: 0 };
      }
      log(`展开完成，共 ${files.length} 个文件`);

      if (opts.previewOnly) {
        if (STATE.ui) STATE.ui.showPreview(files);
        return { pushed: 0, failed: 0, files: files.length, preview: true };
      }

      // 取直链
      let resolved = 0;
      const entries = [];
      const failures = [];
      await pMap(files, async (file) => {
        try {
          const url = await resolveDirectUrl(file.fileId);
          const { dir, out } = splitDirAndOut(cfg.downloadRoot, file.relPath);
          entries.push({ url, dir, out, name: file.name, relPath: file.relPath });
        } catch (e) {
          failures.push({ name: file.relPath, error: e.message || String(e) });
        } finally {
          resolved += 1;
          if (STATE.ui) STATE.ui.setProgress(`取直链 ${resolved}/${files.length}`);
        }
      }, cfg.resolveConcurrency);

      if (!entries.length) {
        const sample = failures.slice(0, 3).map((f) => `${f.name}: ${f.error}`).join('；');
        throw new Error(`全部 ${failures.length} 个直链获取失败。示例：${sample}`);
      }
      log(`直链就绪 ${entries.length}/${files.length}${failures.length ? `（失败 ${failures.length}）` : ''}`);

      // 批量推送
      const BATCH = cfg.multicallBatch;
      let pushed = 0;
      const pushFailures = [];
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        if (STATE.ui) STATE.ui.setProgress(`推送 aria2 ${i}/${entries.length}`);
        const result = await pushBatch(batch);
        for (let j = 0; j < result.length; j++) {
          const r = result[j];
          if (Array.isArray(r)) {
            pushed += 1;
          } else if (r && typeof r === 'object' && r.faultCode != null) {
            pushFailures.push({ name: batch[j].relPath, error: `${r.faultCode}: ${r.faultString}` });
          } else {
            pushFailures.push({ name: batch[j].relPath, error: '未知响应格式' });
          }
        }
      }
      log(`推送完成：成功 ${pushed}/${entries.length}，aria2 失败 ${pushFailures.length}，取直链失败 ${failures.length}`);
      for (const f of pushFailures.slice(0, 5)) errorLog(`aria2 拒绝：${f.name} — ${f.error}`);
      for (const f of failures.slice(0, 5)) errorLog(`取直链失败：${f.name} — ${f.error}`);

      return {
        pushed,
        failed: pushFailures.length + failures.length,
        files: files.length,
      };
    } finally {
      STATE.busy = false;
      if (STATE.ui) STATE.ui.setBusy(false);
      if (STATE.ui) STATE.ui.setProgress('');
    }
  }

  // ===== UI（v0.3 工具条改版） =====
  const ICONS = {
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    chevronRight: '<polyline points="9 18 15 12 9 6"/>',
    chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  };

  function svg(name, size = 18) {
    const path = ICONS[name] || '';
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  function injectStyles() {
    if (document.getElementById(ROOT_ID + '-style')) return;
    const style = document.createElement('style');
    style.id = ROOT_ID + '-style';
    style.textContent = `
#${ROOT_ID} { all: initial; }
#${ROOT_ID} *, #${ROOT_ID} *::before, #${ROOT_ID} *::after { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }

#${ROOT_ID} .gyp-toolbar {
  position: fixed; right: 0; top: 50%; transform: translateY(-50%);
  z-index: 2147483647;
  width: 44px; padding: 6px 0;
  background: #1f2937; color: #e5e7eb;
  border-radius: 8px 0 0 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  user-select: none;
  transition: width .15s ease;
}
#${ROOT_ID} .gyp-toolbar.collapsed {
  width: 10px; padding: 0;
}
#${ROOT_ID} .gyp-toolbar.collapsed > *:not([data-act="collapse"]) {
  display: none;
}
#${ROOT_ID} .gyp-toolbar.collapsed [data-act="collapse"] {
  width: 100%; height: 100%; min-height: 80px;
}

#${ROOT_ID} .gyp-grip {
  width: 28px; height: 4px; border-radius: 2px;
  background: #4b5563; cursor: ns-resize; margin: 2px 0 4px;
}
#${ROOT_ID} .gyp-grip:hover { background: #6b7280; }

#${ROOT_ID} .gyp-dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: #6b7280; cursor: help;
  transition: background .15s;
}
#${ROOT_ID} .gyp-dot.ok { background: #34d399; }
#${ROOT_ID} .gyp-dot.bad { background: #f87171; }

#${ROOT_ID} .gyp-sep {
  width: 24px; height: 1px; background: #374151; margin: 2px 0;
}

#${ROOT_ID} .gyp-btn {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: #e5e7eb;
  border: 0; border-radius: 6px;
  cursor: pointer; padding: 0;
  position: relative;
  transition: background .15s, color .15s;
}
#${ROOT_ID} .gyp-btn:hover { background: #374151; }
#${ROOT_ID} .gyp-btn.active { background: #2563eb; color: #fff; }
#${ROOT_ID} .gyp-btn.primary { background: #2563eb; color: #fff; }
#${ROOT_ID} .gyp-btn.primary:hover { background: #1d4ed8; }
#${ROOT_ID} .gyp-btn:disabled { color: #4b5563; cursor: not-allowed; background: transparent; }
#${ROOT_ID} .gyp-btn.spin svg { animation: gyp-spin .9s linear infinite; }
@keyframes gyp-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
#${ROOT_ID} .gyp-btn.busy { background: rgba(37, 99, 235, .25); animation: gyp-pulse 1.2s ease-in-out infinite; }
@keyframes gyp-pulse { 0%,100% { background: rgba(37, 99, 235, .15); } 50% { background: rgba(37, 99, 235, .5); } }

#${ROOT_ID} .gyp-popover {
  position: fixed; right: 52px; z-index: 2147483646;
  width: 380px; max-height: 70vh;
  background: #1f2937; color: #e5e7eb;
  border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.4);
  display: flex; flex-direction: column;
  font-size: 13px; line-height: 1.45;
}
/* class 选择器优先级压过 user-agent 的 [hidden]{display:none}，必须显式覆盖 */
#${ROOT_ID} .gyp-popover[hidden] { display: none !important; }
#${ROOT_ID} .gyp-pop-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; background: #111827; border-radius: 8px 8px 0 0;
  font-weight: 600; color: #fbbf24;
}
#${ROOT_ID} .gyp-pop-close {
  background: transparent; border: 0; color: #9ca3af; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 4px; padding: 0;
}
#${ROOT_ID} .gyp-pop-close:hover { background: #374151; color: #e5e7eb; }
#${ROOT_ID} .gyp-pop-body { padding: 10px 12px; overflow-y: auto; flex: 1; }

#${ROOT_ID} label.gyp-field { display: block; margin: 6px 0 2px; color: #9ca3af; font-size: 12px; }
#${ROOT_ID} input.gyp-input, #${ROOT_ID} textarea.gyp-input {
  width: 100%; padding: 5px 6px; background: #111827; color: #e5e7eb;
  border: 1px solid #374151; border-radius: 4px; font-size: 12px;
}
#${ROOT_ID} textarea.gyp-input { resize: vertical; min-height: 28px; }
#${ROOT_ID} details { margin-top: 8px; border-top: 1px solid #374151; padding-top: 8px; }
#${ROOT_ID} details > summary { cursor: pointer; color: #9ca3af; }

#${ROOT_ID} .gyp-log {
  background: #111827; border-radius: 4px; padding: 6px;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.4;
  max-height: calc(70vh - 60px); overflow-y: auto;
  white-space: pre-wrap; word-break: break-all;
}
#${ROOT_ID} .gyp-log .err { color: #f87171; }
#${ROOT_ID} .gyp-log .warn { color: #fbbf24; }

#${ROOT_ID} .gyp-preview {
  background: #111827; padding: 6px; border-radius: 4px;
  max-height: calc(70vh - 60px); overflow-y: auto;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px;
}
#${ROOT_ID} .gyp-preview-empty { color: #6b7280; padding: 12px; text-align: center; }
`;
    document.head.appendChild(style);
  }

  function mountPanel() {
    if (document.getElementById(ROOT_ID)) return;
    injectStyles();
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
<div class="gyp-toolbar" data-state="open">
  <div class="gyp-grip" data-grip="1" title="按住可上下拖动"></div>
  <div class="gyp-dot" data-status="auth" title="认证：识别中"></div>
  <div class="gyp-dot" data-status="dir" title="当前目录：未拦截"></div>
  <div class="gyp-sep"></div>
  <button class="gyp-btn primary" data-act="push" title="推送选中到 aria2">${svg('download')}</button>
  <button class="gyp-btn" data-act="preview" title="展开预览（不推送）">${svg('eye')}</button>
  <button class="gyp-btn" data-act="test" title="测试 aria2 连通">${svg('bolt')}</button>
  <div class="gyp-sep"></div>
  <button class="gyp-btn" data-act="toggle-settings" title="设置">${svg('gear')}</button>
  <button class="gyp-btn" data-act="toggle-log" title="日志">${svg('list')}</button>
  <div class="gyp-sep"></div>
  <button class="gyp-btn" data-act="collapse" title="收起工具条">${svg('chevronRight')}</button>
</div>

<div class="gyp-popover" data-pop="settings" hidden>
  <div class="gyp-pop-head"><span>设置</span><button class="gyp-pop-close" data-act="close-pop" title="关闭">${svg('x', 16)}</button></div>
  <div class="gyp-pop-body">
    <label class="gyp-field">aria2 RPC URL</label>
    <input class="gyp-input" data-cfg="rpcUrl" placeholder="http://127.0.0.1:6800/jsonrpc"/>
    <label class="gyp-field">aria2 Secret（无可留空）</label>
    <input class="gyp-input" data-cfg="secret" type="text" placeholder=""/>
    <label class="gyp-field">下载根目录（aria2 守护进程可写路径）</label>
    <input class="gyp-input" data-cfg="downloadRoot" placeholder="/downloads/guangyapan"/>
    <label class="gyp-field">取直链并发（1-8）</label>
    <input class="gyp-input" data-cfg="resolveConcurrency" type="number" min="1" max="8"/>
    <label class="gyp-field">每批 multicall 条数（1-200）</label>
    <input class="gyp-input" data-cfg="multicallBatch" type="number" min="1" max="200"/>
    <label class="gyp-field" style="margin-top:8px;">
      <input type="checkbox" data-act="debug" style="vertical-align:middle;"/>
      <span style="vertical-align:middle;">调试日志：把每次拦到的 guangyapan 请求 URL 打到日志</span>
    </label>
    <details data-section="auth">
      <summary style="margin-top:6px;">手填光鸭认证（自动捕获失败时用）</summary>
      <label class="gyp-field">Authorization（Bearer ...）</label>
      <textarea class="gyp-input" data-auth="authorization" rows="2" placeholder="留空 → 用自动捕获"></textarea>
      <label class="gyp-field">did</label>
      <input class="gyp-input" data-auth="did" placeholder="留空 → 用自动捕获"/>
      <label class="gyp-field">dt</label>
      <input class="gyp-input" data-auth="dt" placeholder="留空 → 用自动捕获"/>
    </details>
  </div>
</div>

<div class="gyp-popover" data-pop="log" hidden>
  <div class="gyp-pop-head"><span>日志</span><span style="display:flex;gap:4px;"><button class="gyp-pop-close" data-act="clear-log" title="清空日志">${svg('trash', 16)}</button><button class="gyp-pop-close" data-act="close-pop" title="关闭">${svg('x', 16)}</button></span></div>
  <div class="gyp-pop-body"><div class="gyp-log" data-field="log"></div></div>
</div>

<div class="gyp-popover" data-pop="preview" hidden>
  <div class="gyp-pop-head"><span>展开预览</span><button class="gyp-pop-close" data-act="close-pop" title="关闭">${svg('x', 16)}</button></div>
  <div class="gyp-pop-body"><div class="gyp-preview" data-field="preview"><div class="gyp-preview-empty">点工具条上的「眼睛」生成预览</div></div></div>
</div>
`;
    document.body.appendChild(root);

    // 引用
    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => Array.from(root.querySelectorAll(sel));
    const elToolbar = $('.gyp-toolbar');
    const elPush = $('button[data-act="push"]');
    const elPreview = $('button[data-act="preview"]');
    const elTest = $('button[data-act="test"]');
    const elSettingsBtn = $('button[data-act="toggle-settings"]');
    const elLogBtn = $('button[data-act="toggle-log"]');
    const elCollapseBtn = $('button[data-act="collapse"]');
    const elDotAuth = $('.gyp-dot[data-status="auth"]');
    const elDotDir = $('.gyp-dot[data-status="dir"]');
    const elLog = $('[data-field="log"]');
    const elPreviewBox = $('[data-field="preview"]');

    let activePopover = null;   // 'settings' | 'log' | 'preview' | null

    // 同步配置到输入框
    function syncInputsFromState() {
      for (const key of Object.keys(STATE.config)) {
        if (key === 'manualAuth') continue;
        const input = root.querySelector(`[data-cfg="${key}"]`);
        if (input) input.value = STATE.config[key];
      }
      for (const key of ['authorization', 'did', 'dt']) {
        const input = root.querySelector(`[data-auth="${key}"]`);
        if (input) input.value = (STATE.config.manualAuth && STATE.config.manualAuth[key]) || '';
      }
      const debugCb = root.querySelector('input[data-act="debug"]');
      if (debugCb) debugCb.checked = !!STATE.debug;
    }
    syncInputsFromState();

    // 失焦/勾选自动保存
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches('[data-cfg]')) {
        const key = t.getAttribute('data-cfg');
        if (key === 'resolveConcurrency' || key === 'multicallBatch') {
          STATE.config[key] = Math.max(1, Number(t.value) || (key === 'resolveConcurrency' ? 3 : 50));
        } else {
          STATE.config[key] = String(t.value).trim();
        }
        saveConfig();
      }
      if (t.matches('[data-auth]')) {
        const key = t.getAttribute('data-auth');
        if (!STATE.config.manualAuth) STATE.config.manualAuth = { authorization: '', did: '', dt: '' };
        STATE.config.manualAuth[key] = String(t.value).trim();
        saveConfig();
        renderAuthStatus();
      }
      if (t.matches('input[data-act="debug"]')) {
        STATE.debug = !!t.checked;
        log(STATE.debug ? '调试日志已开启' : '调试日志已关闭');
      }
    });

    // popover 开关
    function openPopover(name) {
      if (activePopover === name) return;
      closePopover();
      const pop = root.querySelector(`.gyp-popover[data-pop="${name}"]`);
      if (!pop) return;
      pop.hidden = false;
      // 垂直对齐到工具条按钮的大致位置
      const tbRect = elToolbar.getBoundingClientRect();
      const popHeight = Math.min(window.innerHeight * 0.7, pop.scrollHeight + 60);
      let top = tbRect.top + tbRect.height / 2 - popHeight / 2;
      top = Math.max(8, Math.min(window.innerHeight - popHeight - 8, top));
      pop.style.top = top + 'px';
      activePopover = name;
      // 高亮对应按钮
      const btn = root.querySelector(`button[data-act="toggle-${name}"]`);
      if (btn) btn.classList.add('active');
    }
    function closePopover() {
      $$('.gyp-popover').forEach((p) => { p.hidden = true; });
      $$('button[data-act^="toggle-"]').forEach((b) => b.classList.remove('active'));
      activePopover = null;
    }
    function togglePopover(name) {
      if (activePopover === name) closePopover();
      else openPopover(name);
    }

    elSettingsBtn.addEventListener('click', () => togglePopover('settings'));
    elLogBtn.addEventListener('click', () => togglePopover('log'));
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="close-pop"]')) closePopover();
      if (e.target.closest('[data-act="clear-log"]')) {
        STATE.logs.length = 0;
        pushLog('日志已清空', 'info');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && activePopover) closePopover();
    });

    // 折叠
    elCollapseBtn.addEventListener('click', () => {
      const collapsed = elToolbar.classList.toggle('collapsed');
      elCollapseBtn.innerHTML = collapsed ? svg('chevronLeft') : svg('chevronRight');
      elCollapseBtn.title = collapsed ? '展开工具条' : '收起工具条';
      if (collapsed) closePopover();
    });

    // 拖拽（仅纵向）
    enableVerticalDrag(elToolbar, $('.gyp-grip'));

    // 主操作按钮
    elPush.addEventListener('click', async () => {
      try { await pushSelectionToAria2(); }
      catch (e) { errorLog(e.message || String(e)); openPopover('log'); }
    });
    elPreview.addEventListener('click', async () => {
      try { await pushSelectionToAria2({ previewOnly: true }); }
      catch (e) { errorLog(e.message || String(e)); openPopover('log'); }
    });
    elTest.addEventListener('click', async () => {
      elTest.classList.add('spin');
      try {
        const v = await testAria2();
        log(`aria2 测试通过：v${v && v.version} | 启用功能 ${(v && v.enabledFeatures || []).join(',')}`);
        openPopover('log');
      } catch (e) {
        errorLog(`aria2 测试失败：${e.message || e}`);
        openPopover('log');
      } finally {
        elTest.classList.remove('spin');
      }
    });

    // 渲染函数（保持原 STATE.ui 接口）
    function renderAuthStatus() {
      const s = authStatusSummary();
      elDotAuth.classList.toggle('ok', s.ok);
      elDotAuth.classList.toggle('bad', !s.ok);
      elDotAuth.title = `认证：${s.text}`;
    }
    function renderDirStatus() {
      const pid = STATE.lastDirParentId;
      const hook = STATE.hookInstalled ? '✓拦截器已装' : '⚠拦截器未确认';
      if (!pid) {
        elDotDir.classList.remove('ok'); elDotDir.classList.add('bad');
        elDotDir.title = `${hook} | 当前目录：未拦截（请在云盘里浏览一次目标目录）`;
      } else {
        const c = (STATE.dirCache[pid] && STATE.dirCache[pid].items.length) || 0;
        elDotDir.classList.add('ok'); elDotDir.classList.remove('bad');
        elDotDir.title = `${hook} | parentId=${pid.slice(0, 16)}… 已缓存 ${c} 项`;
      }
    }
    function renderLog() {
      elLog.innerHTML = STATE.logs.map((l) => {
        const cls = l.level === 'error' ? 'err' : (l.level === 'warn' ? 'warn' : '');
        return `<div class="${cls}">[${l.ts}] ${escapeHtml(l.msg)}</div>`;
      }).join('');
      elLog.scrollTop = elLog.scrollHeight;
    }
    function setProgress(text) {
      // 工具条版本：进度文本走 log；不在 UI 上显示长字符串
      if (text) log(text);
    }
    function setBusy(busy) {
      elPush.disabled = !!busy;
      elPreview.disabled = !!busy;
      elPush.classList.toggle('busy', !!busy);
    }
    function showPreview(files) {
      const cfg = STATE.config;
      if (!files || !files.length) {
        elPreviewBox.innerHTML = `<div class="gyp-preview-empty">无可下载文件</div>`;
      } else {
        const lines = files.map((f) => {
          const { dir, out } = splitDirAndOut(cfg.downloadRoot, f.relPath);
          return escapeHtml(`${dir}/${out}`);
        });
        elPreviewBox.innerHTML = lines.join('<br>');
      }
      openPopover('preview');
    }

    STATE.ui = {
      renderAuthStatus, renderDirStatus, renderLog,
      setProgress, setBusy, showPreview,
      openPopover, closePopover,
    };
    renderAuthStatus();
    renderDirStatus();
    renderLog();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function enableVerticalDrag(toolbar, handle) {
    if (!handle) return;
    let dragging = false;
    let startY = 0;
    let startTop = 0;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      const r = toolbar.getBoundingClientRect();
      startTop = r.top;
      // 切换为绝对定位（top 而非 translateY 居中）以便自由滑动
      toolbar.style.top = startTop + 'px';
      toolbar.style.transform = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      const next = Math.max(0, Math.min(window.innerHeight - toolbar.offsetHeight, startTop + dy));
      toolbar.style.top = next + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ===== 启动 =====
  function bootstrap() {
    loadConfig();
    loadCapturedAuth();
    installInterceptors();

    const start = () => {
      if (!document.body) {
        setTimeout(start, 50);
        return;
      }
      mountPanel();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('显示/隐藏 光鸭→aria2 工具条', () => {
          const toolbar = document.querySelector(`#${ROOT_ID} .gyp-toolbar`);
          if (toolbar) {
            const btn = toolbar.querySelector('button[data-act="collapse"]');
            if (btn) btn.click();
            else toolbar.classList.toggle('collapsed');
          } else {
            mountPanel();
          }
        });
      }
    } catch (_) { /* ignore */ }
  }

  bootstrap();
})();
