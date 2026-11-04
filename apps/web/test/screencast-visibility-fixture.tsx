// Synthetic transport only; never connects to a real bot.
import {useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {useScreencast} from '../src/computer/useScreencast.ts'
declare global {
  interface Window {
    metrics: {opened:number; closed:number; decoded:number}
    setFocus: (value:boolean)=>void
    setMode: (value:'view'|'control')=>void
    setEnabled: (value:boolean)=>void
  }
}
const metrics={opened:0,closed:0,decoded:0}
Object.assign(window,{metrics})
let focused=true
Object.defineProperty(document,'hasFocus',{value:()=>focused})
Object.assign(window,{setFocus:(value:boolean)=>{focused=value;window.dispatchEvent(new Event(value?'focus':'blur'))}})
class FakeSocket {
 static OPEN=1; static CONNECTING=0; readyState=1
 onopen:any;onmessage:any;onclose:any;binaryType='';timer:any
 constructor(_url:string){metrics.opened++;setTimeout(()=>this.onopen?.(),0);this.timer=setInterval(()=>{
  const meta=new TextEncoder().encode(JSON.stringify({seq:0,mime:'image/png',width:2,height:2,viewportWidth:2,viewportHeight:2,timestamp:Date.now()}));
  const b=new Uint8Array(4+meta.length+1);new DataView(b.buffer).setUint32(0,meta.length);b.set(meta,4);
  this.onmessage?.({data:b.buffer});
 },10)}
 close(){clearInterval(this.timer);metrics.closed++;this.readyState=3}
 send(){}
}
Object.assign(window,{WebSocket:FakeSocket,createImageBitmap:async()=>{metrics.decoded++;const c=new OffscreenCanvas(2,2);c.getContext('2d')!.fillRect(0,0,2,2);return c.transferToImageBitmap()}})
function App(){
 const canvasRef=useRef<HTMLCanvasElement>(null)
 const [mode,setMode]=useState<'view'|'control'>('view')
 const [enabled,setEnabled]=useState(true)
 Object.assign(window,{setMode,setEnabled})
 const {state}=useScreencast({botId:'test',enabled,mode,canvasRef})
 return <><div style={{height:200,width:200}}><canvas style={{height:200,width:200}} ref={canvasRef}/><span>{state.phase}</span></div><div style={{height:3000}}/></>
}
createRoot(document.getElementById('root')!).render(<App/> )
