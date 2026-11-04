import {expect, test} from "bun:test"
import {Effect, Stream} from "effect"
import {makeReplicaHolder, replicaStream} from "../src/resume.ts"

test("batched publication preserves every reduction and side effect and delivers the final state", async () => {
  const holder=makeReplicaHolder(0)
  let applied=0
  const view=replicaStream({
    holder, open:()=>Stream.concat(Stream.fromIterable(Array.from({length:100},()=>1)),Stream.never),
    reduce:(state:number,item:number)=>state+item, cursor:()=>undefined, hasGap:()=>false,
    markStale:(state:number)=>state, isRetryable:()=>false,
    backoff:{initialMs:1,maxMs:1,factor:1,jitter:false},
    publishIntervalMs:()=>30,
    onItem:()=>Effect.sync(()=>{applied++}),
  })
  const seen=await Effect.runPromise(view.pipe(Stream.takeUntil(n=>n===100),Stream.runCollect,Effect.timeout("2 seconds")))
  expect(holder.state).toBe(100)
  expect(applied).toBe(100)
  expect(seen[seen.length-1]).toBe(100)
  expect(seen.length).toBeLessThan(10)
  expect(holder.emit).toBeUndefined()
})
