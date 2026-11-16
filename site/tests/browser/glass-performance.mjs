// Run via the in-app browser CDP on an isolated ?glassDiagnostics=1 preview.
// Counters include the wrappers' overhead; they are comparative desktop data,
// never an iPhone frame-rate or compositor-latency claim.
export async function inspectGlassQuality(cdp) {
  const response = await cdp.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
    const host = document.querySelector('[data-glass-optics]');
    const pngSize = node => {
      const raw = atob(node.getAttribute('href').split(',')[1]);
      const value = offset => raw.charCodeAt(offset) * 16777216 + (raw.charCodeAt(offset+1)<<16) + (raw.charCodeAt(offset+2)<<8) + raw.charCodeAt(offset+3);
      return [value(16),value(20)];
    };
    const lenses=[...host.querySelectorAll('.glass-optical-strip')].map(lens=>{
      const id=lens.querySelector('.glass-optical-plane').style.filter.split('#')[1]?.split('"')[0];
      return {kind:lens.dataset.glassLens,visible:getComputedStyle(lens).visibility,
        dimensions:[...document.getElementById(id)?.querySelectorAll('feImage')||[]].filter(node=>node.hasAttribute('href')).map(pngSize)};
    });
    return {dpr:devicePixelRatio, state:host?.dataset.glassState,
      dimensions:lenses.filter(lens=>lens.kind==='chrome').flatMap(lens=>lens.dimensions), lenses,
      diagnostics:host?.glassDiagnostics?.()};
  })()` });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

export async function profileGlassScrolling(cdp) {
  const response = await cdp.send("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: `(async()=>{
    const originalY=scrollY;
    const saved=Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('gsd:reading-progress:')));
    const wait=()=>new Promise(r=>requestAnimationFrame(r));
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const host=document.querySelector('[data-glass-optics]');
    let rect=0,style=0,reads=0;
    const oldRect=Element.prototype.getBoundingClientRect,oldStyle=window.getComputedStyle,oldRead=WebGL2RenderingContext.prototype.readPixels;
    const times=[];
    try {
      document.activeElement?.blur();
      window.dispatchEvent(new Event('reading-position-align'));
      scrollTo({top:1700,behavior:'instant'});await sleep(650);
      const beforeStats=host.glassDiagnostics?.();
      Element.prototype.getBoundingClientRect=function(...args){rect++;return oldRect.apply(this,args)};
      window.getComputedStyle=function(...args){style++;return oldStyle.apply(this,args)};
      WebGL2RenderingContext.prototype.readPixels=function(...args){reads++;return oldRead.apply(this,args)};
      let before=performance.now();
      for(let i=0;i<40;i++){
        window.dispatchEvent(new WheelEvent('wheel',{deltaY:i<20?4:-4}));
        scrollBy({top:i<20?4:-4,behavior:'instant'});await wait();
        const now=performance.now();times.push(now-before);before=now;
      }
      const afterStats=host.glassDiagnostics?.();
      return {frames:40,rectCalls:rect,computedStyleCalls:style,materialReadbacks:reads,
        longFrames:times.flatMap((ms,index)=>ms>50?[{index,ms}]:[]),
        intervalMedian:times.sort((a,b)=>a-b)[20],intervalP95:times[38],intervalMax:Math.max(...times),beforeStats,afterStats};
    } finally {
      Element.prototype.getBoundingClientRect=oldRect;window.getComputedStyle=oldStyle;WebGL2RenderingContext.prototype.readPixels=oldRead;
      window.dispatchEvent(new Event('reading-position-align'));scrollTo({top:originalY,behavior:'instant'});await sleep(250);
      for(const key of Object.keys(localStorage).filter(k=>k.startsWith('gsd:reading-progress:')))localStorage.removeItem(key);
      for(const [key,value]of Object.entries(saved))localStorage.setItem(key,value);
    }
  })()` });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

export async function profileFontMenu(cdp) {
  const response = await cdp.send("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression: `new Promise(resolve=>{
    const started=performance.now(), host=document.querySelector('[data-glass-optics]');
    const before=host.glassDiagnostics?.();let firstMaterial=null;
    document.querySelector('#reader-font-trigger').click();
    function frame(){
      const panel=document.querySelector('#reader-font-panel');
      const lens=document.querySelector('.glass-optical-strip[data-glass-lens=menu]');
      if(firstMaterial===null&&lens&&getComputedStyle(lens).visibility==='visible')firstMaterial=performance.now()-started;
      if(panel&&panel.getAttribute('aria-hidden')!=='true')resolve({firstMaterialMs:firstMaterial,interactiveMs:performance.now()-started,before,after:host.glassDiagnostics?.()});
      else if(performance.now()-started>3000)resolve({timeout:true,firstMaterialMs:firstMaterial,before,after:host.glassDiagnostics?.()});
      else requestAnimationFrame(frame);
    }requestAnimationFrame(frame);
  })` });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
