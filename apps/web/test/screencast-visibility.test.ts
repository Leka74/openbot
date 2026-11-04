// Synthetic fixture globals are test-only.
import {expect,test} from 'bun:test'
import {chromium} from 'playwright-core'

test('passive video pauses when hidden, unfocused or offscreen; control survives; decode is capped',async()=>{
 const build=await Bun.build({entrypoints:[new URL('./screencast-visibility-fixture.tsx',import.meta.url).pathname],target:'browser'})
 expect(build.success).toBe(true)
 const js=await build.outputs[0]!.text()
 const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:req=>new URL(req.url).pathname==='/app.js'?new Response(js,{headers:{'content-type':'text/javascript'}}):new Response('<div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'content-type':'text/html'}})})
 const browser=await chromium.launch({channel:'chrome',headless:true})
 try{
  const page=await browser.newPage({viewport:{width:800,height:600}})
  await page.goto(server.url.href)
  await page.waitForFunction(()=>window.metrics?.decoded>=1)
  const n=await page.evaluate(()=>window.metrics.decoded)
  await page.waitForTimeout(1000)
  const decodes=await page.evaluate((n)=>window.metrics.decoded-n,n)
  expect(decodes).toBeLessThanOrEqual(6)
  await page.evaluate(()=>window.setFocus(false))
  await page.waitForFunction(()=>window.metrics.opened===window.metrics.closed)
  const paused=await page.evaluate(()=>window.metrics.decoded)
  await page.waitForTimeout(250)
  expect(await page.evaluate(()=>window.metrics.decoded)).toBe(paused)
  await page.evaluate(()=>window.setFocus(true))
  await page.waitForFunction(()=>window.metrics.opened>window.metrics.closed)
  await page.evaluate(()=>window.scrollTo(0,1000))
  await page.waitForFunction(()=>window.metrics.opened===window.metrics.closed)
  await page.evaluate(()=>window.scrollTo(0,0))
  await page.waitForFunction(()=>window.metrics.opened>window.metrics.closed)
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))})
  await page.waitForFunction(()=>window.metrics.opened===window.metrics.closed)
  await page.evaluate(()=>window.setMode('control'))
  await page.waitForFunction(()=>window.metrics.opened>window.metrics.closed)
  await page.evaluate(()=>window.setEnabled(false))
  await page.waitForFunction(()=>window.metrics.opened===window.metrics.closed)
 }finally{await browser.close();await server.stop(true)}
},15000)
