import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root=process.cwd(), dist=path.join(root,'dist');
const manifestPath=path.join(dist,'manifest.json');
const work=path.join(root,'.phase31');
const dnr=path.join(work,'dnr');
const text=path.join(work,'text');
const bin=path.join(root,'node_modules','.bin',process.platform==='win32'?'dnr-rulesets.cmd':'dnr-rulesets');

function die(s){console.error('ERROR:',s);process.exit(1)}
function run(args){console.log('$ dnr-rulesets',...args);const r=spawnSync(bin,args,{stdio:'inherit'});if(r.status!==0)die('dnr-rulesets failed')}
function walk(d,a=[]){if(!fs.existsSync(d))return a;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?walk(p,a):a.push(p)}return a}
function titleOf(f){const h=fs.readFileSync(f,'utf8').slice(0,12000);return (h.match(/^!\s*Title:\s*(.+)$/im)?.[1]||h.match(/^!\s*Name:\s*(.+)$/im)?.[1]||'').trim()}
function family(t){t=t.toLowerCase();if(t.startsWith('adguard base'))return'base';if(t.startsWith('adguard tracking protection'))return'tracking';if(t.startsWith('adguard url tracking'))return'urltracking';if(t.startsWith('easylist'))return'easylist';if(t.startsWith('easyprivacy'))return'easyprivacy';if(t.includes('peter lowe'))return'peter';if(t.includes('malicious url'))return'malicious';if(t.includes('adblock warning'))return'antiadblock';if(t.includes('annoyances'))return'annoyances';if(t.includes('popups'))return'popups';return''}
function score(f){return {base:1000,tracking:980,urltracking:950,easylist:900,easyprivacy:890,peter:850,malicious:820,antiadblock:760,annoyances:700,popups:680}[f]||0}
function rsFor(id){return walk(dnr).find(p=>p.endsWith(`ruleset_${id}.json`)&&p.includes(`${path.sep}declarative${path.sep}`))}
function count(p){try{const j=JSON.parse(fs.readFileSync(p,'utf8'));return Array.isArray(j)?j.length:0}catch{return 0}}
function plainSelector(s){return s&&s.length<600&&!/[+](js\()|:has-text\(|:matches-css|:xpath\(|:upward\(|:remove\(|:remove-attr\(|:remove-class\(|:-abp-|:style\(|:watch-attr\(/.test(s)}

if(!fs.existsSync(manifestPath))die('dist/manifest.json missing; normal build must succeed first')
if(!fs.existsSync(bin))die('@adguard/dnr-rulesets CLI missing')

fs.rmSync(dnr,{recursive:true,force:true});fs.rmSync(text,{recursive:true,force:true});
fs.mkdirSync(dnr,{recursive:true});fs.mkdirSync(text,{recursive:true});
run(['load',dnr,'--browser','chromium-mv3']);
run(['load',text,'--browser','chromium-mv3','--latest-filters']);

const infos=walk(text).filter(p=>/filter_(\d+)\.txt$/i.test(p)).map(file=>{
  const id=file.match(/filter_(\d+)\.txt$/i)[1], title=titleOf(file), fam=family(title);
  return {id,title,fam,score:score(fam),file};
}).filter(x=>x.score).sort((a,b)=>b.score-a.score);

const selected=[], seen=new Set(); let total=0;
const CAP=180000;
for(const x of infos){
  const rp=rsFor(x.id); if(!rp)continue;
  const n=count(rp); if(!n||seen.has(x.fam))continue;
  if(x.fam==='easylist'&&seen.has('base'))continue;
  if(x.fam==='easyprivacy'&&seen.has('tracking'))continue;
  if(total+n>CAP&&!['base','tracking','urltracking'].includes(x.fam))continue;
  selected.push({...x,rp,n});seen.add(x.fam);total+=n;
}
if(!selected.length)die('No maintained rulesets discovered');

const outDir=path.join(dist,'phase31-rulesets');
fs.rmSync(outDir,{recursive:true,force:true});fs.mkdirSync(outDir,{recursive:true});
const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
m.permissions??=[];if(!m.permissions.includes('declarativeNetRequest'))m.permissions.push('declarativeNetRequest');
m.declarative_net_request??={};m.declarative_net_request.rule_resources??=[];
m.declarative_net_request.rule_resources=m.declarative_net_request.rule_resources.filter(x=>!String(x.id||'').startsWith('phase31_'));

for(const x of selected){
  const name=`filter_${x.id}.json`;
  fs.copyFileSync(x.rp,path.join(outDir,name));
  m.declarative_net_request.rule_resources.push({id:`phase31_${x.id}`,enabled:true,path:`phase31-rulesets/${name}`});
}

// Safe generic cosmetic layer only; site-specific/procedural/scriptlet behavior stays with ADAPT's verified causal layer.
const hide=new Set(),unhide=new Set();
for(const x of selected){
  for(const raw of fs.readFileSync(x.file,'utf8').split(/\r?\n/)){
    const l=raw.trim();if(!l||l.startsWith('!')||l.startsWith('['))continue;
    if(l.startsWith('#@#')){const s=l.slice(3).trim();if(plainSelector(s))unhide.add(s)}
    else if(l.startsWith('##')){const s=l.slice(2).trim();if(plainSelector(s))hide.add(s)}
  }
}
for(const s of unhide)hide.delete(s);
const sels=[...hide], css=[];
for(let i=0;i<sels.length;i+=120)css.push(`:is(${sels.slice(i,i+120).join(',\n')}){display:none!important;}`);
fs.writeFileSync(path.join(dist,'phase31-generic-cosmetic.css'),'/* ADAPT Phase 3.1 generated */\n'+css.join('\n')+'\n');

m.content_scripts??=[];
let ce=m.content_scripts.find(x=>Array.isArray(x.matches)&&x.matches.includes('<all_urls>')&&(x.run_at==='document_start'||!x.run_at));
if(!ce){ce={matches:['<all_urls>'],css:[],run_at:'document_start',all_frames:true};m.content_scripts.push(ce)}
ce.css??=[];if(!ce.css.includes('phase31-generic-cosmetic.css'))ce.css.push('phase31-generic-cosmetic.css');
fs.writeFileSync(manifestPath,JSON.stringify(m,null,2)+'\n');

const report=[
'# ADAPT Phase 3.1 Production Blocking Report','',
`Generated: ${new Date().toISOString()}`,'',
'## Enabled maintained rulesets',
...selected.map(x=>`- ${x.title} — ${x.n.toLocaleString()} rules`),'',
`Total added static rules: **${total.toLocaleString()}**`,
`Generic cosmetic selectors: **${sels.length.toLocaleString()}**`,
'Phase 3 causal core modified: **NO**',
'Original baseline ruleset preserved: **YES**'
].join('\n');
fs.writeFileSync(path.join(work,'REPORT.md'),report+'\n');

console.log('\n=== Phase 3.1 applied ===');
for(const x of selected)console.log(`- ${x.title}: ${x.n} rules`);
console.log('Total static rules added:',total);
console.log('Generic cosmetic selectors:',sels.length);
