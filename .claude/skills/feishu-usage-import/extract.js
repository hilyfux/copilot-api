// 在已打开飞书表格的页面里执行（Playwright browser_evaluate 的 function 参数，原样粘贴整段）。
// 返回 JSON 字符串：[{ month, name, input, output, cc, cr, cost, note }]，覆盖表里所有月份。
// 原理：调用飞书页面自己用的 clientvars 接口（带登录 cookie），data.table 是 base64 gzip，解开得到 fieldMap / recordMap。
// 「姓名」列是公式读不到，人名取「人员」字段的 users[].name；「月份」是单选，要按选项 id 映射回名字。
async () => {
  const url = '/space/api/v1/bitable/GB8wbaHyAa2QFdsULCvciofXnPb/clientvars?tableID=tblfUk9xYbZ3uuf9&viewID=vewQx1y7JR&record=&recordLimit=1000&ondemandLimit=1000&needBase=true&viewLazyLoad=true&ondemandVer=2&openType=0&noMissCS=true&optimizationFlag=1&removeFmlExtra=true';
  const j = await (await fetch(url, { credentials: 'include' })).json();
  const d = j.data || j;
  const bin = atob(d.table); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const t = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  const fm = t.fieldMap;
  const id = {}; for (const [k, f] of Object.entries(fm)) id[f.name] = k;
  const opts = (name) => { const o = {}; for (const x of ((fm[id[name]] || {}).property || {}).options || []) o[x.id] = x.name; return o; };
  const monthOpts = opts('月份');
  const raw = (cell) => (cell == null ? null : (cell.value !== undefined ? cell.value : cell));
  const num = (cell) => { const v = raw(cell); const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : 0; };
  const text = (cell) => { const v = raw(cell); return Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? (x.text ?? '') : x)).join('') : (v ?? ''); };
  const out = [];
  for (const r of Object.values(t.recordMap)) {
    const p = raw(r[id['人员']]);
    const users = p && p.users ? p.users : (Array.isArray(p) ? p : []);
    const m = raw(r[id['月份']]);
    out.push({
      month: monthOpts[m] || m,
      name: users.map((u) => u.name).filter(Boolean).join(','),
      input: num(r[id['Input Tokens']]), output: num(r[id['Output Tokens']]),
      cc: num(r[id['Cache Create']]), cr: num(r[id['Cache Read']]),
      cost: num(r[id['费用(元)']]), note: text(r[id['备注']]),
    });
  }
  return JSON.stringify(out);
}
