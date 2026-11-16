// Use the CUA tab CDP capability. Each cold sample needs a new document with
// ?glassDiagnostics=1&glassCold=1; browser/network/GPU-process caches are retained.
export async function waitGlassHydrated(cdp) {
  const response = await cdp.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true,
    expression: `new Promise(resolve=>{const start=performance.now();function check(){
      const trigger=document.querySelector('#reader-font-trigger'), root=document.querySelector('[data-glass-optics]');
      if(trigger?.hasAttribute('data-chrome-motion')&&root?.glassDiagnostics)resolve({cold:root.glassDiagnostics().timeline.cold,
        predictor:!!document.querySelector('[data-glass-menu-prewarm]'),time:performance.now()});
      else if(performance.now()-start>5000)resolve({timeout:true});else requestAnimationFrame(check);
    }check()})` });
  if(response.exceptionDetails)throw new Error(JSON.stringify(response.exceptionDetails));
  if(response.result.value.timeout)throw new Error('Reader did not hydrate');
  return response.result.value;
}

export async function runGlassMenuTrial(cdp, pressMs=50, kind="font") {
  if (kind !== "font" && kind !== "more") throw new Error("Unknown reader menu");
  const triggerId=kind === "font" ? "reader-font-trigger" : "header-menu-trigger";
  const panelId=kind === "font" ? "reader-font-panel" : "main-nav";
  const read=async expression=>{
    const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;
  };
  const box=await read(`(()=>{
    const button=document.querySelector('#${triggerId}'),root=document.querySelector('[data-glass-optics]');
    if(button.getAttribute('aria-expanded')==='true')throw new Error('Trial requires a closed menu');
    const before=root.glassDiagnostics(),rect=button.getBoundingClientRect();
    window.__glassMenuTrial={before,url:location.href,title:document.title,origin:performance.timeOrigin,
      pointerDownAt:null,clickedAt:null,firstMaterialMs:null,firstContentMs:null,frames:[],done:false};
    const trial=window.__glassMenuTrial;
    button.addEventListener('pointerdown',()=>trial.pointerDownAt=performance.now(),{once:true,capture:true});
    button.addEventListener('click',()=>{
      trial.clickedAt=performance.now();let previous=trial.clickedAt;
      function sample(now){
        const elapsed=now-trial.clickedAt;trial.frames.push({at:now,dt:now-previous});previous=now;
        const panel=document.querySelector('#${panelId}'),lens=document.querySelector('[data-glass-lens=menu]');
        if(trial.firstMaterialMs===null&&lens&&getComputedStyle(lens).visibility==='visible'&&parseFloat(getComputedStyle(lens).opacity)>.01)trial.firstMaterialMs=elapsed;
        if(trial.firstContentMs===null&&panel&&parseFloat(panel.style.getPropertyValue('--lg-morph'))>.01)trial.firstContentMs=elapsed;
        if(panel&&panel.getAttribute('aria-hidden')!=='true'){
          trial.interactiveMs=elapsed;trial.after=root.glassDiagnostics();trial.endUrl=location.href;
          trial.identityChanged=trial.url!==location.href||trial.title!==document.title;trial.done=true;
        }else if(elapsed>6000){trial.timeout=true;trial.after=root.glassDiagnostics();trial.done=true}
        else requestAnimationFrame(sample);
      }requestAnimationFrame(sample);
    },{once:true,capture:true});
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x,y:box.y});
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',buttons:1,clickCount:1});
  await new Promise(resolve=>setTimeout(resolve,pressMs));
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',buttons:0,clickCount:1});
  return read(`new Promise(resolve=>{const start=performance.now();function check(){
    const trial=window.__glassMenuTrial;
    if(trial?.done){delete window.__glassMenuTrial;resolve(trial)}
    else if(performance.now()-start>7000)resolve({timeout:true,clicked:trial?.clickedAt});else requestAnimationFrame(check);
  }check()})`);
}

export function summarizeGlassTrials(trials) {
  const stats=key=>{const values=trials.map(t=>t[key]).filter(Number.isFinite).sort((a,b)=>a-b);
    return {count:values.length,median:values[Math.floor(values.length/2)],p95:values[Math.max(0,Math.ceil(values.length*.95)-1)],max:values.at(-1)};};
  return {samples:trials.length,timeouts:trials.filter(t=>t.timeout).length,
    material:stats('firstMaterialMs'),content:stats('firstContentMs'),interactive:stats('interactiveMs'),
    longFrames:trials.flatMap((t,trial)=>t.frames?.filter(f=>f.dt>50).map(f=>({trial,...f}))||[])};
}
