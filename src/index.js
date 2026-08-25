#!/usr/bin/env node
// index.js — jiuyan-mcp 入口：stdio MCP 服务器，暴露韭研公社数据工具。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { JiuyanClient } from './api.js';
import { TOOLS } from './tools.js';

const VERSION = '0.1.0';
const MAX_OUTPUT_CHARS = 100_000;
const MAX_STRING_CHARS = 1_500;

/**
 * 结构化裁剪：超长时逐轮收缩（每轮：钳制长字符串、把超过阈值的数组保留前半），
 * 直到塞进预算。始终产出可解析的 JSON——绝不按字符硬切。
 */
function slimPass(node, arrCap) {
  if (Array.isArray(node)) {
    const kept = node.length > arrCap ? node.slice(0, arrCap) : node;
    return kept.map((x) => slimPass(x, arrCap));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] =
        typeof v === 'string' && v.length > MAX_STRING_CHARS
          ? v.slice(0, MAX_STRING_CHARS) + `…[字符串过长已截断，原长 ${v.length}]`
          : slimPass(v, arrCap);
    }
    return out;
  }
  return node;
}

function fitJson(data) {
  const size = (v) => JSON.stringify(v).length;
  if (size(data) <= MAX_OUTPUT_CHARS) return { value: data, trimmed: false };
  let v = data;
  for (const cap of [40, 12, 5, 2, 1]) {
    v = slimPass(v, cap);
    if (size(v) <= MAX_OUTPUT_CHARS) return { value: v, trimmed: true };
  }
  return { value: v, trimmed: true };
}

const log = (...a) => console.error(`[jiuyan-mcp]`, ...a);

const client = new JiuyanClient();

const server = new Server(
  { name: 'jiuyan-mcp', version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description:
      t.description +
      (client.authenticated ? '' : ' [当前未配置 JIYAN_SESSION，需登录的工具不可用]'),
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `未知工具: ${name}` }],
    };
  }
  try {
    if (process.env.JIYAN_DEBUG) log('call', name, JSON.stringify(args ?? {}));
    const data = await tool.handler(args ?? {}, client);
    const { value, trimmed } = fitJson(data);
    const text = JSON.stringify(trimmed ? { _note: `数据超长已结构化裁剪（数组保前缀、长字符串截断），原始 ${JSON.stringify(data).length} 字符；可用分页参数缩小范围`, data: value } : value, null, 1);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    if (process.env.JIYAN_DEBUG) log('error', name, e?.stack || e?.message || e);
    return {
      isError: true,
      content: [{ type: 'text', text: `调用失败: ${e?.message ?? String(e)}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${VERSION} 已启动（stdio），登录状态: ${client.authenticated ? '已配置 SESSION' : '匿名'}`);
}

main().catch((e) => {
  console.error('[jiuyan-mcp] 启动失败:', e);
  process.exit(1);
});
