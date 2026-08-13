import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const src=path.join(root,'.phase31','text');
const dst=path.join(root,'.phase31','selected');

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
    base:1000,
    tracking:980,
    urltracking:950,
    antiadblock:900,
    popups:850,
    annoyances:800,
    malicious:760,
    peter:720
  }[f] || 0;
}

fs.rmSync(dst,{recursive:true,force:true});
fs.mkdirSync(dst,{recursive:true});

const infos=fs.readdirSync(src)
  .filter(n=>/^filter_\d+\.txt$/.test(n))
  .map(name=>{
    const file=path.join(src,name);
    const id=name.match(/^filter_(\d+)\.txt$/)[1];
    const title=titleOf(file);
    const fam=family(title);
    return {id,title,fam,score:score(fam),file};
  })
  .filter(x=>x.score)
  .sort((a,b)=>b.score-a.score);

const picked=[];
const seen=new Set();
for(const x of infos){
  if(seen.has(x.fam)) continue;
  picked.push(x);
  seen.add(x.fam);
}

for(const must of ['base','tracking']){
  if(!picked.some(x=>x.fam===must)){
    console.error(`ERROR: could not identify ${must} filter`);
    process.exit(1);
  }
}

for(const x of picked){
  fs.copyFileSync(x.file,path.join(dst,`filter_${x.id}.txt`));
}
fs.copyFileSync(path.join(src,'filters.json'),path.join(dst,'filters.json'));

fs.writeFileSync(
  path.join(root,'.phase31','selected-v4.json'),
  JSON.stringify(picked.map(({id,title,fam})=>({id,title,fam})),null,2)
);

console.log('Selected filter sources:');
for(const x of picked) console.log(`  ${x.id.padStart(3)}  ${x.fam.padEnd(12)} ${x.title}`);
