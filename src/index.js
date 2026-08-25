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
    let text = JSON.stringify(data, null, 1);
    if (text.length > MAX_OUTPUT_CHARS) {
      text =
        text.slice(0, MAX_OUTPUT_CHARS) +
        `\n…[输出超长被截断，原始长度 ${text.length} 字符；请用分页参数缩小范围]`;
    }
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
