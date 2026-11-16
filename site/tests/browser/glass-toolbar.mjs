// CUA/CDP regression. Local host must follow the same fixed/transform chain;
// Safari compositor/URL-bar pixels still require device acceptance.
export async function verifyToolbarCoordinates(cdp,resize) {
  const read=async expression=>{
    const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
  };
  const report=[];
  for(const height of [939,820,939]) {
    await resize(height);
    report.push(await read(`(async()=>{
      const wrap=document.querySelector('.article-interaction-wrap');
      const old=wrap.style.transform;
      const samples=[];
      const pause=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      try{
        for(const transform of ['', 'translateX(-50%) translateY(-25px) scale(.85)', 'translateX(-50%) translateY(12px) scale(1.05)']){
          wrap.style.transform=transform; visualViewport.dispatchEvent(new Event('scroll')); await pause();
          const bar=wrap.querySelector('.article-interaction-bar'),host=wrap.querySelector('[data-glass-toolbar-host]'),strip=host.querySelector('[data-glass-lens=toolbar]');
          const b=bar.getBoundingClientRect(),s=strip.getBoundingClientRect();
          const dx=Math.abs((b.left+b.width/2)-(s.left+s.width/2)),dy=Math.abs((b.top+b.height/2)-(s.top+s.height/2));
          samples.push({transform,dx,dy,hostIsSibling:host.parentElement===bar.parentElement,visibility:getComputedStyle(strip).visibility});
          if(dx>1||dy>1||!host.inert||getComputedStyle(host).pointerEvents!=='none')throw new Error('Toolbar coordinates diverged');
        }
      }finally{wrap.style.transform=old;visualViewport.dispatchEvent(new Event('scroll'));await pause()}
      return {height:innerHeight,samples};
    })()`));
  }
  return report;
}
