import fs from 'node:fs';import path from 'node:path';
const root=process.cwd(),m=JSON.parse(fs.readFileSync(path.join(root,'dist','manifest.json'),'utf8'));
const rr=m.declarative_net_request?.rule_resources||[],p=rr.filter(x=>String(x.id||'').startsWith('phase31_')),b=rr.filter(x=>!String(x.id||'').startsWith('phase31_'));
let total=0,fail=0;
for(const r of p){const f=path.join(root,'dist',r.path);if(!fs.existsSync(f)){console.error('FAIL missing',r.path);fail++;continue}const j=JSON.parse(fs.readFileSync(f,'utf8'));if(!Array.isArray(j)){fail++;continue}total+=j.length;console.log('OK',r.id,j.length)}
if(!b.some(x=>x.id==='ruleset_baseline')){console.error('FAIL baseline missing');fail++}
const css=path.join(root,'dist','phase31-generic-cosmetic.css');if(!fs.existsSync(css)||fs.statSync(css).size<100){console.error('FAIL cosmetic CSS');fail++}
if(p.length<2||total<10000){console.error('FAIL corpus too small',total);fail++}
if(fail)process.exit(1);
console.log(`PASS: ${total} Phase 3.1 rules; baseline preserved`);
