/**
 * 账本压力测试
 *
 * 目的：证明账本在最恶劣的情况下也不会算错钱
 * 场景全部来自我们讨论过的那两个坑：
 *   坑A：余额不够时，会不会扣成负数？
 *   坑B：同一笔订单重复提交，会不会扣两次？
 */

const { Ledger } = require('../src/ledger/ledger');

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  [通过] ${name}`);
  } else {
    fail++;
    console.log(`  [失败] ${name} ${detail}`);
  }
}

function section(t) {
  console.log('');
  console.log('── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length)));
}

// ══════════════════════════════════════════════════════════════
section('场景 1：基本流程 —— 充钱、下单、结算、提现');
{
  const L = new Ledger();
  L.createAccount('ming');
  L.createAccount('hua');

  L.deposit('ming', 100);
  check('充值后余额 100', L.getBalance('ming').balance === 100);

  L.createOrderAndFreeze({
    orderId: 'ord-1', type: 'goods',
    buyerId: 'ming', sellerId: 'hua', amountYuan: 80,
  });
  const m1 = L.getBalance('ming');
  check('下单后可用余额 20', m1.available === 20, `实际 ${m1.available}`);
  check('下单后冻结 80', m1.frozen === 80, `实际 ${m1.frozen}`);

  L.settle('ord-1');
  check('结算后明余额 20', L.getBalance('ming').balance === 20);
  check('结算后华余额 80', L.getBalance('hua').balance === 80);
  check('结算后明冻结归零', L.getBalance('ming').frozen === 0);

  L.withdraw('hua', 30);
  check('华提现 30 后余额 50', L.getBalance('hua').balance === 50);

  const a = L.audit();
  check('对账平衡', a.balanced, JSON.stringify(a));
  L.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 2：坑A —— 余额不够，绝不能扣成负数');
{
  const L = new Ledger();
  L.createAccount('ming');
  L.createAccount('hua');
  L.deposit('ming', 100);

  // 第一单 80，应该成功
  L.createOrderAndFreeze({
    orderId: 'ord-A', type: 'goods',
    buyerId: 'ming', sellerId: 'hua', amountYuan: 80,
  });
  check('第一单成功，可用剩 20', L.getBalance('ming').available === 20);

  // 第二单 80，可用只有 20，必须失败
  let threw = false;
  try {
    L.createOrderAndFreeze({
      orderId: 'ord-B', type: 'goods',
      buyerId: 'ming', sellerId: 'hua', amountYuan: 80,
    });
  } catch (e) {
    threw = true;
    console.log('        拒绝原因: ' + e.message);
  }
  check('第二单被拒绝', threw);

  const b = L.getBalance('ming');
  check('余额没有被扣成负数', b.balance >= 0, `实际 ${b.balance}`);
  check('余额仍为 100，冻结 80', b.balance === 100 && b.frozen === 80);

  // 失败的订单不应该留在库里
  const orderB = L.db.prepare('SELECT * FROM orders WHERE id = ?').get('ord-B');
  check('失败的订单已回滚，未残留', orderB === undefined);

  L.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 3：坑B —— 同一笔订单重复提交，只能成功一次');
{
  const L = new Ledger();
  L.createAccount('ming');
  L.createAccount('hua');
  L.deposit('ming', 1000);

  const orderData = {
    orderId: 'ord-dup', type: 'goods',
    buyerId: 'ming', sellerId: 'hua', amountYuan: 100,
  };

  L.createOrderAndFreeze(orderData);
  check('第一次提交成功，冻结 100', L.getBalance('ming').frozen === 100);

  // 模拟用户手抖，又提交了一遍完全相同的订单
  let threw = false;
  try {
    L.createOrderAndFreeze(orderData);
  } catch (e) {
    threw = true;
    console.log('        拒绝原因: ' + e.message);
  }
  check('重复提交被拒绝', threw);
  check('冻结仍是 100，没有扣两次', L.getBalance('ming').frozen === 100);

  L.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 4：结算防重 —— 同一订单不能结算两次');
{
  const L = new Ledger();
  L.createAccount('ming');
  L.createAccount('hua');
  L.deposit('ming', 500);

  L.createOrderAndFreeze({
    orderId: 'ord-s', type: 'goods',
    buyerId: 'ming', sellerId: 'hua', amountYuan: 200,
  });
  L.settle('ord-s');
  check('首次结算成功，卖家得 200', L.getBalance('hua').balance === 200);

  let threw = false;
  try {
    L.settle('ord-s');
  } catch (e) {
    threw = true;
    console.log('        拒绝原因: ' + e.message);
  }
  check('重复结算被拒绝', threw);
  check('卖家余额仍是 200，没有翻倍', L.getBalance('hua').balance === 200);

  L.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 5：混战 —— 20 笔并发抢同一个余额，只能成功该成功的那些');
{
  const L = new Ledger();
  L.createAccount('ming');
  L.createAccount('hua');
  L.deposit('ming', 1000); // 只够 10 笔 100 元的单

  let ok = 0;
  let rejected = 0;
  for (let i = 0; i < 20; i++) {
    try {
      L.createOrderAndFreeze({
        orderId: `ord-m-${i}`, type: 'goods',
        buyerId: 'ming', sellerId: 'hua', amountYuan: 100,
      });
      ok++;
    } catch (e) {
      rejected++;
    }
  }

  console.log(`        成功 ${ok} 笔，拒绝 ${rejected} 笔`);
  check('恰好成功 10 笔', ok === 10, `实际 ${ok}`);
  check('恰好拒绝 10 笔', rejected === 10, `实际 ${rejected}`);
  check('可用余额归零', L.getBalance('ming').available === 0);
  check('冻结恰好 1000', L.getBalance('ming').frozen === 1000);

  const a = L.audit();
  check('混战后对账仍平衡', a.balanced, JSON.stringify(a));

  L.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 6：任务型订单 —— 与闲置交易共用状态机');
{
  const L = new Ledger();
  L.createAccount('boss');   // 发任务的
  L.createAccount('worker'); // 接单的
  L.deposit('boss', 300);

  // 发布任务：先冻结赏金
  L.createOrderAndFreeze({
    orderId: 'task-1', type: 'task',
    buyerId: 'boss', sellerId: 'worker', amountYuan: 150,
  });
  check('任务发布，赏金已托管', L.getBalance('boss').frozen === 150);
  check('接单者此时还没拿到钱', L.getBalance('worker').balance === 0);

  // 验收通过 → 放款
  L.settle('task-1');
  check('验收后接单者到账 150', L.getBalance('worker').balance === 150);
  check('发布者冻结释放', L.getBalance('boss').frozen === 0);

  const a = L.audit();
  check('任务流对账平衡', a.balanced);

  L.close();
}

// ══════════════════════════════════════════════════════════════
section('场景 7：流水完整性 —— 每笔变动都要有记录');
{
  const L = new Ledger();
  L.createAccount('ming');
  L.createAccount('hua');
  L.deposit('ming', 500);
  L.createOrderAndFreeze({
    orderId: 'ord-t', type: 'goods',
    buyerId: 'ming', sellerId: 'hua', amountYuan: 300,
  });
  L.settle('ord-t');
  L.withdraw('hua', 100);

  const txMing = L.getTransactions('ming');
  const txHua = L.getTransactions('hua');

  // 明：充值 → 冻结 → （结算时）解冻，共 3 条
  // 结算会同时产生两条流水：买家的 unfreeze 和卖家的 settle
  check('明的流水有 3 条（充值 + 冻结 + 解冻）', txMing.length === 3, `实际 ${txMing.length}`);
  check('华的流水有 2 条（结算 + 提现）', txHua.length === 2, `实际 ${txHua.length}`);
  check('明第二条是 freeze', txMing[1].action === 'freeze');
  check('明第三条是 unfreeze', txMing[2].action === 'unfreeze');
  check('华最后一条是 withdraw', txHua[txHua.length - 1].action === 'withdraw');

  console.log('');
  console.log('        明 的流水:');
  txMing.forEach((t) => console.log(`          ${t.action.padEnd(9)} ${String(t.amount).padStart(6)}  余额 ${t.balance_after} 冻结 ${t.frozen_after}`));
  console.log('        华 的流水:');
  txHua.forEach((t) => console.log(`          ${t.action.padEnd(9)} ${String(t.amount).padStart(6)}  余额 ${t.balance_after} 冻结 ${t.frozen_after}`));

  L.close();
}

// ══════════════════════════════════════════════════════════════
console.log('');
console.log('═'.repeat(60));
console.log(`  测试结果：通过 ${pass} 项，失败 ${fail} 项`);
console.log('═'.repeat(60));

process.exit(fail > 0 ? 1 : 0);
