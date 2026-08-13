import fs from 'node:fs';import path from 'node:path';
const root=process.cwd(),mp=path.join(root,'dist','manifest.json');
if(!fs.existsSync(mp)){console.error('FAIL manifest missing');process.exit(1)}
const m=JSON.parse(fs.readFileSync(mp,'utf8')),rr=m.declarative_net_request?.rule_resources||[];
const p=rr.filter(x=>String(x.id||'').startsWith('phase31_')),base=rr.filter(x=>!String(x.id||'').startsWith('phase31_'));
let total=0,fail=0;
for(const r of p){const f=path.join(root,'dist',r.path);if(!fs.existsSync(f)){console.error('FAIL missing',r.path);fail++;continue}const j=JSON.parse(fs.readFileSync(f,'utf8'));if(!Array.isArray(j)){fail++;continue}total+=j.length;console.log('OK',r.id,j.length)}
const css=path.join(root,'dist','phase31-generic-cosmetic.css');
if(!fs.existsSync(css)||fs.statSync(css).size<100){console.error('FAIL cosmetic CSS');fail++}
if(!base.length){console.error('FAIL original ADAPT baseline vanished');fail++}
if(total<1000){console.error('FAIL corpus still tiny',total);fail++}
if(fail)process.exit(1);
console.log(`PASS: ${total} Phase 3.1 static rules; ${base.length} original ruleset(s) preserved`);
