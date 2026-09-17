/**
 * 身份审核核心测试
 * ═══════════════════════════════════════════════════════════
 *
 * 测的不是「代码能不能跑」，是「设计有没有漏洞」。
 * 每个场景都对应一个真实会发生的状况。
 */

const { IdentityCore, CLAIM_STATUS } = require('../src/identity/identity');

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      期望: ${JSON.stringify(expected)}`);
    console.log(`      实际: ${JSON.stringify(actual)}`);
  }
}

/** 断言某个操作必须报错（防的是「本该被拒绝却成功了」）*/
function mustThrow(label, fn, expectMsgPart = null) {
  try {
    fn();
    failed++;
    console.log(`  ✗ ${label} —— 本该被拒绝，却成功了`);
  } catch (e) {
    if (expectMsgPart && !e.message.includes(expectMsgPart)) {
      failed++;
      console.log(`  ✗ ${label} —— 报错信息不符`);
      console.log(`      期望含: ${expectMsgPart}`);
      console.log(`      实际:   ${e.message}`);
    } else {
      passed++;
      console.log(`  ✓ ${label} → ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════
(async () => {
  const db = new IdentityCore(':memory:');

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 1. 正常注册：学号没人用过 ===');
  {
    const r = db.submit({
      userId: 'u_ming', nickname: '小明',
      studentNo: '2315402125', realName: '何孝彬',
    });
    check('状态为已通过', r.status, CLAIM_STATUS.VERIFIED);
    check('拿到实名标记', r.user.verified, true);
    check('可以交易', r.user.canTransact, true);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 2. 手滑撞号：学号被占，但姓名不同 ===');
  {
    const r = db.submit({
      userId: 'u_zhang', nickname: '张三',
      studentNo: '2315402125', realName: '张三',
    });
    check('不被直接拒绝，而是挂起', r.status, CLAIM_STATUS.HELD);
    check('没有实名标记（发不了单）', r.user.verified, false);
    check('但能浏览', db.getStatus('u_zhang').canBrowse, true);
    check('不能交易', db.getStatus('u_zhang').canTransact, false);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 3. 真冒用：学号被占，姓名也一模一样 ===');
  {
    const r = db.submit({
      userId: 'u_fake', nickname: '我是本人',
      studentNo: '2315402125', realName: '何孝彬',
    });
    check('进人工队列（不是挂起）', r.status, CLAIM_STATUS.PENDING);
    check('同样拿不到实名', r.user.verified, false);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 4. 手滑 vs 冒用，被分成了两类（这是分流的价值）===');
  {
    const held = db.listPending({ status: CLAIM_STATUS.HELD });
    const pending = db.listPending({ status: CLAIM_STATUS.PENDING });
    check('挂起队列 1 条（手滑）', held.length, 1);
    check('人工队列 1 条（真冲突）', pending.length, 1);
    check('营销成本从 2 条降到 1 条', pending.length < held.length + pending.length, true);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 5. 待审用户想发单，应该发不出去 ===');
  {
    // 模拟交易核心的写入尝试：trades.publisher_id 外键指向 users
    db.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        publisher_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'open'
      )
    `);
    // 待审用户在 users 里存在，但外键能过——所以要靠 verified 拦
    const st = db.getStatus('u_fake');
    check('业务层拦住：canTransact=false', st.canTransact, false);

    // 而真正已通过的人可以
    check('已通过的人 canTransact=true', db.getStatus('u_ming').canTransact, true);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 6. 人工裁定：判真冒用者败诉 ===');
  {
    const pending = db.listPending({ status: CLAIM_STATUS.PENDING })[0];
    const result = db.review({
      claimId: pending.id,
      reviewerId: 'admin_laoban',
      decision: 'reject',
      note: '已核对教务系统，何孝彬本人在 9/17 已注册过账号，此为准冒用',
    });
    check('状态变为已驳回', result.status, CLAIM_STATUS.REJECTED);
    check('记录了审核人', result.reviewed_by, 'admin_laoban');
    check('记录了审核时间', typeof result.reviewed_at, 'string');

    const u = db.getUser('u_fake');
    check('该账号仍然没有实名', u.verified, false);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 7. 裁定必须写理由（不写就无法追溯）===');
  {
    const held = db.listPending({ status: CLAIM_STATUS.HELD })[0];
    mustThrow('不写理由 → 拒绝', () => {
      db.review({ claimId: held.id, reviewerId: 'admin', decision: 'approve', note: '' });
    }, '必须填写审核说明');
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 8. 不能审自己（越权防护）===');
  {
    const held = db.listPending({ status: CLAIM_STATUS.HELD })[0];
    mustThrow('当事人审自己 → 拒绝', () => {
      db.review({
        claimId: held.id, reviewerId: held.user_id,
        decision: 'approve', note: '我自己批我自己',
      });
    }, '不能审核自己');
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 9. 学号已被人持有时，不能「批准」第二条 ===');
  {
    // 这是场景 9 崩掉之后补的一条测试。
    // 原来的写法是「批准手滑的张三」，数据库抛 constraint failed——
    // 说明设计里缺一条规则：别人占着的学号，批准动作本身不成立。
    const held = db.listPending({ status: CLAIM_STATUS.HELD })[0];
    mustThrow('批准一个已被占用的学号 → 拒绝（提示改为驳回）', () => {
      db.review({
        claimId: held.id, reviewerId: 'admin_laoban', decision: 'approve',
        note: '想直接批准，看看会不会挡住',
      });
    }, '不能批准第二条');

    // 正解是驳回
    db.review({
      claimId: held.id, reviewerId: 'admin_laoban', decision: 'reject',
      note: '张三填错了学号（填成了同学何孝彬的），已驳回并通知他重新提交',
    });
    const st = db.getStatus(held.user_id);
    check('驳回后仍不能交易', st.canTransact, false);
    check('且学号没被写进 users 表', db.getUser(held.user_id).student_no, null);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 9b. 学号无主时，批准应当成立 ===');
  {
    // 造一个「原来的主人被推翻」的场景：
    // 李四的学号声明进了人工队列，此时该学号无 verified 持有者
    const r = db.submit({
      userId: 'u_li', nickname: '李四',
      studentNo: '2315402456', realName: '李四',
    });
    check('学号无主 → 自动通过', r.status, CLAIM_STATUS.VERIFIED);

    // 另一个人声称同学号同姓名（真冲突）→ 进人工
    const r2 = db.submit({
      userId: 'u_li2', nickname: '我也是李四',
      studentNo: '2315402456', realName: '李四',
    });
    check('真冲突进人工', r2.status, CLAIM_STATUS.PENDING);

    // 审核员核对后认为后来者才是真的，需要先推翻原主
    // 这里演示「批准被拒绝」——因为学号还被人持有
    mustThrow('原主还在时批准后来者 → 拒绝', () => {
      db.review({
        claimId: r2.claim.id, reviewerId: 'admin',
        decision: 'approve', note: '想直接判后来者胜',
      });
    }, '不能批准第二条');
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 10. 关键防线：一个学号只能有一个已通过的人 ===');
  {
    // 现在 u_ming 和 u_zhang 都是 2315402125 的「已通过」声明
    // 唯一索引应该已经拦住了第二条
    const v = db.db.prepare(
      `SELECT COUNT(*) AS n FROM identity_claims
        WHERE student_no = '2315402125' AND status = 'verified'`
    ).get();

    check('已通过声明只有 1 条（唯一索引生效）', Number(v.n), 1);
    console.log(`      （实际所有声明数：${db.db.prepare(
      `SELECT COUNT(*) AS n FROM identity_claims WHERE student_no='2315402125'`
    ).get().n} 条，但只有 1 条是已通过）`);
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 11. 重复裁定要防住（两个审核员同时点）===');
  {
    const pending = db.listPending({ status: CLAIM_STATUS.PENDING });
    const first = pending[0] || null;

    if (first) {
      db.review({
        claimId: first.id, reviewerId: 'admin_a', decision: 'reject',
        note: '第一次裁定',
      });
      mustThrow('同一份声明再裁一次 → 拒绝', () => {
        db.review({
          claimId: first.id, reviewerId: 'admin_b',
          decision: 'reject', note: '第二次裁定',
        });
      }, '不允许从');
    } else {
      console.log('  （无待审项，跳过——上一场景已把队清空）');
    }
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 12. 学号格式挡掉乱填的 ===');
  {
    mustThrow('填了手机号 → 拒绝', () => {
      db.submit({ userId: 'u_x1', nickname: 'x', studentNo: '13800138000', realName: '某' });
    }, '这看起来是手机号');

    mustThrow('填太短 → 拒绝', () => {
      db.submit({ userId: 'u_x2', nickname: 'x', studentNo: '123', realName: '某' });
    }, '学号格式不对');

    mustThrow('空学号 → 拒绝', () => {
      db.submit({ userId: 'u_x3', nickname: 'x', studentNo: '', realName: '某' });
    }, '请填写学号');

    mustThrow('空姓名 → 拒绝', () => {
      db.submit({ userId: 'u_x4', nickname: 'x', studentNo: '2315402199', realName: '' });
    }, '请填写真实姓名');
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 13. 同一个用户不能挂两份待审声明 ===');
  {
    db.submit({
      userId: 'u_dup', nickname: '重複的人',
      studentNo: '2315402300', realName: '甲',
    });
    // 先去抢一个已存在的学号，制造待审/挂起
    const r = db.submit({
      userId: 'u_dup2', nickname: '重複的人2',
      studentNo: '2315402125', realName: '何孝彬',
    });
    check('第二个人进了人工队列', r.status, CLAIM_STATUS.PENDING);
    mustThrow('同一个用户再提一份 → 拒绝', () => {
      db.submit({
        userId: 'u_dup2', nickname: '重複的人2',
        studentNo: '2315402400', realName: '另一个名字',
      });
    }, '已有一份待审核');
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 14. 事件流水完整可回放 ===');
  {
    const c = db.db.prepare(
      `SELECT * FROM identity_claims WHERE status = 'rejected' LIMIT 1`
    ).get();
    const events = db.getEvents(c.id);
    check('被驳回的声明有事件记录', events.length > 0, true);
    check('含 submit 提交事件', events.some((e) => e.action === 'submit'), true);
    check('含 reject 驳回事件', events.some((e) => e.action === 'reject'), true);
    console.log('      流水：' + events.map((e) => `${e.action}(${e.actor_id})`).join(' → '));
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 15. 全库一致性自检 ===');
  {
    const a = db.audit();
    check('无自相矛盾', a.ok, true);
    if (!a.ok) a.problems.forEach((p) => console.log('      ⚠ ' + p));
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n=== 16. 自检能抓出被人为破坏的数据 ===');
  {
    // 手工把一条已通过的声明改成别的状态，制造矛盾
    db.db.exec(`
      UPDATE users SET verified = 1
       WHERE id = (SELECT user_id FROM identity_claims
                    WHERE status = 'rejected' LIMIT 1)
    `);
    const a = db.audit();
    check('抓出「标记已实名但无已通过声明」', a.ok, false);
    console.log('      发现：' + a.problems[0]);
  }

  // ═════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(55));
  console.log(`  结果：${passed} 项通过，${failed} 项失败`);
  console.log('═'.repeat(55));

  db.close();
  process.exit(failed > 0 ? 1 : 0);
})();
