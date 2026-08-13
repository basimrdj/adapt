import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const dist=path.join(root,'dist');
const manifestPath=path.join(dist,'manifest.json');
const compiled=path.join(root,'.phase31','compiled');
const selected=JSON.parse(fs.readFileSync(path.join(root,'.phase31','selected-v4.json'),'utf8'));
const outDir=path.join(dist,'phase31-rulesets');
const warDir=path.join(dist,'web-accessible-resources');

function die(m){console.error('ERROR:',m);process.exit(1)}
function walk(d,a=[]){
  if(!fs.existsSync(d))return a;
  for(const e of fs.readdirSync(d,{withFileTypes:true})){
    const p=path.join(d,e.name);
    e.isDirectory()?walk(p,a):a.push(p);
  }
  return a;
}
function plainSelector(s){
  if(!s||s.length>700)return false;
  const bad=[
    '+js(',':has-text(',':matches-css',':xpath(',':upward(',
    ':remove(',':remove-attr(',':remove-class(',':-abp-',
    ':style(',':watch-attr(',':contains(','#%#','#$#'
  ];
  return !bad.some(x=>s.includes(x));
}
function resourceExists(extensionPath){
  if(!extensionPath)return true;
  const rel=String(extensionPath).replace(/^\/+/,'');
  return fs.existsSync(path.join(dist,rel));
}

if(!fs.existsSync(manifestPath))die('dist/manifest.json missing');
fs.rmSync(outDir,{recursive:true,force:true});
fs.mkdirSync(outDir,{recursive:true});

const built=[];
for(const s of selected){
  const src=path.join(compiled,`ruleset_${s.id}`,`ruleset_${s.id}.json`);
  if(!fs.existsSync(src)){
    console.warn(`SKIP ${s.title}: compiled file missing: ${src}`);
    continue;
  }

  const raw=JSON.parse(fs.readFileSync(src,'utf8'));
  if(!Array.isArray(raw))die(`${src} is not a JSON rules array`);

  let metadataRemoved=0, brokenRedirectsRemoved=0;
  const rules=[];
  for(const r of raw){
    if(r && Object.prototype.hasOwnProperty.call(r,'metadata')){
      metadataRemoved++;
      continue;
    }
    const ep=r?.action?.redirect?.extensionPath;
    if(ep && !resourceExists(ep)){
      brokenRedirectsRemoved++;
      continue;
    }
    rules.push(r);
  }

  if(!rules.length){
    console.warn(`SKIP ${s.title}: zero usable DNR rules`);
    continue;
  }

  const dst=path.join(outDir,`filter_${s.id}.json`);
  fs.writeFileSync(dst,JSON.stringify(rules));
  built.push({...s,count:rules.length,metadataRemoved,brokenRedirectsRemoved,dst});
}

for(const must of ['base','tracking']){
  if(!built.some(x=>x.fam===must))die(`critical ${must} ruleset was not built`);
}

// Keep a broad corpus, but don't blindly enable unbounded sets.
// Base/tracking/url-tracking/antiadblock are highest priority.
// Additional sets stay packaged but disabled if total crosses the target.
const TARGET_ENABLED=120000;
let enabledTotal=0;
for(const b of built){
  const critical=['base','tracking','urltracking','antiadblock'].includes(b.fam);
  if(critical || enabledTotal+b.count<=TARGET_ENABLED){
    b.enabled=true;
    enabledTotal+=b.count;
  }else{
    b.enabled=false;
  }
}

const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
m.permissions??=[];
if(!m.permissions.includes('declarativeNetRequest'))m.permissions.push('declarativeNetRequest');
m.declarative_net_request??={};
m.declarative_net_request.rule_resources??=[];
m.declarative_net_request.rule_resources=
  m.declarative_net_request.rule_resources.filter(x=>!String(x.id||'').startsWith('phase31_'));

for(const b of built){
  m.declarative_net_request.rule_resources.push({
    id:`phase31_${b.id}`,
    enabled:b.enabled,
    path:`phase31-rulesets/filter_${b.id}.json`
  });
}

// Generic plain CSS cosmetics from the same selected source corpus.
const hide=new Set(),unhide=new Set();
for(const b of built){
  const f=path.join(root,'.phase31','selected',`filter_${b.id}.txt`);
  for(const raw of fs.readFileSync(f,'utf8').split(/\r?\n/)){
    const l=raw.trim();
    if(!l||l.startsWith('!')||l.startsWith('['))continue;
    if(l.startsWith('#@#')){
      const q=l.slice(3).trim();
      if(plainSelector(q))unhide.add(q);
    }else if(l.startsWith('##')){
      const q=l.slice(2).trim();
      if(plainSelector(q))hide.add(q);
    }
  }
}
for(const q of unhide)hide.delete(q);
const sels=[...hide],chunks=[];
for(let i=0;i<sels.length;i+=100){
  chunks.push(`:is(${sels.slice(i,i+100).join(',\n')}){display:none!important;}`);
}
fs.writeFileSync(
  path.join(dist,'phase31-generic-cosmetic.css'),
  '/* ADAPT Phase 3.1 generated generic cosmetics */\n'+chunks.join('\n')+'\n'
);

m.content_scripts??=[];
let ce=m.content_scripts.find(x=>
  Array.isArray(x.matches)&&x.matches.includes('<all_urls>')&&
  (x.run_at==='document_start'||!x.run_at)
);
if(!ce){
  ce={matches:['<all_urls>'],css:[],run_at:'document_start',all_frames:true};
  m.content_scripts.push(ce);
}
ce.css??=[];
if(!ce.css.includes('phase31-generic-cosmetic.css'))ce.css.push('phase31-generic-cosmetic.css');

// Expose only generated redirect resources, with dynamic URLs to reduce static fingerprintability.
const warFiles=walk(warDir).filter(f=>fs.statSync(f).isFile())
  .map(f=>path.relative(dist,f).split(path.sep).join('/'));
m.web_accessible_resources??=[];
m.web_accessible_resources=m.web_accessible_resources.filter(x=>
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

const total=built.reduce((a,b)=>a+b.count,0);
const report=[
  '# ADAPT Phase 3.1 v4 Report','',
  `Generated: ${new Date().toISOString()}`,'',
  '## Compiled rulesets',
  ...built.map(b=>`- ${b.enabled?'ENABLED':'packaged'} — ${b.title} — ${b.count.toLocaleString()} rules — metadata stripped ${b.metadataRemoved} — broken redirects stripped ${b.brokenRedirectsRemoved}`),'',
  `Total packaged Phase 3.1 rules: **${total.toLocaleString()}**`,
  `Initially enabled Phase 3.1 rules: **${enabledTotal.toLocaleString()}**`,
  `Generic cosmetic selectors: **${sels.length.toLocaleString()}**`,
  `WAR resources: **${warFiles.length.toLocaleString()}**`,
  `Existing ADAPT rulesets preserved: **${baseline.join(', ')}**`
].join('\n');
fs.writeFileSync(path.join(root,'.phase31','REPORT-v4.md'),report+'\n');

console.log('\n=== ADAPT PHASE 3.1 v4 APPLIED ===');
for(const b of built){
  console.log(`${b.enabled?'ENABLED ':'PACKAGED'} ${b.title}: ${b.count} rules`);
}
console.log('TOTAL PACKAGED RULES:',total);
console.log('TOTAL INITIALLY ENABLED:',enabledTotal);
console.log('GENERIC COSMETIC SELECTORS:',sels.length);
console.log('WAR RESOURCES:',warFiles.length);
console.log('PRESERVED BASELINE:',baseline);
