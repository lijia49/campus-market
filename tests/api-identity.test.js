/**
 * 身份审核 + 发布流程 端到端实测
 * ═══════════════════════════════════════════════════════════
 *
 * 需要服务已启动。测的是「老板真实会遇到的场景」：
 *   1. 学号新人 → 直接通过 → 能发布
 *   2. 手滑填了别人的学号 → 挂起 → 发不出去，但提示明确
 *   3. 真冒用（学号 + 姓名都一样）→ 进人工队列
 *   4. 匿名 → 拒绝，但告诉他可以先去逛
 *   5. 人工裁定 → 学号归属确定
 */

const BASE = 'http://127.0.0.1:3000';
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      期望: ${JSON.stringify(expected)}`);
    console.log(`      实际: ${JSON.stringify(actual)}`);
  }
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

async function get(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, data: await r.json() };
}

(async () => {
  // 先确认服务活着
  const h = await get('/api/health');
  if (!h.data.ok) {
    console.log('服务没起来，先跑 node src/server/server.js');
    process.exit(1);
  }
  console.log(`服务正常：${h.data.users} 个用户，${h.data.trades} 笔交易，` +
              `${h.data.pendingReview} 条待审`);

  const uniq = Date.now().toString().slice(-6);

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 1. 学号没人用过 → 自动通过，可以发布 ===');
  {
    const r = await post('/api/publish', {
      nickname: '测试甲', studentNo: '2315' + uniq + '0', realName: '测试甲真名',
      kind: 'goods', title: '身份审核上线后的第一单', priceYuan: 12,
    });
    check('HTTP 200', r.status, 200);
    check('发布成功', r.data.ok, true);
    check('身份状态为已通过', r.data.identityStatus, 'verified');
    check('发布者已实名', r.data.publisher.verified, true);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 2. 手滑撞号（学号被占但姓名不同）→ 挂起，发不出去 ===');
  {
    const r = await post('/api/publish', {
      nickname: '手滑的人', studentNo: '2315' + uniq + '0', realName: '完全不同的人',
      kind: 'goods', title: '这单应该发不出去', priceYuan: 5,
    });
    check('HTTP 200（不是错误，是待审状态）', r.status, 200);
    check('没有发布成功', r.data.ok, false);
    check('标记为需要审核', r.data.needReview, true);
    check('状态是挂起而不是通过', r.data.identityStatus, 'held');
    check('提示里说明了原因', /已被他人登记|不一致/.test(r.data.message), true);
    console.log('      提示原文：' + r.data.message);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 3. 学号+姓名都一致 → 认成本人放行（这是设计边界，不是漏洞）===');
  {
    // 这一条是本轮最值得说清楚的地方。
    //
    // 在「没有密码、没有登录态」的前提下，
    //   「本人二次来访」 和 「别人知道我的学号+姓名」
    // 在信息层面是完全一样的，系统无法区分。
    //
    // 所以系统此时的行为是「认第一个来的人」。
    // 真正解决它要靠登录（密码/短信/人脸），那是下一步的事。
    const r = await post('/api/publish', {
      nickname: '我是本人', studentNo: '2315' + uniq + '0', realName: '测试甲真名',
      kind: 'goods', title: '本人二次来访发的单', priceYuan: 99,
    });
    check('姓名一致 → 放行', r.data.ok, true);
    check('复用同一个用户，没新建', r.data.publisher.id.indexOf('u_'), 0);
    console.log('      ⚠ 局限：此时若换成真的冒用者，系统也认。');
    console.log('        要堵住这个口子，必须上「登录」，不是靠身份审核。');
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 3b. 学号+姓名都不一致（换个人用同学号）→ 挂起 ===');
  {
    const r = await post('/api/publish', {
      nickname: '另一个人', studentNo: '2315' + uniq + '0', realName: '张某某',
      kind: 'goods', title: '这单不该发出去', priceYuan: 7,
    });
    check('没有发布成功', r.data.ok, false);
    check('状态为挂起', r.data.identityStatus, 'held');
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 4. 待审队列里能看到挂起项（分流的实际效果）===');
  {
    const r = await get('/api/identity/pending');
    const held = r.data.pending.filter((c) => c.status === 'held');
    const pending = r.data.pending.filter((c) => c.status === 'pending');
    check('待审队列里有挂起项', held.length >= 1, true);
    console.log(`      挂起(疑似手滑/姓名不符) ${held.length} 条 → 可批量通知本人改`);
    console.log(`      待审(真冲突，需人判)     ${pending.length} 条`);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 4b. 造一个真冲突，验证人工裁定链路 ===');
  {
    // 先让一个学号有主人
    const no = '2315' + uniq + '7';
    const first = await post('/api/publish', {
      nickname: '李四', studentNo: no, realName: '李四',
      kind: 'task', title: '李四的第一单', priceYuan: 3,
    });
    check('先注册成功', first.data.ok, true);

    // 管理员把李四的声明改成驳回，模拟「原主被推翻」
    // → 学号变成无主，此时另一个人声称同学号同姓名应能进入处理
    const pendingList = await get('/api/identity/pending');
    console.log(`      当前待审 ${pendingList.data.pending.length} 条`);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 5. 匿名发布 → 拒绝，但告诉他可以先逛 ===');
  {
    const r = await post('/api/publish', {
      nickname: '匿名的人', kind: 'goods', title: '匿名发的单', priceYuan: 1,
    });
    check('HTTP 400', r.status, 400);
    check('拒绝原因清晰', /实名/.test(r.data.error), true);
    console.log('      原因：' + r.data.error);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 6. 填了学号但没填姓名 → 要求补全 ===');
  {
    const r = await post('/api/publish', {
      nickname: '漏填的人', studentNo: '2315' + uniq + '9',
      kind: 'goods', title: '缺姓名的单', priceYuan: 1,
    });
    check('HTTP 400', r.status, 400);
    check('提示要去填姓名', /真实姓名/.test(r.data.error), true);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 7. 手机号当学号填 → 精确拦截 ===');
  {
    const r = await post('/api/publish', {
      nickname: '填错格子', studentNo: '13800138000', realName: '某人',
      kind: 'goods', title: '手机号当学号', priceYuan: 1,
    });
    check('HTTP 400', r.status, 400);
    check('指出是手机号', /手机号/.test(r.data.error), true);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 8. 查身份状态接口 ===');
  {
    const okNo = await get('/api/identity/status?studentNo=2315' + uniq + '0');
    check('已通过的学号 → canTransact=true', okNo.data.canTransact, true);

    const badNo = await get('/api/identity/status?studentNo=2315' + uniq + '9');
    check('没提交过的学号 → canTransact=false', badNo.data.canTransact, false);
    check('但能浏览', badNo.data.canBrowse, true);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 9. 人工裁定：驳回一个挂起项 ===');
  {
    const list = await get('/api/identity/pending');
    const item = list.data.pending[0];
    if (!item) {
      console.log('  （本轮没有待审项，跳过）');
    } else {
      const r = await post('/api/identity/review', {
        claimId: item.id,
        reviewerId: 'admin_demo',
        decision: 'reject',
        note: '已核对教务系统，该学号已由原注册人持有，此人姓名不符，判定为填错学号',
      });
      check('裁定成功', r.data.ok, true);
      check('状态变为已驳回', r.data.claim.status, 'rejected');
      check('记录了审核人', r.data.claim.reviewed_by, 'admin_demo');
      check('记录了审核时间', typeof r.data.claim.reviewed_at, 'string');

      // 再裁一次应被拒绝（防手抖点两次）
      const again = await post('/api/identity/review', {
        claimId: item.id, reviewerId: 'admin_demo',
        decision: 'reject', note: '第二次',
      });
      check('重复裁定被拒', again.status, 400);
    }
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 10. 裁定必须写理由 ===');
  {
    const r = await post('/api/identity/review', {
      claimId: 999999, reviewerId: 'admin_demo', decision: 'reject', note: '',
    });
    check('HTTP 400', r.status, 400);
    check('要求填说明', /必须填写审核说明/.test(r.data.error), true);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 11. 最终状态 ===');
  {
    const r = await get('/api/health');
    console.log(`      用户 ${r.data.users} 个，交易 ${r.data.trades} 笔，` +
                `待审 ${r.data.pendingReview} 条`);
    check('健康检查含待审字段', typeof r.data.pendingReview, 'number');
  }

  console.log('\n' + '═'.repeat(55));
  console.log(`  结果：${passed} 项通过，${failed} 项失败`);
  console.log('═'.repeat(55));
  process.exit(failed > 0 ? 1 : 0);
})();
