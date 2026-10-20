#!/usr/bin/env python3
"""
把飞书「产品研发中心 Token 用量统计」某个月的独立 Anthropic 订阅用量补录进 lan 数据库。
格式与 2026-08 / 2026-09 两次完全一致（见 SKILL.md）。

用法：
  python3 import.py --input feishu.json --month 2026-10            # 预演：打印对照表 + 生成 SQL，不写库
  python3 import.py --input feishu.json --month 2026-10 --apply    # 备份 → 写入（单事务）→ 校验
可选：--include 姓名（把默认不补的人也补上）、--exclude 姓名（这次不补某人）、--allow-zero（允许某列为 0）。

只读 / 只写 lan（ssh 别名 lan-server，MySQL 容器 mysql-v8_ai-coding-platform-relay）；密码在主机上从容器环境变量读，不经过本机。
"""
import argparse, calendar, json, random, subprocess, sys, tempfile, os

SSH = 'lan-server'
CONTAINER = 'mysql-v8_ai-coding-platform-relay'
# 飞书写法 → lan 显示名
ALIASES = {'杨东奇': '杨东齐', '徐新望': '徐新旺', '徐炜淦': '徐伟淦'}
# 2026-08 operator 的取舍：这几位飞书量 ≈ / < lan 实测，用量本来就走我们系统，不算独立订阅 → 默认不补
DEFAULT_EXCLUDE = {'徐新旺', '徐伟淦', '陈聪', '陈超'}
FALLBACK_TOK_PER_REQ = 63311  # 全站每请求 token 中位数（2026-07 实测）


def mysql(sql: str) -> list[list[str]]:
    cmd = ['ssh', SSH, f"docker exec -i {CONTAINER} sh -c 'mysql -uroot -p\"$MYSQL_ROOT_PASSWORD\" -N -B --default-character-set=utf8mb4 agent_gateway' 2>/dev/null"]
    out = subprocess.run(cmd, input=sql, capture_output=True, text=True, check=True).stdout
    return [line.split('\t') for line in out.splitlines() if line.strip()]


def q(s: str) -> str:
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='extract.js 返回的 JSON 存成的文件')
    ap.add_argument('--month', required=True, help='YYYY-MM')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--include', nargs='*', default=[])
    ap.add_argument('--exclude', nargs='*', default=[])
    ap.add_argument('--allow-zero', action='store_true')
    a = ap.parse_args()

    y, m = map(int, a.month.split('-'))
    last = f'{y:04d}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}'
    first = f'{y:04d}-{m:02d}-01'
    mon = calendar.month_abbr[m].lower()  # aug / sep / oct …
    prefix = f'manual-{mon}{y}-'

    data = json.load(open(a.input))
    if isinstance(data, str):
        data = json.loads(data)
    rows = [r for r in data if r.get('month') == a.month]
    if not rows:
        print(f'飞书里没有 {a.month} 的记录。表里有的月份：{sorted({r.get("month") for r in data})}')
        return 2

    # 合并同一人的多条
    merged: dict[str, dict] = {}
    for r in rows:
        name = ALIASES.get(r['name'], r['name'])
        if not name:
            print('有一条记录没有填「人员」，请先在飞书补上：', r)
            return 2
        g = merged.setdefault(name, {'input': 0, 'output': 0, 'cc': 0, 'cr': 0, 'cost': 0.0, 'n': 0})
        for k in ('input', 'output', 'cc', 'cr'):
            g[k] += int(r[k] or 0)
        g['cost'] += float(r['cost'] or 0)
        g['n'] += 1

    # 已导入过？
    done = mysql(f"SELECT COUNT(*) FROM usage_events WHERE request_id LIKE {q(prefix + '%')};\n"
                 f"SELECT COUNT(*) FROM usage_daily WHERE provider_type='anthropic' AND date_key={q(last)};")
    if int(done[0][0]) or int(done[1][0]):
        print(f'{a.month} 已经导入过（计费记录 {done[0][0]} 条、anthropic 每日用量 {done[1][0]} 行），拒绝重复写入。')
        return 3

    names = ','.join(q(n) for n in merged)
    users = {r[1]: (r[0], r[2]) for r in mysql(f'SELECT id, display_name, email FROM users WHERE display_name IN ({names});')}
    missing = [n for n in merged if n not in users]
    if missing:
        print('lan 里找不到这些人（可能是飞书写法不同，补进 ALIASES 后重跑）：', missing)
        return 2
    ids = ','.join(q(users[n][0]) for n in merged)
    # 每请求 token：优先用此人最近一次补录行，其次用他自己 lan 实测，最后用全站中位数
    last_supp = {r[0]: float(r[1]) for r in mysql(
        f"SELECT d.user_id, (d.input_tokens+d.output_tokens+d.cache_creation_tokens+d.cache_read_tokens)/d.request_count FROM usage_daily d "
        f"JOIN (SELECT user_id, MAX(date_key) dk FROM usage_daily WHERE provider_type='anthropic' AND date_key < {q(first)} AND request_count > 0 GROUP BY user_id) x "
        f"ON x.user_id=d.user_id AND x.dk=d.date_key WHERE d.provider_type='anthropic' AND d.user_id IN ({ids});")}
    lan = {r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in mysql(
        f"SELECT user_id, SUM(request_count), SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens) FROM usage_daily "
        f"WHERE provider_type<>'anthropic' AND date_key BETWEEN {q(first)} AND {q(last)} AND user_id IN ({ids}) GROUP BY user_id;")}

    random.seed(int(f'{y}{m:02d}'))
    include, exclude = set(a.include), set(a.exclude)
    plan, skipped, zero_problems = [], [], []
    for name, g in sorted(merged.items(), key=lambda kv: -(kv[1]['input'] + kv[1]['output'] + kv[1]['cc'] + kv[1]['cr'])):
        uid, email = users[name]
        total = g['input'] + g['output'] + g['cc'] + g['cr']
        lan_req, lan_tok = lan.get(uid, (0, 0))
        ratio = f'{total / lan_tok:.2f}×' if lan_tok else '—'
        if (name in DEFAULT_EXCLUDE and name not in include) or name in exclude:
            skipped.append((name, total, lan_tok, ratio))
            continue
        zeros = [k for k in ('input', 'output', 'cc', 'cr') if g[k] == 0]
        if zeros:
            zero_problems.append((name, zeros))
        tpr = last_supp.get(uid) or (lan_tok / lan_req if lan_req else 0) or FALLBACK_TOK_PER_REQ
        req = max(1, round(total / tpr * random.uniform(0.9, 1.1)))
        plan.append({'name': name, 'uid': uid, 'local': email.split('@')[0], 'req': req, 'total': total, 'lan_tok': lan_tok, 'ratio': ratio, **g})

    print(f'\n{a.month} 补录预演（日期 {last}，计费编号 {prefix}<邮箱前缀>）')
    print(f"{'姓名':<6}{'飞书条数':>6}{'请求数(推算)':>12}{'总tokens':>16}{'lan同月实测':>16}{'飞书/lan':>9}{'费用':>11}")
    for p in plan:
        print(f"{p['name']:<6}{p['n']:>6}{p['req']:>12,}{p['total']:>16,}{p['lan_tok']:>16,}{p['ratio']:>9}{p['cost']:>11,.2f}")
    print(f"合计 {len(plan)} 人，费用 {sum(p['cost'] for p in plan):,.2f}")
    for s in skipped:
        print(f'不补：{s[0]}（飞书 {s[1]:,} / lan 实测 {s[2]:,} = {s[3]}；默认排除名单或 --exclude）')
    for name, z in zero_problems:
        print(f'⚠ {name} 这几列是 0：{z}（7 月 operator：「不能有 0」）——确认无误加 --allow-zero，否则先去飞书补数')

    sql = ['START TRANSACTION;']
    for p in plan:
        sql.append(f"INSERT INTO usage_daily (user_id, provider_type, date_key, request_count, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, reasoning_tokens) "
                   f"VALUES ({q(p['uid'])},'anthropic',{q(last)},{p['req']},{p['input']},{p['cr']},{p['cc']},{p['output']},0);")
        sql.append(f"INSERT INTO usage_events (request_id, occurred_at, key_hash, user_id, provider_type, model, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, reasoning_tokens, charge_micros, charged_at, status_code) "
                   f"VALUES ({q(prefix + p['local'])},{q(last + ' 23:59:59.000')},{q(f'manual-backfill-{y:04d}-{m:02d}')},{q(p['uid'])},'anthropic','manual-monthly-backfill',0,0,0,0,0,{round(p['cost'] * 1_000_000)},NOW(3),200);")
    sql.append('COMMIT;')
    sql_text = '\n'.join(sql) + '\n'
    path = os.path.join(tempfile.gettempdir(), f'feishu-import-{a.month}.sql')
    open(path, 'w').write(sql_text)
    print(f'\nSQL 已生成：{path}（{len(plan) * 2} 条 INSERT）')

    if not a.apply:
        print('预演结束，没有写库。确认无误后加 --apply。')
        return 0
    if zero_problems and not a.allow_zero:
        print('有为 0 的列，未写库（加 --allow-zero 才写）。')
        return 4

    backup = f'/root/pricing-backup/usage_daily-{y:04d}{m:02d}-before-import.sql'
    subprocess.run(['ssh', SSH, f"mkdir -p /root/pricing-backup && docker exec {CONTAINER} sh -c 'mysqldump -uroot -p\"$MYSQL_ROOT_PASSWORD\" --single-transaction --where=\"date_key BETWEEN {q(first)} AND {q(last)}\" agent_gateway usage_daily' 2>/dev/null > {backup}"], check=True)
    print(f'已备份：lan:{backup}')
    mysql(sql_text)
    check = mysql(f"SELECT COUNT(*), ROUND(SUM(charge_micros)/1e6,2), SUM(charged_at IS NULL) FROM usage_events WHERE request_id LIKE {q(prefix + '%')};\n"
                  f"SELECT COUNT(*), SUM(input_tokens=0 OR output_tokens=0 OR cache_creation_tokens=0 OR cache_read_tokens=0 OR request_count=0) FROM usage_daily WHERE provider_type='anthropic' AND date_key={q(last)};")
    n_ev, usd, unpaid = check[0]
    n_day, zero_rows = check[1]
    ok = int(n_ev) == len(plan) and int(n_day) == len(plan) and int(unpaid) == 0
    print(f'校验：计费记录 {n_ev} 条 / 合计 {usd} / 未结算 {unpaid}；每日用量 {n_day} 行 / 含 0 的行 {zero_rows} → {"通过" if ok else "不通过，请检查"}')
    print(f"撤销：DELETE FROM usage_events WHERE request_id LIKE '{prefix}%'; DELETE FROM usage_daily WHERE provider_type='anthropic' AND date_key='{last}';")
    return 0 if ok else 5


if __name__ == '__main__':
    sys.exit(main())
