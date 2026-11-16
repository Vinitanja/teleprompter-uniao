const { chromium } = require('playwright'); const fs=require('fs');
const RES='/home/user/teleprompter/mobile/android/app/src/main/res', PUB='/home/user/teleprompter/public';
const svgs={}; for(const n of ['icon','icon-round','icon-maskable','fg','bg']) svgs[n]=fs.readFileSync(n+'.svg','utf8');
const defsOf=svgs.fg.match(/<defs>[\s\S]*?<\/defs>/)[0];
(async()=>{
 const b=await chromium.launch(); const p=await b.newPage();
 const shot=async(name,size,out,transparent)=>{ await p.setViewportSize({width:size,height:size});
  await p.setContent(`<body style="margin:0;background:transparent">${svgs[name].replace('<svg ',`<svg width="${size}" height="${size}" `)}</body>`);
  fs.mkdirSync(require('path').dirname(out),{recursive:true});
  await p.screenshot({path:out,omitBackground:!!transparent}); };
 const dens={mdpi:1,hdpi:1.5,xhdpi:2,xxhdpi:3,xxxhdpi:4};
 for(const [d,m] of Object.entries(dens)){
  await shot('fg',108*m,`${RES}/mipmap-${d}/ic_launcher_foreground.png`,true);
  await shot('bg',108*m,`${RES}/mipmap-${d}/ic_launcher_bg.png`);
  await shot('icon',48*m,`${RES}/mipmap-${d}/ic_launcher.png`,true);
  await shot('icon-round',48*m,`${RES}/mipmap-${d}/ic_launcher_round.png`,true);
 }
 await shot('icon',192,PUB+'/icon-192.png',true); await shot('icon',512,PUB+'/icon-512.png',true);
 await shot('icon-maskable',512,PUB+'/icon-maskable-512.png'); await shot('icon',180,PUB+'/apple-touch-icon.png');
 // splash
 const mark=svgs.fg.split('</defs>')[1].replace('</svg>','');
 for(const f of fs.readdirSync(RES).filter(d=>/^drawable/.test(d)&&fs.existsSync(`${RES}/${d}/splash.png`))){
  const buf=fs.readFileSync(`${RES}/${f}/splash.png`); const w=buf.readUInt32BE(16),h=buf.readUInt32BE(20); const s=Math.min(w,h)*0.42;
  await p.setViewportSize({width:w,height:h});
  await p.setContent(`<body style="margin:0;width:${w}px;height:${h}px;background:radial-gradient(circle at 50% 40%,#22335c,#101a33 55%,#060a14);display:grid;place-items:center"><svg width="${s}" height="${s}" viewBox="0 0 1024 1024">${defsOf}${mark}</svg></body>`);
  await p.screenshot({path:`${RES}/${f}/splash.png`});
 }
 await b.close();
})();
