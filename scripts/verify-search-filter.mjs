// 验证聚合层的相关度过滤与成人内容过滤（复用线上同一份实现，提取式测试）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, cond) => { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) failed++; };

// 最小沙箱：只提取过滤相关函数
const sb = { console, localStorage: { _d: { yellowFilterEnabled: 'true' }, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; } } };
sb.window = sb;
vm.createContext(sb);
let code = fs.readFileSync(path.join(ROOT, 'public/js/apiSearchHandlers.js'), 'utf8');
// 只执行过滤相关的函数定义（其余依赖浏览器环境的部分不执行）
const grab = (name) => {
  const re = new RegExp('function ' + name + '\\s*\\(');
  const m = code.match(re);
  if (!m) throw new Error('not found: ' + name);
  const i = m.index;
  let depth = 0, j = code.indexOf('{', i);
  for (; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') { depth--; if (depth === 0) break; }
  }
  return code.slice(i, j + 1);
};
const fns = [grab('normalizeSearchText'), grab('searchRelevanceScore'), grab('isAdultSearchResult'), grab('applySearchRelevanceAndFilter')].join('\n');
// 正则常量也提取（isAdultSearchResult 引用它们）
const constDecls = ['ADULT_TITLE_RE', 'ADULT_CLASS_RE'].map(name => {
  const m = code.match(new RegExp('const ' + name + '\\s*=\\s*/[\\s\\S]*?/[a-z]*;'));
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}).join('\n');
vm.runInContext(constDecls + '\n' + fns, sb);
const g = (expr) => vm.runInContext(expr, sb);

// ---- 相关度 ----
check('精确同名 = 100', g(`searchRelevanceScore('千与千寻', '千与千寻')`) === 100);
check('含全词（剧场版） = 90', g(`searchRelevanceScore('千与千寻', '千与千寻剧场版')`) === 90);
check('bfzy 单字OR垃圾「神鬼八阵图」= 0（丢弃）', g(`searchRelevanceScore('千与千寻', '神鬼八阵图')`) === 0);
check('「星际特工：千星之城」= 0（只含单字千）', g(`searchRelevanceScore('千与千寻', '星际特工：千星之城')`) === 0);
check('「十字架与吸血鬼」= 0（只含与）', g(`searchRelevanceScore('千与千寻', '十字架与吸血鬼')`) === 0);
check('「春太与千夏」= 0（只含单字千/与，真实样本）', g(`searchRelevanceScore('千与千寻', '春夏事件簿：春太与千夏的青春')`) === 0);
check('英文词包含 = 90', g(`searchRelevanceScore('interstellar', 'Interstellar (2014)')`) === 90);
check('多词查询取最好词', g(`searchRelevanceScore('千与千寻 宫崎骏', '千与千寻')`) >= 90);
// 已知限制（如实验证）：无繁简转换——繁体别名匹配不上（影响小：同片在采集站
// 通常有简体条目，精确匹配的会排前面）
check('繁体别名当前不命中（已知限制，得 0）', g(`searchRelevanceScore('千与千寻', '千與千尋')`) === 0);
check('短词「庆余年」含 = 90', g(`searchRelevanceScore('庆余年', '庆余年第二季')`) === 90);
check('「庆余年」庆字出现在别的标题不算', g(`searchRelevanceScore('庆余年', '重庆大厦')`) === 0 || g(`searchRelevanceScore('庆余年', '重庆大厦')`) === 60);

// ---- 成人过滤（查询词与标题匹配，隔离相关度变量） ----
check('分类「伦理片」拦截', g(`applySearchRelevanceAndFilter([{vod_name:'某片', vod_class:'伦理片'}], '某片').list.length`) === 0);
check('标题「麻豆」拦截', g(`applySearchRelevanceAndFilter([{vod_name:'麻豆传媒作品'}], '麻豆传媒作品').list.length`) === 0);
check('简介命中也拦截', g(`applySearchRelevanceAndFilter([{vod_name:'无辜标题', vod_content:'麻豆系列'}, {vod_name:'无辜标题'}], '无辜标题').list.length`) === 1);
check('正常标题不误伤（欲望都市）', g(`applySearchRelevanceAndFilter([{vod_name:'欲望都市', vod_class:'剧情'}], '欲望都市').list.length`) === 1);
check('正常标题不误伤（色戒）', g(`applySearchRelevanceAndFilter([{vod_name:'色，戒', vod_class:'剧情'}], '色戒').list.length`) === 1);
check('开关关闭时不过滤', (() => {
  sb.localStorage._d['yellowFilterEnabled'] = 'false';
  const r = g(`applySearchRelevanceAndFilter([{vod_name:'麻豆传媒作品', vod_class:'伦理片'}], '麻豆传媒作品').list.length`);
  sb.localStorage._d['yellowFilterEnabled'] = 'true';
  return r === 1;
})());
// 相关度组合：无关+成人一起丢
const combo = g(`JSON.stringify(applySearchRelevanceAndFilter([
  {vod_name:'千与千寻'},
  {vod_name:'神鬼八阵图'},
  {vod_name:'麻豆新作'},
  {vod_name:'千与千寻 剧场版'}
], '千与千寻').list.map(x => x.vod_name))`);
check('组合：只留千与千寻两条（精确+剧场版）', combo === JSON.stringify(['千与千寻', '千与千寻 剧场版']));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
