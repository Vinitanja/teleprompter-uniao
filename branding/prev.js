const { chromium } = require('playwright'); const fs=require('fs');
(async()=>{ const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1024,height:1024}});
 await p.setContent('<body style="margin:0;background:transparent">'+fs.readFileSync('icon.svg','utf8').replace('<svg ','<svg width="1024" height="1024" ')+'</body>');
 await p.screenshot({path:'preview.png',omitBackground:true}); await b.close(); })();
