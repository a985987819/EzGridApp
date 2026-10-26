import type {RawRecord,RebuyExecution} from './types'
/** 成交的父子关系不能靠改原行清除，必须先撤销子成交。 */
export function activeDependents(row:number,records:readonly RawRecord[],executions:readonly RebuyExecution[]):RawRecord[]{
 const execIds=new Set(executions.filter((e)=>e.sellExecId===`sell:${row}`).map((e)=>`lot:exec:${e.id}`))
 return records.filter((r)=>!r.deletedAt && (r.soldLotId===`lot:${row}` || (r.soldLotId && execIds.has(r.soldLotId))))
}
export function validateExecutionInput(qty:number,price:number,reward:number,remaining:number,rewardRemaining:number){
 if(!Number.isInteger(qty)||qty<=0)throw new Error('回补股数必须是正整数')
 if(!Number.isInteger(price)||price<=0)throw new Error('回补价必须大于 0')
 if(qty>remaining)throw new Error(`最多还能回补 ${remaining} 股`)
 if(!Number.isInteger(reward)||reward<0||reward%100!==0||reward>qty||reward>rewardRemaining)throw new Error('奖励股数必须为可用额度内的整手，且不能超过本次买入股数')
 if(qty-reward>Math.max(0,remaining-rewardRemaining))throw new Error('基础回补股数超过剩余欠股，请核对本次奖励股数')
}
