// Render the filled deck to one PDF and a contact sheet, one 1920x1080 page per slide.
// Render the filled deck to one PDF: scripts/render_slides.cjs <web dir> <filled deck> <out.pdf>
const {chromium}=require(process.argv[2]+'/node_modules/playwright');const fs=require('fs'),path=require('path');
(async()=>{const root=process.argv[3],out=process.argv[4];const deck=JSON.parse(fs.readFileSync(path.join(root,'deck.json')));
const css=`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
@page{size:1920px 1080px;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}
section{width:1920px;height:1080px;overflow:hidden;page-break-after:always;break-after:page;position:relative}aside{display:none}
table{border-collapse:collapse;width:100%}th,td{padding:14px 16px;border-bottom:1px solid rgba(128,128,128,.35);vertical-align:top}th{font-weight:600}
h1,h2,h3,p,ul,ol{margin:0}li{margin:0 0 .4em 0}`;
const svg='data:image/svg+xml;base64,'+fs.readFileSync(process.argv[2]+'/../docs/architecture.svg').toString('base64');
const body=deck.order.map(id=>fs.readFileSync(path.join(root,'slides',id+'.html'),'utf8')).join('\n').replace(/src="\/_blob\/[^"]+"/g,`src="${svg}"`);
const html=`<!doctype html><meta charset=utf-8><style>${css}</style>${body}`;
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1920,height:1080}});await p.setContent(html,{waitUntil:'networkidle'});await p.evaluate(()=>document.fonts.ready);
await p.pdf({path:out,width:'1920px',height:'1080px',printBackground:true,preferCSSPageSize:true});
const over=await p.evaluate(()=>[...document.querySelectorAll('section')].map(s=>[s.id,s.scrollHeight,s.scrollWidth]).filter(x=>x[1]>1080||x[2]>1920));console.log('overflow',JSON.stringify(over));
if(process.argv[5]){await p.setViewportSize({width:1920,height:1080*deck.order.length});for(const [i,id] of deck.order.entries()){const s=await p.$('#'+id);if(s)await s.screenshot({path:process.argv[5]+'-'+String(i).padStart(2,'0')+'.png'})}}
await b.close()})().catch(e=>{console.error(e);process.exit(1)});
