/**
 * 接口实测：模拟浏览器发起的真实请求
 * 验证「发布 → 列表 → 详情」整条链路
 */

const BASE = 'http://localhost:3000';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, data: await r.json() };
}
async function get(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(15000) });
  return { status: r.status, data: await r.json() };
}

(async () => {
  console.log('=== 1. 发布一个闲置物品 ===');
  const r1 = await post('/api/publish', {
    nickname: '小明',
    studentNo: '2315402125',
    kind: 'goods',
    title: '二手吉他，用了两年',
    description: '音准正常，有一处小磕碰，可以约在图书馆门口',
    priceYuan: 380,
  });
  console.log('HTTP ' + r1.status);
  console.log(JSON.stringify(r1.data, null, 2).slice(0, 700));

  console.log('');
  console.log('=== 2. 同一个学号再发一个（应该复用同一个用户）===');
  const r2 = await post('/api/publish', {
    nickname: '小明',
    studentNo: '2315402125',
    kind: 'task',
    title: '帮忙去东门取个快递',
    description: '今天下午 6 点前，报酬 5 块',
    priceYuan: 5,
  });
  console.log('HTTP ' + r2.status);
  console.log('发布者 ID: ' + (r2.data.publisher ? r2.data.publisher.id : '?'));
  console.log('与第一单是否同一人: ' + (r1.data.publisher.id === r2.data.publisher.id ? '是 ✓' : '否 ✗'));

  console.log('');
  console.log('=== 3. 换个学号发布 ===');
  const r3 = await post('/api/publish', {
    nickname: '小华',
    studentNo: '2315402126',
    kind: 'goods',
    title: '考研英语真题册',
    priceYuan: 25,
  });
  console.log('HTTP ' + r3.status);
  console.log('发布者 ID: ' + r3.data.publisher.id);

  console.log('');
  console.log('=== 4. 不带学号发布（临时用户）===');
  const r4 = await post('/api/publish', {
    nickname: '路人甲',
    kind: 'goods',
    title: '旧台灯',
    priceYuan: 15,
  });
  console.log('HTTP ' + r4.status);
  console.log('是否实名: ' + r4.data.publisher.verified);

  console.log('');
  console.log('=== 5. 查交易列表 ===');
  const l = await get('/api/trades');
  console.log('共 ' + l.data.trades.length + ' 笔');
  l.data.trades.forEach((t) => {
    console.log(`  [${t.kind === 'task' ? '任务' : '物品'}] ${t.title}  ¥${t.price}  ${t.status}`);
  });

  console.log('');
  console.log('=== 6. 按类型筛选 ===');
  const lt = await get('/api/trades?kind=task');
  const lg = await get('/api/trades?kind=goods');
  console.log('跑腿任务: ' + lt.data.trades.length + ' 笔');
  console.log('闲置物品: ' + lg.data.trades.length + ' 笔');

  console.log('');
  console.log('=== 7. 查单笔详情（含事件流水）===');
  const id = r1.data.trade.id;
  const d = await get('/api/trades/' + id);
  console.log('标题: ' + d.data.trade.title);
  console.log('事件: ' + JSON.stringify(d.data.events.map((e) => e.action)));

  console.log('');
  console.log('=== 8. 非法请求应被拒绝 ===');
  const bad1 = await post('/api/publish', { nickname: '', title: '缺昵称', priceYuan: 1 });
  console.log('空昵称 → HTTP ' + bad1.status + ' ' + bad1.data.error);
  const bad2 = await post('/api/publish', { nickname: '测试', title: '', priceYuan: 1 });
  console.log('空标题 → HTTP ' + bad2.status + ' ' + bad2.data.error);
  const bad3 = await post('/api/publish', { nickname: '测试', title: '负价格', priceYuan: -5 });
  console.log('负价格 → HTTP ' + bad3.status + ' ' + bad3.data.error);
  const bad4 = await get('/api/trades/不存在的单号');
  console.log('查不存在的单 → HTTP ' + bad4.status + ' ' + bad4.data.error);

  console.log('');
  console.log('=== 9. 最终状态 ===');
  const h = await get('/api/health');
  console.log('用户 ' + h.data.users + ' 个，交易 ' + h.data.trades + ' 笔');
})();
