// api.js — 韭研公社 web API 客户端：统一鉴权头、限速、errCode 语义映射与签名重试。

import { Signer } from './signer.js';

export const BASE = 'https://web-api.jiuyangongshe.com/jystock-app';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class JiuyanError extends Error {
  constructor(errCode, msg) {
    super(msg);
    this.name = 'JiuyanError';
    this.errCode = errCode;
  }
}

function friendly(errCode, msg) {
  switch (String(errCode)) {
    case '1':
      return `该数据需要登录（服务器返回: ${msg || '登录失效'}）。请设置环境变量 JIYAN_SESSION 为网页登录后的 SESSION cookie 值后重启服务。`;
    case '9':
      return '此端点为旧版 APP API 且被版本门禁拦截（errCode 9），web API 不应出现此错误，请报告 issue。';
    case '110':
      return '签名校验失败（已尝试自动刷新仍被拒），站点签名机制可能升级。';
    default:
      return msg ? `${msg} (errCode=${errCode})` : `业务错误 errCode=${errCode}`;
  }
}

export class JiuyanClient {
  #signer;
  #session;
  #lastCallAt = 0;
  #minIntervalMs;

  /**
   * @param {object} opts
   * @param {Signer} [opts.signer]
   * @param {string} [opts.session] 网页登录 cookie 的 SESSION 值；空则匿名访问
   * @param {number} [opts.minIntervalMs] 相邻上游请求最小间隔（礼貌限速）
   */
  constructor({ signer = new Signer(), session = process.env.JIYAN_SESSION?.trim() || '', minIntervalMs = 1000 } = {}) {
    this.#signer = signer;
    this.#session = session;
    this.#minIntervalMs = minIntervalMs;
  }

  get authenticated() {
    return this.#session.length > 0;
  }

  async #throttle() {
    const wait = this.#lastCallAt + this.#minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.#lastCallAt = Date.now();
  }

  /**
   * POST 一个 jystock-app 接口，返回完整响应信封。
   * errCode=110 时自动重建签名并重试一次；其余非 0 errCode 抛 JiuyanError。
   * @param {string} path 如 '/api/v1/timeline/list'
   * @param {object} body JSON 请求体
   */
  async post(path, body) {
    for (let attempt = 0; ; attempt++) {
      await this.#throttle();
      const headers = {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': process.env.JIYAN_UA ||
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Referer: 'https://www.jiuyangongshe.com/',
        Origin: 'https://www.jiuyangongshe.com',
        ...(await this.#signer.headers(Date.now())),
      };
      if (this.#session) headers.Cookie = `SESSION=${this.#session}`;

      let json;
      try {
        const res = await fetch(BASE + path, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
      } catch (e) {
        throw new JiuyanError('network', `请求 ${path} 失败: ${e.message}`);
      }

      const code = String(json.errCode ?? '-1');
      if (code === '0') return json;
      if (code === '110' && attempt === 0) {
        try {
          await this.#signer.refresh();
          continue; // 换新签名重试一次
        } catch {
          /* 刷新失败 → 走友好报错 */
        }
      }
      throw new JiuyanError(code, friendly(code, json.msg || json.errMsg));
    }
  }
}
