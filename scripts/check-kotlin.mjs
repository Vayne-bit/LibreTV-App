// Kotlin 基础校验：重复声明/括号平衡（CI 前本地/流水线都可直接跑）
import fs from 'node:fs';
const files = process.argv.slice(2);
let bad = 0;
for (const file of files) {
  const s = fs.readFileSync(file, 'utf8');
  const dups = [...s.matchAll(/(?:override )?fun (\w+)/g)].map(m => m[1]);
  const seen = new Set(); const dupList = [];
  for (const d of dups) { if (seen.has(d) && d !== 'onCreate') dupList.push(d); seen.add(d); }
  const braces = (s.match(/{/g) || []).length - (s.match(/}/g) || []).length;
  // onCreate 的重复单独查（类里出现两次即编译错误）
  const onCreateCount = (s.match(/override fun onCreate\b/g) || []).length;
  if (braces !== 0) { console.error('!! 括号不平衡', file, braces); bad++; }
  if (onCreateCount > 1) { console.error('!! onCreate 重复', file); bad++; }
  if (dupList.length) { console.error('!! 疑似重复函数', file, dupList.join(',')); bad++; }
}
console.log(bad ? 'Kotlin 校验失败' : 'Kotlin 校验通过');
process.exit(bad ? 1 : 0);
