# jiuyan-mcp

韭研公社（[jiuyangongshe.com](https://www.jiuyangongshe.com/action)）数据获取 MCP 服务器。

优先**免登录**获取公开特色数据（时间轴、热榜、搜索、文章全文、社区栏目）；「异动」与「关注流」为站内登录数据，配置网页 `SESSION` cookie 后可用。

> 仅供个人学习与研究，请尊重站点服务条款，勿高频抓取或商用。本仓库与韭研公社官方无任何关联。

## 工具一览

| 工具 | 说明 | 登录 |
|---|---|---|
| `jiuyan_get_timeline` | 时间轴：按日期分组的事件流（标题/评级/题材/关联文章） | 否 |
| `jiuyan_get_rank_board` | 热榜：热搜关键词榜 + 热门文章榜 | 否 |
| `jiuyan_search_articles` | 关键词搜索讨论帖/文章（按热度或时间排序） | 否 |
| `jiuyan_get_article_detail` | 按 article_id 取文章 HTML 全文与元信息 | 否 |
| `jiuyan_get_community` | 社区栏目列表（研选/广场/生活区 × 最新/热门/异动排序） | 否 |
| `jiuyan_get_action_field` | 异动当日板块字段列表（action_field_id） | **是** |
| `jiuyan_get_action_list` | 异动板块下的个股异动明细（涨停原因等） | **是** |
| `jiuyan_get_follow_feed` | 关注流：自己关注的人的最新发言 | **是** |

## 快速开始

```bash
git clone <repo-url> && cd jiuyan-mcp
npm install
```

在你的 MCP 客户端配置（如 `~/.omp/agent/mcp.json`）中注册：

```json
{
  "mcpServers": {
    "jiuyan": {
      "type": "stdio",
      "command": "node",
      "args": ["/绝对路径/jiuyan-mcp/src/index.js"],
      "env": {
        "JIYAN_SESSION": "<可选：网页 SESSION cookie 值>"
      }
    }
  }
}
```

### 登录 cookie（JIYAN_SESSION）获取

1. 浏览器登录 www.jiuyangongshe.com；
2. F12 → Application/存储 → Cookies → `https://www.jiuyangongshe.com`；
3. 复制名为 **`SESSION`** 的值填入 `JIYAN_SESSION`；
4. 重启 MCP 客户端。未配置时匿名工具照常工作，登录工具返回明确提示。

## 签名机制（为什么需要这个服务器才能跑）

韭研公社 web API（`web-api.jiuyangongshe.com/jystock-app`）每个请求要求 `token` + `timestamp`
头。签名原料由 SSR 页面内嵌（`window.__NUXT__` 中混淆键的 `{digest, project, serverTime}`），
推导算法藏在 Nuxt 打包的 VM 混淆模块里。本项目在 `node:vm` 沙箱内收割 webpack 模块表并
初始化该模块，直接调用其签名函数生成每次请求的头，全程无需浏览器。

健壮性设计：

- digest 键名与签名函数名均为混淆产物——用宽松正则提取 digest，签名函数按"输出形状"
  自动发现，站点发版轮换名字也能自适应；
- 签名时间窗 <10 分钟，token 失效（errCode=110）时自动重抓页面重建沙箱并重试一次；
- chunk 文件缓存于系统临时目录（7 天），避免重复下载 ~1.6MB 静态资源；
- 相邻上游请求强制 ≥1s 间隔，礼貌限速。

## 已知限制

- 「异动」全家桶与关注流实测必须登录态（errCode=1），匿名无法绕过；
- 未在任何公开项目中找到"按 user_id 拉取指定用户历史发言"的 web 端点，关注的人发言
  目前经关注流（`/api/v2/article/newest/list`）获取；
- 旧 APP 域名 `app.jiuyangongshe.com` 有版本门禁（errCode=9），本项目不使用；
- 站点前端大版本升级可能导致签名模块 id 变化，届时需更新 `KNOWN_MODULE_IDS`。

## 结构

```
src/
  signer.js   # SSR digest 抓取 + vm 沙箱签名函数发现与调用
  api.js      # HTTP 客户端：鉴权头、限速、errCode 映射、110 自动重试
  tools.js    # 8 个 MCP 工具定义与入参 schema
  index.js    # stdio MCP 服务器入口
```

## License

MIT
