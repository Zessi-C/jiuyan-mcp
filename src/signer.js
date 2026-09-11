// signer.js — 韭研公社 web API 签名器。
//
// 原理：web 端每个请求需带 `token` + `timestamp` 头。签名原料由 SSR 页面内嵌
// （window.__NUXT__ 中的 `<混淆键>:{digest:"<hex>",project:"jiuyangongshe",serverTime:<秒>}`，
// 键名与 digest 长度随站点发版变化）。推导算法位于 Nuxt 打包的混淆模块里
// （当前构建：webpack 模块 144，导出若干混淆名函数并挂到 globalThis）。
// 本模块在 node:vm 沙箱里收割模块表、require 该模块，然后在它的导出/全局里
// 按「调用形状」找出签名函数并调用：sign(state, nowMs) -> {timestamp:"ISO-UTC", token:hex}。
//
// 兼容性策略：digest 键名、模块 id、函数名均为混淆产物，会随站点发版轮换——
// 因此键名用宽松正则匹配、token 只校验“hex 且够长”，模块按已知 id → 特征扫描兜底，
// 函数按输出形状自动发现。站点校验 timestamp 的时间窗（实测偏移 1 小时即 errCode=110），
// 故用页面 serverTime 校正本机时钟偏移。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const PAGE_URL = 'https://www.jiuyangongshe.com/action';
const RES_BASE = 'https://res.jiuyangongshe.com/';

const UA = process.env.JIYAN_UA ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DIGEST_RE = /(\w+):\{digest:"([0-9a-f]{64,})",project:"([^"]+)",serverTime:(\d+)\}/;
const CHUNK_RE = /\/_nuxt\/([0-9a-f]+)\.js/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEBUG = !!process.env.JIYAN_DEBUG;
const dbg = (...a) => {
  if (DEBUG) console.error('[jiuyan-signer]', ...a);
};

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

function extractSignState(html) {
  const m = html.match(DIGEST_RE);
  if (!m) throw new Error('页面未内嵌签名原料(digest)，站点结构可能已变化');
  return { key: m[1], digest: m[2], project: m[3], serverTime: Number(m[4]) };
}

function extractChunkPaths(html) {
  const names = new Set();
  for (const m of html.matchAll(CHUNK_RE)) names.add(m[1]);
  if (names.size === 0) throw new Error('页面未引用任何 Nuxt chunk');
  return [...names];
}

function buildSandbox() {
  const registry = new Map(); // webpack 模块表
  const noop = () => {};
  const el = () => ({
    style: {},
    setAttribute: noop,
    getAttribute: () => null,
    getElementsByTagName: () => [],
    addEventListener: noop,
    attachEvent: noop,
    appendChild: noop,
    insertBefore: noop,
  });
  // 站点前沿代码（jQuery 插件等）会读写 window.navigator / document，
  // 因此沙箱与 window 必须是同一个对象。
  const sandbox = {
    document: {
      createElement: el,
      createElementNS: el,
      createTextNode: () => ({}),
      getElementsByTagName: () => [],
      getElementsByClassName: () => [],
      querySelector: () => null,
      querySelectorAll: () => [],
      head: el(),
      body: el(),
      documentElement: el(),
      cookie: '',
      addEventListener: noop,
      removeEventListener: noop,
      readyState: 'complete',
    },
    navigator: {
      userAgent: UA,
      platform: 'Linux x86_64',
      appVersion: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      vendor: 'Google Inc.',
      language: 'zh-CN',
      languages: ['zh-CN', 'en'],
      cookieEnabled: true,
      hardwareConcurrency: 8,
      maxTouchPoints: 0,
    },
    location: {
      protocol: 'https:',
      host: 'www.jiuyangongshe.com',
      hostname: 'www.jiuyangongshe.com',
      origin: 'https://www.jiuyangongshe.com',
      href: PAGE_URL,
      pathname: '/action',
      search: '',
      hash: '',
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 },
    history: { pushState: noop, replaceState: noop },
    addEventListener: noop,
    removeEventListener: noop,
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  // 拦截 webpackJsonp.push：只收割 [chunkIds, modules, entries] 里的 modules，
  // 不执行任何 entry —— 避免触发整个前端应用。
  sandbox.webpackJsonp = [];
  sandbox.webpackJsonp.push = (...args) => {
    for (const data of args) {
      const modules = data?.[1];
      if (modules && typeof modules === 'object') {
        for (const [id, fn] of Object.entries(modules)) {
          if (typeof fn === 'function') registry.set(Number(id), fn);
        }
      }
      return data.length;
    }
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return { ctx: sandbox, registry };
}

// 收割所有 chunk 后初始化混淆签名模块；返回可直接调用的签名函数
// （签名函数名与模块 id 均为混淆产物，随构建轮换——按“调用形状”自动发现）。
const KNOWN_MODULE_IDS = [144]; // 站点当前构建的签名模块 id
const KNOWN_GLOBAL_NAMES = ['nR4xKp7mQa'];
const SIGNER_MODULE_RE = /globalThis\.[A-Za-z0-9_$]{4,}\s*=/; // 签名模块把导出挂到 globalThis*

const isSignature = (out) =>
  !!out &&
  typeof out.token === 'string' &&
  /^[0-9a-f]{32,}$/.test(out.token) &&
  typeof out.timestamp === 'string';

function initSignModule(ctx, registry, stateArg) {
  const cache = new Map();
  const req = (id) => {
    if (cache.has(id)) return cache.get(id);
    const fn = registry.get(id);
    if (!fn) throw new Error(`webpack 模块 ${id} 不存在`);
    const mod = { exports: {} };
    cache.set(id, mod.exports);
    const out = fn.call(mod.exports, mod, mod.exports, req);
    const value = out === undefined || out === null ? mod.exports : out;
    cache.set(id, value);
    return value;
  };

  let lastErr = null;
  const tried = new Set();

  // require 一个模块，然后在“它新挂到 globalThis 的函数”与“它导出对象上的函数”里
  // 找签名函数。注意：站点当前构建的混淆模块只导出函数、不再挂 globalThis，
  // 所以两条路都要试。
  const tryModule = (id) => {
    if (tried.has(id)) return null;
    tried.add(id);
    const before = new Set(Object.keys(ctx));
    let exports_ = null;
    try {
      exports_ = req(id);
    } catch (e) {
      lastErr = e; // 初始化抛错也继续：导出常已完成
    }
    const added = Object.keys(ctx).filter((k) => !before.has(k) && typeof ctx[k] === 'function');
    const cands = [
      ...added.map((n) => ({ label: `globalThis.${n}`, known: KNOWN_GLOBAL_NAMES.includes(n), fn: ctx[n] })),
      ...(exports_ && typeof exports_ === 'object'
        ? Object.entries(exports_).filter(([, v]) => typeof v === 'function')
            .map(([n, v]) => ({ label: `module${id}.${n}`, known: KNOWN_GLOBAL_NAMES.includes(n), fn: v }))
        : []),
    ];
    cands.sort((a, b) => Number(b.known) - Number(a.known));
    dbg('module', id, '-> candidates:', cands.map((c) => c.label).join(', ') || '(none)', lastErr ? `lastErr=${lastErr.message}` : '');
    for (const c of cands) {
      try {
        const out = c.fn({ ...stateArg }, Date.now());
        if (isSignature(out)) return c.fn;
      } catch {
        /* 不是签名函数 */
      }
    }
    return null;
  };

  for (const id of KNOWN_MODULE_IDS) {
    const fn = tryModule(id);
    if (fn) return fn;
  }

  // 兜底：模块 id 随构建轮换时，按“向 globalThis 批量挂导出”这一特征重新定位。
  for (const [id, fn] of registry) {
    if (tried.has(id) || !SIGNER_MODULE_RE.test(String(fn))) continue;
    const sign = tryModule(id);
    if (sign) return sign;
  }

  throw new Error(
    `未能定位签名函数${lastErr ? `（模块初始化错误: ${lastErr.message}）` : ''}，站点可能已升级`
  );
}

export class Signer {
  #signFn = null;
  #stateArg = null;
  #offsetMs = 0;

  /** 返回当前请求的鉴权头；必要时惰性初始化签名上下文。 */
  async headers(nowMs = Date.now()) {
    if (!this.#signFn) await this.refresh();
    const sign = this.#callSign(nowMs + this.#offsetMs);
    return { platform: '3', timestamp: sign.timestamp, token: sign.token };
  }

  /** 服务端时间与本机时间的差（毫秒）；token 的时间窗按服务端时间校验。 */
  get clockOffsetMs() {
    return this.#offsetMs;
  }

  /** 强制重建签名上下文（抓页取新 digest + 重载沙箱）。 */
  async refresh() {
    const html = await fetchText(PAGE_URL);
    const fetchedAt = Date.now();
    const state = extractSignState(html);
    const chunkNames = extractChunkPaths(html);
    this.#offsetMs = state.serverTime * 1000 - fetchedAt;

    const cacheDir = path.join(os.tmpdir(), 'jiuyan-mcp-chunks');
    fs.mkdirSync(cacheDir, { recursive: true });

    const { ctx, registry } = buildSandbox();
    // 与实测一致的顺序：按页面 <script src> 出现顺序载入
    for (const name of chunkNames) {
      const code = await this.#loadChunk(cacheDir, name);
      try {
        vm.runInContext(code, ctx, { filename: `${name}.js` });
      } catch {
        /* 入口 chunk 触碰缺失 DOM 属预期噪音；模块已收割 */
      }
      await sleep(150); // 对静态资源保持礼貌
    }

    this.#stateArg = { digest: state.digest, project: state.project, serverTime: state.serverTime };
    dbg(
      'state key', state.key, 'digest len', state.digest.length, 'serverTime', state.serverTime,
      'chunks', chunkNames.join(','), 'modules', registry.size
    );
    this.#signFn = initSignModule(ctx, registry, this.#stateArg);
    dbg('signer located');
  }

  async #loadChunk(cacheDir, name) {
    const file = path.join(cacheDir, `${name}.js`);
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      if (stat.size > 1000 && Date.now() - stat.mtimeMs < 7 * 24 * 3600 * 1000) {
        return fs.readFileSync(file, 'utf8');
      }
    }
    const code = await fetchText(`${RES_BASE}_nuxt/${name}.js`);
    fs.writeFileSync(file, code);
    return code;
  }

  #callSign(nowMs) {
    const out = this.#signFn({ ...this.#stateArg }, nowMs);
    if (!out || typeof out.token !== 'string') throw new Error('签名函数输出异常');
    return out;
  }
}
