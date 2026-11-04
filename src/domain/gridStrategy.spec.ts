import { describe, expect, it } from 'vitest'
import { buildLedger } from './ledger'
import { buildLadder, gridStatuses, type GridMode } from './gridStrategy'
import { mergeTargetRows } from './merge'
import { validateBackup } from './backup'
import { buildBuySuggestions } from './suggestions'
import type { RawRecord, RebuyExecution } from './types'

const stock = { id: 'stock:T', name: 'T', intervalCents: 57, priceLimitType: 'main_10' as const }
const row = (sourceRow: number, patch: Partial<RawRecord>): RawRecord => ({ sourceRow, stockName: 'T',
  buyDateSerial: 46000, buyPriceCents: 1000, buyQtyRaw: 1000, qtyNeedsDerive: false,
  targetPriceCents: 1200, targetNeedsDerive: false, soldQty: 0, sellDateSerial: null,
  earlyBuyPriceCents: null, rawProfitCents: null, importKey: `r:${sourceRow}`, ...patch })
const base = [row(2, {})]
const make = (mode: GridMode) => buildLadder(buildLedger(base, [stock]), {lotIds:['lot:2'],startCents:700,stepCents:30,direction:1,perQty:500,rebuyGapCents:200,mode}, 'g', 1)
const sale = (id: number, target: string, qty = 500, price = 700, lotId = 'lot:2') => row(id, { buyQtyRaw: null, soldQty: qty, soldLotId: lotId, soldTargetId: target,
  targetPriceCents: price, earlyBuyPriceCents: 500, sellDateSerial: 46001 })
const exec = (qty = 500): RebuyExecution => ({ id:'e1', orderId:'rb:sell:3',sellExecId:'sell:3',stockId:stock.id,stockName:'T',qty,
  priceCents:500,rewardQty:0,groupKeyAtExecution:'T|500',at:Date.UTC(2025,11,12) })
const balanced = (l: ReturnType<typeof buildLedger>) => expect(l.checks.filter(c => !c.ok)).toEqual([])

describe('连续拆档与双模式', () => {
  it('普通先卖后买默认低位回本并自动关联最高剩余高位，原记录不改', () => {
    const root = row(3,{buyPriceCents:null,buyQtyRaw:null,buyDateSerial:null,soldQty:500,sellDateSerial:46001,targetPriceCents:700,earlyBuyPriceCents:500})
    const records = [...base,row(4,{buyPriceCents:1100,buyQtyRaw:500}),root], original = JSON.stringify(records)
    const ledger = buildLedger(records,[stock]);balanced(ledger)
    expect(ledger.orders.find(o=>o.sourceRow===3)).toMatchObject({strategyMode:'repair',strategyIsDefault:true,sellFirst:true})
    expect(ledger.effectiveHedges.find(h=>h.sellRow===3)?.items).toEqual([{row:4,qty:500}])
    expect(ledger.repairChains[0]).toMatchObject({lossCents:-200000,profitCents:0})
    expect(ledger.buySplits.find(b=>b.sourceRow===3)).toMatchObject({strategyMode:'repair',strategyIsDefault:true})
    expect(JSON.stringify(records)).toBe(original)
    const detached = buildLedger(records,[stock],{hedges:[{id:'hedge:3',sellRow:3,items:[],at:1}]})
    expect(detached.effectiveHedges.find(h=>h.sellRow===3)?.items).toEqual([])
    expect(detached.orders.find(o=>o.sourceRow===3)?.strategyMode).toBe('repair')
  })
  it('默认模式不覆盖显式底仓做T，也不改变正常先买后卖的P列再买', () => {
    const targets=make('baseT'), records=[...base,sale(3,`target:${targets[0].id}`),row(4,{buyPriceCents:500,buyQtyRaw:100,targetPriceCents:700,soldQty:100,sellDateSerial:46001,earlyBuyPriceCents:450})]
    const ledger=buildLedger(records,[stock],{extraTargets:targets});balanced(ledger)
    expect(ledger.orders.find(o=>o.sourceRow===3)?.strategyMode).toBe('baseT')
    expect(ledger.orders.find(o=>o.sourceRow===3)?.strategyIsDefault).toBeUndefined()
    expect(ledger.orders.find(o=>o.sourceRow===4)).toMatchObject({sellFirst:false})
    expect(ledger.orders.find(o=>o.sourceRow===4)?.strategyMode).toBeUndefined()
    expect(ledger.orders.find(o=>o.sourceRow===4)?.strategyIsDefault).toBeUndefined()
  })
  it('默认与显式低位回本同价仍分组，旧默认改单只缩自己的100股到50股', () => {
    const targets=make('repair'), root=row(4,{buyPriceCents:null,buyQtyRaw:null,buyDateSerial:null,soldQty:100,sellDateSerial:46001,targetPriceCents:700,earlyBuyPriceCents:500})
    const records=[...base,sale(3,`target:${targets[0].id}`,100),root]
    const ledger=buildLedger(records,[stock],{extraTargets:targets});balanced(ledger)
    const plan={id:'p',refId:'buy:cover:T:500',kind:'buy' as const,priceCents:500,qty:50,at:1}
    const board=buildBuySuggestions(ledger.buySplits,[],[plan])
    expect(board).toHaveLength(2)
    expect(board.reduce((sum,r)=>sum+r.qty,0)).toBe(150)
    expect(board.find(r=>r.key===plan.refId)).toMatchObject({strategyMode:'repair',strategyIsDefault:true,qty:50,edited:true,sources:[{row:4,qty:50}]})
    expect(board.find(r=>r.key==='buy:cover:T:500:repair')).toMatchObject({strategyMode:'repair',qty:100,sources:[{row:3,qty:100}]})
    const moved=buildBuySuggestions(ledger.buySplits,[],[{...plan,priceCents:450}])
    expect(moved.find(r=>r.key===plan.refId)).toMatchObject({priceCents:450,qty:50,sources:[{row:4,qty:50}]})
    expect(moved.find(r=>r.key==='buy:cover:T:500:repair')).toMatchObject({priceCents:500,qty:100,sources:[{row:3,qty:100}]})
  })
  it('多笔相邻成本连续排四档，原始记录未改，尾量不增加库存', () => {
    const records = [row(2,{}),row(3,{buyPriceCents:1010})], snapshot = JSON.stringify(records)
    const ledger = buildLedger(records,[stock])
    const targets = buildLadder(ledger,{lotIds:['lot:2','lot:3'],startCents:1200,stepCents:30,direction:1,perQty:500,rebuyGapCents:200,mode:'baseT'},'g',1)
    expect(targets.map(t => [t.priceCents,t.qty,t.lotId])).toEqual([[1200,500,'lot:2'],[1230,500,'lot:2'],[1260,500,'lot:3'],[1290,500,'lot:3']])
    const result=buildLedger(records,[stock],{extraTargets:targets});balanced(result)
    expect(JSON.stringify(records)).toBe(snapshot)
    expect(result.totals.netQty).toBe(2000)
    expect(buildLadder(ledger,{lotIds:['lot:2'],startCents:1200,stepCents:30,direction:-1,perQty:600,rebuyGapCents:200,mode:'repair'},'g',1).map(t=>t.qty)).toEqual([600,400])
  })
  it('低位回本：10买7卖亏1500，5回补不提前盈利，7再卖归原链1000', () => {
    const targets=make('repair'), records=[...base,sale(3,`target:${targets[0].id}`)]
    const bought=buildLedger(records,[stock],{extraTargets:targets,executions:[exec()]});balanced(bought)
    expect(bought.repairChains[0]).toMatchObject({lossCents:-150000,profitCents:0,holdingQty:500})
    expect(bought.lots.find(l=>l.id==='lot:exec:e1')?.targetPriceCents).toBe(700)
    const closed=buildLedger([...records,sale(4,'target:lot:exec:e1',500,700,'lot:exec:e1')],[stock],{extraTargets:targets,executions:[exec()]});balanced(closed)
    expect(closed.repairChains[0]).toMatchObject({lossCents:-150000,profitCents:100000,gapCents:50000})
    expect(closed.totals.profitCents).toBe(-50000)
  })
  it('底仓做T：卖出暂停原份额，部分回补仅恢复对应高位目标，成本保持实际5元，无回本链', () => {
    const targets=make('baseT'), records=[...base,sale(3,`target:${targets[0].id}`)]
    let ledger=buildLedger(records,[stock],{extraTargets:targets});balanced(ledger)
    expect(ledger.totals.netQty).toBe(500);expect(ledger.repairChains).toHaveLength(0)
    ledger=buildLedger(records,[stock],{extraTargets:targets,executions:[exec(200)]});balanced(ledger)
    expect(ledger.lots.find(l=>l.id==='lot:exec:e1')).toMatchObject({buyPriceCents:500,remainingQty:200,targetPriceCents:1200})
    expect(ledger.totals.targetQty).toBe(700);expect(ledger.repairChains).toHaveLength(0)
    expect(gridStatuses(targets,records,[exec(200)],ledger.lots)[0]).toMatchObject({pendingQty:300,repaidQty:200,spreadCents:40000,holdingQty:200})
    expect(ledger.totals.profitCents).toBe(-150000)
  })
  it('做T全回补再12卖，净利润只计实际成交，不加两次策略收益', () => {
    const targets=make('baseT'), records=[...base,sale(3,`target:${targets[0].id}`),sale(4,'target:lot:exec:e1',500,1200,'lot:exec:e1')]
    const ledger=buildLedger(records,[stock],{extraTargets:targets,executions:[exec()]});balanced(ledger)
    expect(ledger.repairChains).toHaveLength(0)
    expect(ledger.totals.profitCents).toBe(200000)
    expect(gridStatuses(targets,records,[exec()],ledger.lots)[0]).toMatchObject({pendingQty:0,spreadCents:100000,holdingQty:0})
  })
  it('同价两个模式不合并，不套用价格型计划污染其它模式', () => {
    const targets=make('repair');targets[1]={...targets[1],priceCents:700,strategy:{...targets[1].strategy!,mode:'baseT'}}
    const ledger=buildLedger(base,[stock],{extraTargets:targets})
    const rows=mergeTargetRows({...ledger,merges:[],plans:[{id:'p',refId:'sell:T:700',kind:'sell',priceCents:800,qty:500,at:1}]})
    expect(rows).toHaveLength(2);expect(rows.every(r=>r.priceCents===700&&r.qty===500)).toBe(true)
  })
  it('重复来源、非正价位与已有占用拒绝继续增加份额', () => {
    const ledger=buildLedger(base,[stock],{extraTargets:make('repair')})
    expect(()=>buildLadder(ledger,{lotIds:['lot:2'],startCents:700,stepCents:30,direction:1,perQty:500,rebuyGapCents:200,mode:'repair'},'g',1)).toThrow('占用')
  })
  it('已有裸卖可独立标记做T，原高位成本和损失保留，回补只恢复一份高位计划', () => {
    const root=row(3,{buyPriceCents:null,buyQtyRaw:null,buyDateSerial:null,soldQty:500,sellDateSerial:46001,targetPriceCents:700,earlyBuyPriceCents:500})
    const marker={id:'grid-mode:3',lotId:'lot:2',qty:0,priceCents:700,at:1,strategy:{mode:'baseT' as const,rebuyPriceCents:500,nextSellPriceCents:1200,groupId:'grid-mode:3',sellRow:3}}
    const ledger=buildLedger([...base,root],[stock],{extraTargets:[marker],executions:[exec(200)]});balanced(ledger)
    expect(ledger.repairChains).toHaveLength(0)
    expect(ledger.totals.profitCents).toBe(-150000)
    expect(ledger.totals.targetQty).toBe(700)
    expect(ledger.lots.find(l=>l.id==='lot:exec:e1')).toMatchObject({buyPriceCents:500,targetPriceCents:1200})
  })
  it('低位回本模式第二轮按实际来源继承，亏损卖出也留在原链', () => {
    const targets=make('repair'), records=[...base,sale(3,`target:${targets[0].id}`),sale(4,'target:lot:exec:e1',500,400,'lot:exec:e1')]
    const ledger=buildLedger(records,[stock],{extraTargets:targets,executions:[exec(),{...exec(),id:'e2',sellExecId:'sell:4',orderId:'rb:sell:4',priceCents:300,at:Date.UTC(2025,11,14)}]});balanced(ledger)
    expect(ledger.repairChains).toHaveLength(1)
    expect(ledger.repairChains[0]).toMatchObject({profitCents:-50000,holdingQty:500,gapCents:200000})
    expect(ledger.orders.find(o=>o.sourceRow===4)?.strategyMode).toBe('repair')
  })
  it('策略备份不接受重复模式来源、非法价格或丢失的成交来源档', () => {
    const root=row(3,{buyPriceCents:null,buyQtyRaw:null,buyDateSerial:null,soldQty:500,sellDateSerial:46001,targetPriceCents:700,earlyBuyPriceCents:500})
    const marker={id:'grid-mode:3',lotId:'lot:2',qty:0,priceCents:700,at:1,strategy:{mode:'baseT' as const,rebuyPriceCents:500,nextSellPriceCents:1200,groupId:'grid-mode:3',sellRow:3}}
    expect(validateBackup({records:[...base,root],extraTargets:[marker]})).toBeNull()
    expect(validateBackup({records:[...base,root],extraTargets:[marker,{...marker,id:'duplicate'}]})).toContain('重复模式')
    expect(validateBackup({records:base,extraTargets:[{...make('repair')[0],strategy:{...make('repair')[0].strategy!,rebuyPriceCents:0}}]})).toContain('策略模式或价量')
    expect(validateBackup({records:[...base,sale(3,'target:grid:missing')],extraTargets:[]})).toContain('策略档来源缺失')
  })
  it('做T回补高价时单列负价差，不把库存成本改成原高位价', () => {
    const targets=make('baseT'),records=[...base,sale(3,`target:${targets[0].id}`)],e={...exec(200),priceCents:800}
    const ledger=buildLedger(records,[stock],{extraTargets:targets,executions:[e]});balanced(ledger)
    expect(gridStatuses(targets,records,[e],ledger.lots)[0].spreadCents).toBe(-20000)
    expect(ledger.lots.find(l=>l.id==='lot:exec:e1')?.buyPriceCents).toBe(800)
    expect(ledger.repairChains).toHaveLength(0)
  })
  it('同行历史回补按实际价恢复高位目标，多买100股保持独立低位档', () => {
    const root=row(3,{buyPriceCents:500,buyQtyRaw:600,buyDateSerial:46002,soldQty:500,sellDateSerial:46001,targetPriceCents:700,earlyBuyPriceCents:550})
    const marker={id:'grid-mode:3',lotId:'lot:2',qty:0,priceCents:700,at:1,strategy:{mode:'baseT' as const,rebuyPriceCents:550,nextSellPriceCents:1200,groupId:'grid-mode:3',sellRow:3}}
    const records=[...base,root], original=JSON.stringify(records)
    const ledger=buildLedger(records,[stock],{extraTargets:[marker]});balanced(ledger)
    expect(ledger.targets.filter(t=>t.lotId==='lot:3').map(t=>[t.priceCents,t.qty,t.strategyMode]).sort((a,b)=>Number(a[0])-Number(b[0])))
      .toEqual([[700,100,undefined],[1200,500,'baseT']])
    expect(ledger.repairChains).toHaveLength(0)
    expect(gridStatuses([marker],records,[],ledger.lots)[0]).toMatchObject({pendingQty:0,repaidQty:500,holdingQty:500,spreadCents:100000})
    expect(ledger.totals).toMatchObject({buyQty:1600,sellQty:500,netQty:1100,targetQty:1100,profitCents:-150000})
    expect(JSON.stringify(records)).toBe(original)
    expect(validateBackup({records,extraTargets:[marker]})).toBeNull()
    const sold=buildLedger([...records,sale(4,'target:baseT-surplus:3',100,800,'lot:3')],[stock],{extraTargets:[marker]});balanced(sold)
    expect(sold.targets.filter(t=>t.lotId==='lot:3')).toMatchObject([{priceCents:1200,qty:500}])
    expect(gridStatuses([marker],[...records,sale(4,'target:baseT-surplus:3',100,800,'lot:3')],[],sold.lots)[0].holdingQty).toBe(500)
  })
})
