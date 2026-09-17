/**
 * 交易核心测试（甲路线：纯撮合）
 *
 * 重点验证三件事：
 *   1. 状态机 —— 乱跳的状态必须被拒绝
 *   2. 防重复 —— 同一笔单不能确认两次
 *   3. 信用记录 —— 谁守约谁放鸽子，记得准不准
 */

const { TradeCore, STATUS } = require('../src/trade/trade');

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [通过] ${name}`); }
  else { fail++; console.log(`  [失败] ${name} ${detail}`); }
}
function section(t) {
  console.log('');
  console.log('── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length)));
}
function expectThrow(name, fn) {
  let threw = false;
  let reason = '';
  try { fn(); } catch (e) { threw = true; reason = e.message; }
  check(name, threw, '（本该被拒绝却成功了）');
  if (threw) console.log('        拒绝原因: ' + reason);
}

function fresh() {
  const T = new TradeCore();
  T.register({ id: 'ming', nickname: '小明', studentNo: '2315402125' });
  T.register({ id: 'hua', nickname: '小华', studentNo: '2315402126' });
  T.register({ id: 'out', nickname: '校外用户' });   // 没有学号
  return T;
}

// ══════════════════════════════════════════════════════════════
section('场景 1：用户注册与实名');
{
  const T = fresh();
  const ming = T.getUser('ming');
  check('有学号的用户标记为已实名', ming.verified === true);
  check('学号正确保存', ming.student_no === '2315402125');

  const out = T.getUser('out');
  check('无学号用户未实名', out.verified === false);

  expectThrow('学号不能重复注册', () =>
    T.register({ id: 'other', nickname: '冒充者', studentNo: '2315402125' }));

  T.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 2：完整流程 —— 发布 → 接单 → 交付 → 确认');
{
  const T = fresh();

  T.publish({
    tradeId: 'g1', kind: 'goods', title: '二手吉他',
    description: '用了两年，音准正常', priceYuan: 380, publisherId: 'ming',
  });
  check('发布后状态为 open', T.getTrade('g1').status === STATUS.OPEN);

  T.take({ tradeId: 'g1', takerId: 'hua' });
  check('接单后状态为 taken', T.getTrade('g1').status === STATUS.TAKEN);

  T.deliver({ tradeId: 'g1', actorId: 'hua' });
  check('交付后状态为 delivering', T.getTrade('g1').status === STATUS.DELIVERING);

  T.confirm({ tradeId: 'g1', actorId: 'ming' });
  check('确认后状态为 completed', T.getTrade('g1').status === STATUS.COMPLETED);

  const ev = T.getEvents('g1');
  check('事件记录完整（4 条）', ev.length === 4, `实际 ${ev.length}`);
  check('事件顺序正确',
    ev.map((e) => e.action).join(',') === 'publish,take,deliver,confirm',
    ev.map((e) => e.action).join(','));

  const a = T.audit();
  check('状态自检通过', a.ok, JSON.stringify(a.problems));

  T.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 3：状态机 —— 乱跳必须被拒绝');
{
  const T = fresh();
  T.publish({ tradeId: 'g2', kind: 'goods', title: '自行车', priceYuan: 200, publisherId: 'ming' });

  // open 状态下不能直接确认完成
  expectThrow('未接单就想确认完成', () =>
    T.confirm({ tradeId: 'g2', actorId: 'ming' }));

  // open 状态下不能标记已交付
  expectThrow('未接单就想标记交付', () =>
    T.deliver({ tradeId: 'g2', actorId: 'hua' }));

  T.take({ tradeId: 'g2', takerId: 'hua' });

  // taken 状态下不能跳过交付直接确认
  expectThrow('没交付就确认完成', () =>
    T.confirm({ tradeId: 'g2', actorId: 'ming' }));

  T.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 4：防重复 —— 同一笔单不能被确认两次');
{
  const T = fresh();
  T.publish({ tradeId: 'g3', kind: 'goods', title: '书桌', priceYuan: 150, publisherId: 'ming' });
  T.take({ tradeId: 'g3', takerId: 'hua' });
  T.deliver({ tradeId: 'g3', actorId: 'hua' });
  T.confirm({ tradeId: 'g3', actorId: 'ming' });
  check('首次确认成功', T.getTrade('g3').status === STATUS.COMPLETED);

  const scoreBefore = T.getScore('hua');
  expectThrow('重复确认第二次被拒绝', () =>
    T.confirm({ tradeId: 'g3', actorId: 'ming' }));

  check('信用分没有被重复加分', T.getScore('hua') === scoreBefore,
    `之前 ${scoreBefore}，现在 ${T.getScore('hua')}`);

  const confirmEvents = T.getEvents('g3').filter((e) => e.action === 'confirm');
  check('只有一条确认事件', confirmEvents.length === 1, `实际 ${confirmEvents.length}`);

  T.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 5：抢单 —— 一笔单只能被一个人接走');
{
  const T = fresh();
  T.register({ id: 'hua2', nickname: '小华二号', studentNo: '2315402127' });
  T.publish({ tradeId: 't1', kind: 'task', title: '帮取快递', priceYuan: 10, publisherId: 'ming' });

  T.take({ tradeId: 't1', takerId: 'hua' });
  check('第一个接单成功', T.getTrade('t1').taker_id === 'hua');

  expectThrow('第二个人抢单被拒绝', () =>
    T.take({ tradeId: 't1', takerId: 'hua2' }));

  check('接单人没被覆盖', T.getTrade('t1').taker_id === 'hua');

  T.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 6：权限 —— 不是参与方不能乱动');
{
  const T = fresh();
  T.register({ id: 'stranger', nickname: '路人', studentNo: '2315402128' });
  T.publish({ tradeId: 'g4', kind: 'goods', title: '键盘', priceYuan: 120, publisherId: 'ming' });
  T.take({ tradeId: 'g4', takerId: 'hua' });
  T.deliver({ tradeId: 'g4', actorId: 'hua' });

  expectThrow('路人不能确认完成', () =>
    T.confirm({ tradeId: 'g4', actorId: 'stranger' }));

  expectThrow('接单方不能自己确认完成', () =>
    T.confirm({ tradeId: 'g4', actorId: 'hua' }));

  expectThrow('发布者不能替接单方标记交付', () =>
    T.deliver({ tradeId: 'g4', actorId: 'ming' }));

  T.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 7：信用体系 —— 放鸽子要扣分');
{
  const T = fresh();
  check('初始信用分 100', T.getScore('hua') === 100);

  // 顺利完成一单
  T.publish({ tradeId: 'c1', kind: 'task', title: '帮忙打印', priceYuan: 5, publisherId: 'ming' });
  T.take({ tradeId: 'c1', takerId: 'hua' });
  T.deliver({ tradeId: 'c1', actorId: 'hua' });
  T.confirm({ tradeId: 'c1', actorId: 'ming' });
  const afterOk = T.getScore('hua');
  check('完成后接单方加分', afterOk === 103, `实际 ${afterOk}`);

  // 接了单又取消（放鸽子）
  T.publish({ tradeId: 'c2', kind: 'task', title: '帮忙搬东西', priceYuan: 20, publisherId: 'ming' });
  T.take({ tradeId: 'c2', takerId: 'hua' });
  T.cancel({ tradeId: 'c2', actorId: 'hua' });
  const afterCancel = T.getScore('hua');
  check('接单后取消要扣分', afterCancel === 98, `实际 ${afterCancel}`);

  const hist = T.getCreditHistory('hua');
  console.log('        华的信用流水:');
  hist.forEach((h) => console.log(`          ${h.kind.padEnd(20)} ${h.score > 0 ? '+' : ''}${h.score}`));

  T.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 8：争议流程 —— 出问题要能暂停并处理');
{
  const T = fresh();
  T.publish({ tradeId: 'd1', kind: 'goods', title: '手机', priceYuan: 800, publisherId: 'ming' });
  T.take({ tradeId: 'd1', takerId: 'hua' });
  T.deliver({ tradeId: 'd1', actorId: 'hua' });

  T.dispute({ tradeId: 'd1', actorId: 'ming', note: '东西有破损' });
  check('争议后状态为 disputed', T.getTrade('d1').status === STATUS.DISPUTED);
  check('争议备注已记录', T.getEvents('d1').slice(-1)[0].note === '东西有破损');

  // 这条曾经是真 bug：disputed 允许直接跳到 completed，
  // 导致对方点一下「确认」就能把争议抹掉
  expectThrow('争议中当事人不能直接确认（防抹掉争议）', () =>
    T.confirm({ tradeId: 'd1', actorId: 'ming' }));

  expectThrow('裁定不填说明要被拒绝', () =>
    T.resolve({ tradeId: 'd1', actorId: 'admin', outcome: 'completed' }));

  T.register({ id: 'admin', nickname: '管理员' });

  // 判给卖家（交易完成）
  T.resolve({ tradeId: 'd1', actorId: 'admin', outcome: 'completed', note: '核实后确认货物完好，交易有效' });
  check('裁定后状态为 completed', T.getTrade('d1').status === STATUS.COMPLETED);

  const huaCredit = T.getCreditHistory('hua');
  check('胜诉方加了信用分', huaCredit.some((c) => c.kind === 'dispute_won'), JSON.stringify(huaCredit));
  const mingCredit = T.getCreditHistory('ming');
  check('败诉方被扣信用分', mingCredit.some((c) => c.kind === 'dispute_lost'), JSON.stringify(mingCredit));

  console.log('        裁定结果已记录: ' + T.getEvents('d1').slice(-1)[0].note);

  T.close();
}

section('场景 8b：争议中退款给买家');
{
  const T = fresh();
  T.register({ id: 'admin', nickname: '管理员' });
  T.publish({ tradeId: 'd2', kind: 'goods', title: '耳机', priceYuan: 300, publisherId: 'ming' });
  T.take({ tradeId: 'd2', takerId: 'hua' });
  T.deliver({ tradeId: 'd2', actorId: 'hua' });
  T.dispute({ tradeId: 'd2', actorId: 'ming', note: '货不对版' });

  T.resolve({ tradeId: 'd2', actorId: 'admin', outcome: 'cancelled', note: '核实存在货不对版，交易作废' });
  check('判给买家，状态为 cancelled', T.getTrade('d2').status === STATUS.CANCELLED);

  const mingCredit = T.getCreditHistory('ming');
  check('买家（发布方）胜诉加回信用分', mingCredit.some((c) => c.kind === 'dispute_won'));
  const huaCredit = T.getCreditHistory('hua');
  check('卖家（接单方）败诉扣分', huaCredit.some((c) => c.kind === 'dispute_lost'));

  T.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 9：任务与物品共用状态机');
{
  const T = fresh();

  // 跑腿任务
  T.publish({ tradeId: 'task-1', kind: 'task', title: '代拿外卖', priceYuan: 3, publisherId: 'ming' });
  T.take({ tradeId: 'task-1', takerId: 'hua' });
  T.deliver({ tradeId: 'task-1', actorId: 'hua' });
  T.confirm({ tradeId: 'task-1', actorId: 'ming' });

  // 闲置物品
  T.publish({ tradeId: 'goods-1', kind: 'goods', title: '旧台灯', priceYuan: 25, publisherId: 'ming' });
  T.take({ tradeId: 'goods-1', takerId: 'hua' });
  T.deliver({ tradeId: 'goods-1', actorId: 'hua' });
  T.confirm({ tradeId: 'goods-1', actorId: 'ming' });

  const all = T.listTrades({ status: STATUS.COMPLETED });
  check('两种类型都完成了', all.length === 2, `实际 ${all.length}`);

  const tasks = T.listTrades({ kind: 'task' });
  const goods = T.listTrades({ kind: 'goods' });
  check('按类型筛选正常', tasks.length === 1 && goods.length === 1);

  T.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 10：不能自己接自己的单');
{
  const T = fresh();
  T.publish({ tradeId: 'e1', kind: 'task', title: '自娱自乐', priceYuan: 1, publisherId: 'ming' });
  expectThrow('发布者不能接自己的单', () =>
    T.take({ tradeId: 'e1', takerId: 'ming' }));
  T.close();
}

// ══════════════════════════════════════════════════════════════
console.log('');
console.log('═'.repeat(60));
console.log(`  测试结果：通过 ${pass} 项，失败 ${fail} 项`);
console.log('═'.repeat(60));

process.exit(fail > 0 ? 1 : 0);
