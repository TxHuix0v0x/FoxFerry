'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {ConnectionHistory}=require('../src/connection-history.cjs');
test('discovery time descending agrees across global/subscription/snapshot and caches unchanged keys',()=>{
 const h=new ConnectionHistory(),rows=Array.from({length:13},(_,i)=>({id:'a'+i,subscriptionId:'main'}));const day=Date.UTC(2026,10,14,23,59,59);
 h.observe(rows,day);h.observe([{id:'z-new',subscriptionId:'main'},{id:'b-tie',subscriptionId:'main'},{id:'other',subscriptionId:'secondary'}],day+2000);
 assert.deepEqual(h.page().rows.slice(0,3).map(r=>r.id),['b-tie','other','z-new']);assert.deepEqual(h.page({subscriptionId:'main'}).rows.slice(0,2).map(r=>r.id),['b-tie','z-new']);
 let comparisons=0;const compare=h.compareIds.bind(h);h.compareIds=(...args)=>{comparisons++;return compare(...args);};
 h.observe([{id:'z-new',subscriptionId:'main',bytes:99}],day+4000);assert.equal(h.page().rows[0].id,'b-tie');h.page({subscriptionId:'main'});assert.equal(comparisons,0);
 assert.equal(h.page().rows[0].status,'ended');assert.equal(h.page().rows[0].firstSeenAt,day+2000);
 const frozen=h.page({mode:'pause',page:2});const ids=frozen.rows.map(r=>r.id);h.observe([{id:'000-later',subscriptionId:'main'}],day+6000);assert.deepEqual(h.page({mode:'snapshot',page:2}).rows.map(r=>r.id),ids);
 assert.equal(h.page({mode:'resume',subscriptionId:'main'}).rows[0].id,'000-later');assert.equal(h.page().rows.length,10);
});
