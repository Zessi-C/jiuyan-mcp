// tools.js — MCP 工具定义：异动(需登录)、时间轴、热榜、搜索、详情、社区栏目、关注流(需登录)。

const int = { type: 'integer' };
const str = { type: 'string' };

/** @type {Array<{name:string, description:string, inputSchema:object, handler:(args:object, client:object)=>Promise<any>}>} */
export const TOOLS = [
  {
    name: 'jiuyan_get_timeline',
    description:
      '获取韭研公社「时间轴」：按日期分组的盘前/盘中事件流，每条含标题、关联文章 article_id、评级 timeline.grade、题材 theme_list 等。匿名可用。',
    inputSchema: {
      type: 'object',
      properties: {
        start: { ...int, description: '页码，从 1 开始', default: 1 },
        limit: { ...int, description: '每页条数（站点默认 20）', default: 20 },
        date: { ...str, description: '可选。只保留该日期(YYYY-MM-DD)或该月份前缀(YYYY-MM)的分组', default: '' },
      },
    },
    handler: async (a, client) => {
      const json = await client.post('/api/v1/timeline/list', {
        start: a.start ?? 1,
        limit: a.limit ?? 20,
      });
      const groups = Array.isArray(json.data) ? json.data : [];
      const filtered = a.date ? groups.filter((g) => String(g.date || '').startsWith(a.date)) : groups;
      return { ...json, data: filtered };
    },
  },
  {
    name: 'jiuyan_get_rank_board',
    description:
      '获取韭研公社「热榜」：hot_search_list 热搜关键词榜 + hot_article_list 热门文章榜（含标题/热度/作者等）。匿名可用。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_a, client) => (await client.post('/api/v1/article/rank-board', {})).data,
  },
  {
    name: 'jiuyan_search_articles',
    description:
      '按关键词搜索韭研公社讨论帖/文章（研选、复盘、纪要等），返回标题、摘要、作者、热度与 article_id。匿名可用。',
    inputSchema: {
      type: 'object',
      required: ['keyword'],
      properties: {
        keyword: { ...str, description: '搜索关键词' },
        order: { ...int, description: '排序：1=按热度 2=按时间', default: 1 },
        limit: { ...int, description: '每页条数，站点默认 15', default: 15 },
        page: { ...int, description: '页码，从 1 开始', default: 1 },
        back_garden: { ...int, description: '板块过滤：0=全部(后花园关闭)', default: 0 },
      },
    },
    handler: async (a, client) => {
      const limit = a.limit ?? 15;
      const page = a.page ?? 1;
      return (
        await client.post('/api/v2/article/search', {
          keyword: String(a.keyword),
          order: a.order ?? 1,
          limit,
          start: (page - 1) * limit,
          type: '1',
          back_garden: a.back_garden ?? 0,
        })
      ).data;
    },
  },
  {
    name: 'jiuyan_get_article_detail',
    description:
      '按 article_id 获取韭研公社文章全文（HTML 正文、作者、发布时间、点赞/评论数等）。article_id 可来自时间轴/热榜/搜索结果。匿名可用。',
    inputSchema: {
      type: 'object',
      required: ['article_id'],
      properties: { article_id: { ...str, description: '文章 ID，如 "1hsuwjwqkv5"' } },
    },
    handler: async (a, client) =>
      (await client.post('/api/v2/article/detail', { article_id: String(a.article_id) })).data,
  },
  {
    name: 'jiuyan_get_community',
    description:
      '浏览韭研公社社区栏目列表（研选 back_garden=0 / 广场=1 / 生活区=2），可按热度(hot/hot30)、发布时间、异动(action)排序，可按分类(96纪要/97题材/98复盘/99短文/101资讯/102个股)过滤。匿名可用。',
    inputSchema: {
      type: 'object',
      properties: {
        back_garden: { ...int, description: '栏目：0=研选 1=广场 2=生活区', default: 0 },
        order: { ...int, description: '排序：0=最新发布 1=热门 3=30日热 5=异动', default: 0 },
        category_id: { ...str, description: '分类 ID："96"纪要 "97"题材 "98"复盘 "99"短文 "101"资讯 "102"个股，空=全部', default: '' },
        start_time: { ...str, description: '可选起始日期 YYYY-MM-DD', default: '' },
        end_time: { ...str, description: '可选结束日期 YYYY-MM-DD', default: '' },
        start: { ...int, description: '页码，从 1 开始', default: 1 },
        limit: { ...int, description: '每页条数', default: 15 },
      },
    },
    handler: async (a, client) => {
      const body = {
        back_garden: a.back_garden ?? 0,
        order: a.order ?? 0,
        category_id: a.category_id ? String(a.category_id) : '',
        type: 0,
        start: a.start ?? 1,
        limit: a.limit ?? 15,
        start_time: a.start_time ? String(a.start_time) : '',
        end_time: a.end_time ? String(a.end_time) : '',
      };
      return (await client.post('/api/v2/article/community', body)).data;
    },
  },
  {
    name: 'jiuyan_get_action_field',
    description:
      '获取韭研公社「异动」当日板块字段列表（各板块的 action_field_id 与名称），是调用 jiuyan_get_action_list 的前置。需要登录（JIYAN_SESSION）。',
    inputSchema: {
      type: 'object',
      required: ['date'],
      properties: { date: { ...str, description: '交易日 YYYY-MM-DD' } },
    },
    handler: async (a, client) =>
      (await client.post('/api/v1/action/field', { date: String(a.date), pc: 1 })).data,
  },
  {
    name: 'jiuyan_get_action_list',
    description:
      '获取韭研公社「异动」某板块下的个股异动列表（股票名/代码/价格、涨停原因 expound、时间等）。需要登录（JIYAN_SESSION）。先用 jiuyan_get_action_field 拿 action_field_id。',
    inputSchema: {
      type: 'object',
      required: ['action_field_id'],
      properties: {
        action_field_id: { ...str, description: '板块字段 ID（来自 jiuyan_get_action_field）' },
        start: { ...int, description: '页码，从 1 开始', default: 1 },
        limit: { ...int, description: '每页条数', default: 50 },
        sort_price: { ...int, description: '按价格排序方向（0 不排）', default: 0 },
        sort_range: { ...int, description: '按涨跌幅排序方向（0 不排）', default: 0 },
        sort_time: { ...int, description: '按时间排序方向（0 不排）', default: 0 },
      },
    },
    handler: async (a, client) => {
      const body = {
        action_field_id: String(a.action_field_id),
        pc: 1,
        start: a.start ?? 1,
        limit: a.limit ?? 50,
        sort_price: a.sort_price ?? 0,
        sort_range: a.sort_range ?? 0,
        sort_time: a.sort_time ?? 0,
      };
      return (await client.post('/api/v1/action/list', body)).data;
    },
  },
  {
    name: 'jiuyan_get_follow_feed',
    description:
      '获取登录用户的关注流（自己关注的人的最新发言/文章）。需要登录（JIYAN_SESSION）。返回文章列表含标题、作者、时间与 article_id。',
    inputSchema: {
      type: 'object',
      properties: {
        start: { ...int, description: '页码，从 1 开始', default: 1 },
        limit: { ...int, description: '每页条数', default: 10 },
      },
    },
    handler: async (a, client) =>
      (
        await client.post('/api/v2/article/newest/list', {
          start: a.start ?? 1,
          limit: a.limit ?? 10,
        })
      ).data,
  },
];
