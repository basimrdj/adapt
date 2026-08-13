import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const manifestPath = path.join(dist, 'manifest.json');
const textDir = path.join(root, '.phase31', 'text');
const compiledDir = path.join(root, '.phase31', 'compiled');
const outDir = path.join(dist, 'phase31-rulesets');
const warDir = path.join(dist, 'web-accessible-resources');
const reportPath = path.join(root, '.phase31', 'REPORT-v3.md');

function die(m){ console.error('ERROR:',m); process.exit(1); }
function walk(d,a=[]){
  if(!fs.existsSync(d)) return a;
  for(const e of fs.readdirSync(d,{withFileTypes:true})){
    const p=path.join(d,e.name);
    e.isDirectory()?walk(p,a):a.push(p);
  }
  return a;
}
function titleOf(file){
  const h=fs.readFileSync(file,'utf8').slice(0,18000);
  return (h.match(/^!\s*Title:\s*(.+)$/im)?.[1] ||
          h.match(/^!\s*Name:\s*(.+)$/im)?.[1] || '').trim();
}
function family(t){
  t=t.toLowerCase();
  if(t.startsWith('adguard base')) return 'base';
  if(t.startsWith('adguard tracking protection')) return 'tracking';
  if(t.startsWith('adguard url tracking')) return 'urltracking';
  if(t.includes('adblock warning removal')) return 'antiadblock';
  if(t.includes('popups filter')) return 'popups';
  if(t.includes('other annoyances')) return 'annoyances';
  if(t.includes('online malicious url')) return 'malicious';
  if(t.includes('peter lowe')) return 'peter';
  return '';
}
function score(f){
  return {
    base:1000, tracking:980, urltracking:950,
    antiadblock:900, popups:850, annoyances:800,
    malicious:760, peter:720
  }[f] || 0;
}
function findRuleset(id){
  const suffix=`ruleset_${id}.json`;
  return walk(compiledDir).find(p=>p.endsWith(suffix) && !p.endsWith('ruleset_0.json'));
}
function countRules(f){
  const j=JSON.parse(fs.readFileSync(f,'utf8'));
  return Array.isArray(j) ? j.length : 0;
}
function plainSelector(s){
  if(!s || s.length>700) return false;
  const bad=[
    '+js(', ':has-text(', ':matches-css', ':xpath(', ':upward(',
    ':remove(', ':remove-attr(', ':remove-class(', ':-abp-',
    ':style(', ':watch-attr(', ':contains(', '#%#', '#$#'
  ];
  return !bad.some(x=>s.includes(x));
}

if(!fs.existsSync(manifestPath)) die('dist/manifest.json missing');
if(!fs.existsSync(compiledDir)) die('compiled DNR output missing');

const candidates = walk(textDir)
  .filter(p=>/filter_(\d+)\.txt$/i.test(p))
  .map(file=>{
    const id=file.match(/filter_(\d+)\.txt$/i)[1];
    const title=titleOf(file);
    const fam=family(title);
    return {id,title,fam,score:score(fam),file};
  })
  .filter(x=>x.score)
  .sort((a,b)=>b.score-a.score);

const available=[];
for(const c of candidates){
  const rs=findRuleset(c.id);
  if(!rs) continue;
  const n=countRules(rs);
  if(n>0) available.push({...c,rs,n});
}

if(!available.some(x=>x.fam==='base')) die('Compiled AdGuard Base ruleset not found');
if(!available.some(x=>x.fam==='tracking')) die('Compiled Tracking Protection ruleset not found');

//
// Select a broad corpus while staying well under the practical single-blocker
// Chromium static pool. Chrome only guarantees 30k, but a single blocker can
// typically use much more from the shared pool. If Chrome reports quota trouble,
// we can reduce this set without recompiling.
//
const selected=[];
const seen=new Set();
let total=0;
const TARGET=150000;

for(const x of available){
  if(seen.has(x.fam)) continue;
  const critical=['base','tracking','urltracking'].includes(x.fam);
  if(!critical && total+x.n>TARGET) continue;
  selected.push(x);
  seen.add(x.fam);
  total+=x.n;
}

fs.rmSync(outDir,{recursive:true,force:true});
fs.mkdirSync(outDir,{recursive:true});

const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
m.permissions ??= [];
if(!m.permissions.includes('declarativeNetRequest')) m.permissions.push('declarativeNetRequest');
m.host_permissions ??= [];
if(!m.host_permissions.includes('<all_urls>')) m.host_permissions.push('<all_urls>');

m.declarative_net_request ??= {};
m.declarative_net_request.rule_resources ??= [];
m.declarative_net_request.rule_resources =
  m.declarative_net_request.rule_resources.filter(x=>!String(x.id||'').startsWith('phase31_'));

for(const s of selected){
  const dst=path.join(outDir,`filter_${s.id}.json`);
  fs.copyFileSync(s.rs,dst);
  m.declarative_net_request.rule_resources.push({
    id:`phase31_${s.id}`,
    enabled:true,
    path:`phase31-rulesets/filter_${s.id}.json`
  });
}

// Generic plain cosmetic CSS. Procedural/scriptlet rules are not blindly executed here.
const hide=new Set(), unhide=new Set();
for(const s of selected){
  for(const raw of fs.readFileSync(s.file,'utf8').split(/\r?\n/)){
    const line=raw.trim();
    if(!line || line.startsWith('!') || line.startsWith('[')) continue;
    if(line.startsWith('#@#')){
      const q=line.slice(3).trim();
      if(plainSelector(q)) unhide.add(q);
    }else if(line.startsWith('##')){
      const q=line.slice(2).trim();
      if(plainSelector(q)) hide.add(q);
    }
  }
}
for(const q of unhide) hide.delete(q);

const sels=[...hide], chunks=[];
for(let i=0;i<sels.length;i+=100){
  chunks.push(`:is(${sels.slice(i,i+100).join(',\n')}){display:none!important;}`);
}
fs.writeFileSync(
  path.join(dist,'phase31-generic-cosmetic.css'),
  '/* ADAPT Phase 3.1 generated generic cosmetics */\n'+chunks.join('\n')+'\n'
);

m.content_scripts ??= [];
let ce=m.content_scripts.find(x=>
  Array.isArray(x.matches) &&
  x.matches.includes('<all_urls>') &&
  (x.run_at==='document_start' || !x.run_at)
);
if(!ce){
  ce={matches:['<all_urls>'],css:[],run_at:'document_start',all_frames:true};
  m.content_scripts.push(ce);
}
ce.css ??= [];
if(!ce.css.includes('phase31-generic-cosmetic.css')) ce.css.push('phase31-generic-cosmetic.css');

// Make generated redirect resources reachable only where DNR redirects need them.
// List exact files instead of exposing extension internals broadly.
const warFiles=walk(warDir)
  .filter(f=>fs.statSync(f).isFile())
  .map(f=>path.relative(dist,f).split(path.sep).join('/'));

m.web_accessible_resources ??= [];
m.web_accessible_resources = m.web_accessible_resources.filter(x=>
  !Array.isArray(x.resources) ||
  !x.resources.some(r=>String(r).startsWith('web-accessible-resources/'))
);
if(warFiles.length){
  m.web_accessible_resources.push({
    resources:warFiles,
    matches:['<all_urls>'],
    use_dynamic_url:true
  });
}

fs.writeFileSync(manifestPath,JSON.stringify(m,null,2)+'\n');

const baseline=m.declarative_net_request.rule_resources
  .filter(x=>!String(x.id||'').startsWith('phase31_'))
  .map(x=>x.id);

const report=[
  '# ADAPT Phase 3.1 Local-Compile v3 Report','',
  `Generated: ${new Date().toISOString()}`,'',
  '## Enabled rulesets',
  ...selected.map(s=>`- ${s.title} (filter ${s.id}) — ${s.n.toLocaleString()} DNR rules`),'',
  `Total Phase 3.1 static rules: **${total.toLocaleString()}**`,
  `Generic cosmetic selectors: **${sels.length.toLocaleString()}**`,
  `WAR resources exposed: **${warFiles.length.toLocaleString()}**`,
  `Original ADAPT rulesets preserved: **${baseline.join(', ')}**`,
  '',
  '## Architecture safety',
  '- Existing Phase 3 background/content causal source was not modified.',
  '- DNR was compiled locally using AdGuard tsurlfilter.',
  '- Redirect resources were generated using AdGuard tswebextension.',
  '- Generic plain CSS cosmetics only; procedural rules are not blindly synthesized.'
].join('\n');

fs.writeFileSync(reportPath,report+'\n');

console.log('\n=== ADAPT Phase 3.1 LOCAL-COMPILE v3 APPLIED ===');
for(const s of selected) console.log(`- ${s.title}: ${s.n} rules`);
console.log('TOTAL STATIC RULES:',total);
console.log('GENERIC COSMETIC SELECTORS:',sels.length);
console.log('WAR RESOURCES:',warFiles.length);
console.log('PRESERVED BASELINE:',baseline);
console.log('REPORT:',reportPath);
