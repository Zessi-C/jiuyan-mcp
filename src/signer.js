// signer.js — 韭研公社 web API 签名器。
//
// 原理：web 端每个请求需带 `token` + `timestamp` 头。签名原料由 SSR 页面内嵌
// （window.__NUXT__ 中的 `<key>:{digest:"<hex>",project:"jiuyangongshe",serverTime:<秒>}`），
// 推导算法位于 Nuxt 打包的混淆模块中（webpack 模块 id 144，执行时把签名函数
// 挂到 globalThis 的一个混淆名上）。本模块在 node:vm 沙箱里收割模块表、初始化
// 该模块，然后直接调用签名函数：sign(state, nowMs) -> {timestamp:"ISO-UTC", token:32位hex}。
//
// 兼容性策略：digest 键名 / 全局函数名均为混淆产物，可能随站点发版轮换——
// 因此键名用宽松正则匹配，签名全局名先试已知值再按"新增函数+输出形状"自动发现。

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
  const w = {};
  w.window = w;
  w.self = w;
  w.globalThis = w;
  // 拦截 webpackJsonp.push：只收割 [chunkIds, modules, entries] 里的 modules，
  // 不执行任何 entry —— 避免触发整个前端应用。
  w.webpackJsonp = [];
  w.webpackJsonp.push = (...args) => {
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
  const noop = () => {};
  const ctx = {
    window: w,
    document: {
      createElement: () => ({ style: {}, setAttribute: noop, getElementsByTagName: () => [] }),
      getElementsByTagName: () => [],
      head: { appendChild: noop },
      body: { appendChild: noop },
      documentElement: { style: {} },
      cookie: '',
    },
    navigator: { userAgent: UA },
    location: {
      protocol: 'https:',
      host: 'www.jiuyangongshe.com',
      hostname: 'www.jiuyangongshe.com',
      origin: 'https://www.jiuyangongshe.com',
      href: PAGE_URL,
      pathname: '/action',
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
    history: { pushState: noop, replaceState: noop },
    addEventListener: noop,
    removeEventListener: noop,
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return { ctx, registry };
}

// 收割所有 chunk 后 require(144) 初始化签名模块；返回 globalThis 上新出现的
// 且调用后产出合法签名的函数名（自动发现，防混淆名轮换）。
function initSignModule(ctx, registry, stateArg) {
  const before = new Set(Object.keys(ctx));
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

  const KNOWN_MODULE_IDS = [144];
  const KNOWN_GLOBAL_NAMES = ['nR4xKp7mQa'];

  let lastErr = null;
  for (const id of KNOWN_MODULE_IDS) {
    try {
      req(id);
    } catch (e) {
      lastErr = e; // 初始化抛错也继续：全局导出常在崩溃前已完成
    }
  }

  const candidates = Object.keys(ctx).filter(
    (k) => !before.has(k) && typeof ctx[k] === 'function'
  );
  const ordered = [
    ...KNOWN_GLOBAL_NAMES.filter((n) => candidates.includes(n)),
    ...candidates.filter((n) => !KNOWN_GLOBAL_NAMES.includes(n)),
  ];

  const probeState = { ...stateArg };
  for (const name of ordered) {
    try {
      const out = ctx[name](probeState, Date.now());
      if (
        out &&
        typeof out.token === 'string' &&
        /^[0-9a-f]{32}$/.test(out.token) &&
        typeof out.timestamp === 'string'
      ) {
        return name;
      }
    } catch {
      /* 不是签名函数 */
    }
  }
  throw new Error(
    `未能定位签名函数${lastErr ? `（模块初始化错误: ${lastErr.message}）` : ''}，站点可能已升级`
  );
}

export class Signer {
  #ctx = null;
  #stateArg = null;
  #signGlobalName = null;

  /** 返回当前请求的鉴权头；必要时惰性初始化签名上下文。 */
  async headers(nowMs = Date.now()) {
    if (!this.#ctx) await this.refresh();
    const sign = this.#callSign(nowMs);
    return { platform: '3', timestamp: sign.timestamp, token: sign.token };
  }

  /** 强制重建签名上下文（抓页取新 digest + 重载沙箱）。 */
  async refresh() {
    const html = await fetchText(PAGE_URL);
    const state = extractSignState(html);
    const chunkNames = extractChunkPaths(html);

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
    this.#signGlobalName = initSignModule(ctx, registry, this.#stateArg);
    this.#ctx = ctx;
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
    const fn = this.#ctx[this.#signGlobalName];
    const out = fn(this.#stateArg, nowMs);
    if (!out || typeof out.token !== 'string') throw new Error('签名函数输出异常');
    return out;
  }
}
