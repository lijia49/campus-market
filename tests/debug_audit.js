/**
 * 排查对账失败的原因
 *
 * 症状：场景5 里冻结 1000 元，但 audit() 算出来 left = 2000
 * 疑问：是账本写错了，还是 audit() 的算法写错了？
 */

const { Ledger } = require('../src/ledger/ledger');

const L = new Ledger();
L.createAccount('ming');
L.createAccount('hua');
L.deposit('ming', 1000);

// 下 10 单，每单 100
for (let i = 0; i < 10; i++) {
  L.createOrderAndFreeze({
    orderId: `o-${i}`, type: 'goods',
    buyerId: 'ming', sellerId: 'hua', amountYuan: 100,
  });
}

console.log('=== 账户真实状态 ===');
const raw = L.db.prepare('SELECT * FROM accounts').all();
raw.forEach((a) => {
  console.log(`  ${a.user_id}: balance=${a.balance}  frozen=${a.frozen}`);
});

console.log('');
console.log('=== 流水明细 ===');
const txs = L.db.prepare('SELECT * FROM transactions ORDER BY id').all();
let sumDep = 0, sumWithdraw = 0, sumFreeze = 0, sumSettle = 0, sumUnfreeze = 0;
txs.forEach((t) => {
  console.log(`  #${t.id} ${t.user_id.padEnd(6)} ${t.action.padEnd(9)} ${String(t.amount).padStart(7)}`);
  if (t.action === 'deposit') sumDep += t.amount;
  if (t.action === 'withdraw') sumWithdraw += t.amount;
  if (t.action === 'freeze') sumFreeze += t.amount;
  if (t.action === 'settle') sumSettle += t.amount;
  if (t.action === 'unfreeze') sumUnfreeze += t.amount;
});

console.log('');
console.log('=== 各动作合计 ===');
console.log(`  deposit  : ${sumDep}`);
console.log(`  withdraw : ${sumWithdraw}`);
console.log(`  freeze   : ${sumFreeze}   ← 负数，钱被锁住`);
console.log(`  settle   : ${sumSettle}`);
console.log(`  unfreeze : ${sumUnfreeze}`);

console.log('');
console.log('=== 关键：钱在「余额」和「冻结」之间是搬来搬去的 ===');
console.log('  冻结时：balance 不动，frozen 增加');
console.log('  → 此时 balance + frozen 这个和，会因为「重复计算」而变大！');
console.log('');
console.log('  正确理解：');
console.log('    balance   是「账户总资产」（含被冻结的）');
console.log('    frozen    是「其中有多少被锁住」');
console.log('    available = balance - frozen  = 真正能动的');
console.log('');
console.log('  所以资产总和 = Σbalance  （不是 Σbalance + Σfrozen！）');
console.log('');
const sumB = raw.reduce((s, a) => s + a.balance, 0);
const sumF = raw.reduce((s, a) => s + a.frozen, 0);
console.log(`  验证：Σbalance = ${sumB}，应该等于 总充值 ${sumDep}`);
console.log(`        而 Σbalance + Σfrozen = ${sumB + sumF}  ← 这个数没意义`);

console.log('');
console.log('=== audit() 的 bug ===');
console.log('  原代码：left = Σbalance + Σfrozen   ← 错，冻结的钱被算了两次');
console.log('  正确：  left = Σbalance              ← 对，balance 本来就是总资产');
console.log('');
console.log('  另外 right 也不该是 dep + wd，而应该是 dep + wd（wd 是负数）——这个倒是对的。');

L.close();
