const { chromium } = require('playwright'); const fs=require('fs');
(async()=>{
 const b=await chromium.launch(); const p=await b.newPage();
 const shot=async(svg,size,out,transparent)=>{ await p.setViewportSize({width:size,height:size});
  await p.setContent(`<body style="margin:0;background:transparent">${fs.readFileSync(svg,'utf8').replace('<svg ',`<svg width="${size}" height="${size}" `)}</body>`);
  await p.screenshot({path:out,omitBackground:!!transparent,clip:{x:0,y:0,width:size,height:size}}); };
 await shot('icon.svg',1024,'preview.png',true);
 await b.close();
})();
