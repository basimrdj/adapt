import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const dist=path.join(root,'dist');
const manifestPath=path.join(dist,'manifest.json');
const textDir=path.join(root,'.phase31','text');
const outDir=path.join(dist,'phase31-rulesets');
const reportPath=path.join(root,'.phase31','REPORT-v2.md');

const die=(m)=>{console.error('ERROR:',m);process.exit(1)};
function walk(d,a=[]){if(!fs.existsSync(d))return a;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?walk(p,a):a.push(p)}return a}
function titleOf(f){const h=fs.readFileSync(f,'utf8').slice(0,16000);return (h.match(/^!\s*Title:\s*(.+)$/im)?.[1]||h.match(/^!\s*Name:\s*(.+)$/im)?.[1]||'').trim()}
function family(t){t=t.toLowerCase();if(t.startsWith('adguard base'))return'base';if(t.startsWith('adguard tracking protection'))return'tracking';if(t.startsWith('adguard url tracking'))return'urltracking';if(t.includes('adblock warning removal'))return'antiadblock';if(t.includes('popups filter'))return'popups';if(t.includes('online malicious url'))return'malicious';if(t.includes('other annoyances'))return'annoyances';if(t.includes('peter lowe'))return'peter';return''}
function score(f){return {base:1000,tracking:980,urltracking:950,antiadblock:900,popups:850,malicious:800,peter:760,annoyances:700}[f]||0}
function plainSelector(s){if(!s||s.length>700)return false;const bad=['+js(',':has-text(',':matches-css',':xpath(',':upward(',':remove(',':remove-attr(',':remove-class(',':-abp-',':style(',':watch-attr(',':contains('];return !bad.some(x=>s.includes(x))}
async function fetchJson(url){const r=await fetch(url,{redirect:'follow'});if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);const j=JSON.parse(await r.text());if(!Array.isArray(j))throw new Error('not array');return j}

if(!fs.existsSync(manifestPath))die('dist/manifest.json missing');

let installedVersion='latest';
try{installedVersion=JSON.parse(fs.readFileSync(path.join(root,'node_modules','@adguard','dnr-rulesets','package.json'),'utf8')).version||'latest'}catch{}
const fallback='4.1.20260411090042';

const candidates=walk(textDir).filter(p=>/filter_(\d+)\.txt$/i.test(p)).map(file=>{
  const id=file.match(/filter_(\d+)\.txt$/i)[1],title=titleOf(file),fam=family(title);
  return {id,title,fam,score:score(fam),file}
}).filter(x=>x.score).sort((a,b)=>b.score-a.score);

if(!candidates.length)die('No core filters identified');

fs.rmSync(outDir,{recursive:true,force:true});fs.mkdirSync(outDir,{recursive:true});
const selected=[],seen=new Set();let total=0;const TARGET=120000;

for(const c of candidates){
  if(seen.has(c.fam))continue;
  let rules=null,sourceVersion=null,lastErr=null;
  for(const ver of [installedVersion,'latest',fallback]){
    try{
      const u=`https://cdn.jsdelivr.net/npm/@adguard/dnr-rulesets@${ver}/filters/chromium-mv3/declarative/ruleset_${c.id}/ruleset_${c.id}.json`;
      rules=await fetchJson(u);sourceVersion=ver;break;
    }catch(e){lastErr=e}
  }
  if(!rules){console.warn(`SKIP ${c.title}: ${lastErr?.message||'download failed'}`);continue}

  const before=rules.length;
  rules=rules.filter(r=>r?.action?.type!=='redirect');
  const strippedRedirects=before-rules.length;

  if(total+rules.length>TARGET&&!['base','tracking','urltracking'].includes(c.fam))continue;
  fs.writeFileSync(path.join(outDir,`filter_${c.id}.json`),JSON.stringify(rules));
  selected.push({...c,count:rules.length,strippedRedirects,sourceVersion});
  total+=rules.length;seen.add(c.fam);
}

for(const need of ['base','tracking'])if(!selected.some(x=>x.fam===need))die(`Critical '${need}' ruleset unavailable`);

const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
m.permissions??=[];if(!m.permissions.includes('declarativeNetRequest'))m.permissions.push('declarativeNetRequest');
m.host_permissions??=[];if(!m.host_permissions.includes('<all_urls>'))m.host_permissions.push('<all_urls>');
m.declarative_net_request??={};m.declarative_net_request.rule_resources??=[];
m.declarative_net_request.rule_resources=m.declarative_net_request.rule_resources.filter(x=>!String(x.id||'').startsWith('phase31_'));
for(const s of selected)m.declarative_net_request.rule_resources.push({id:`phase31_${s.id}`,enabled:true,path:`phase31-rulesets/filter_${s.id}.json`});

const hide=new Set(),unhide=new Set();
for(const s of selected){
  for(const raw of fs.readFileSync(s.file,'utf8').split(/\r?\n/)){
    const l=raw.trim();if(!l||l.startsWith('!')||l.startsWith('['))continue;
    if(l.startsWith('#@#')){const q=l.slice(3).trim();if(plainSelector(q))unhide.add(q)}
    else if(l.startsWith('##')){const q=l.slice(2).trim();if(plainSelector(q))hide.add(q)}
  }
}
for(const q of unhide)hide.delete(q);
const sels=[...hide],chunks=[];
for(let i=0;i<sels.length;i+=100)chunks.push(`:is(${sels.slice(i,i+100).join(',\n')}){display:none!important;}`);
fs.writeFileSync(path.join(dist,'phase31-generic-cosmetic.css'),'/* ADAPT Phase 3.1 generated */\n'+chunks.join('\n')+'\n');

m.content_scripts??=[];
let ce=m.content_scripts.find(x=>Array.isArray(x.matches)&&x.matches.includes('<all_urls>')&&(x.run_at==='document_start'||!x.run_at));
if(!ce){ce={matches:['<all_urls>'],css:[],run_at:'document_start',all_frames:true};m.content_scripts.push(ce)}
ce.css??=[];if(!ce.css.includes('phase31-generic-cosmetic.css'))ce.css.push('phase31-generic-cosmetic.css');

fs.writeFileSync(manifestPath,JSON.stringify(m,null,2)+'\n');
const baseline=m.declarative_net_request.rule_resources.filter(x=>!String(x.id||'').startsWith('phase31_'));
fs.writeFileSync(reportPath,[
'# ADAPT Phase 3.1 Repair v2 Report','',
`Generated: ${new Date().toISOString()}`,'',
'## Added rulesets',
...selected.map(s=>`- ${s.title} — ${s.count.toLocaleString()} rules — source ${s.sourceVersion} — stripped redirects ${s.strippedRedirects}`),'',
`Total static network rules: **${total.toLocaleString()}**`,
`Generic cosmetic selectors: **${sels.length.toLocaleString()}**`,
`Original ADAPT rulesets preserved: **${baseline.map(x=>x.id).join(', ')}**`
].join('\n')+'\n');

console.log('\n=== Phase 3.1 Repair v2 applied ===');
for(const s of selected)console.log(`- ${s.title}: ${s.count} rules (${s.sourceVersion})`);
console.log('TOTAL STATIC NETWORK RULES:',total);
console.log('GENERIC COSMETIC SELECTORS:',sels.length);
console.log('PRESERVED:',baseline.map(x=>x.id));
