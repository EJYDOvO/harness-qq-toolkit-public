// The QQ Gateway's Turn cancellation registry (createTurnControls in the
// reviewed bootstrap): /stop must reach every submission still in the Unified
// Agent I/O, however many Turns or Sessions came after it, while idle state stays
// bounded and Session release / Gateway close clean up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTurnControls} from './qq-conversation-fixture.mjs';

test('a leased controller survives per-Session capacity: /stop still cancels a queued message of an old Turn',()=>{
 const t=createTurnControls({maxTurns:8,maxSessions:256});
 t.start('s',1);const queued=t.acquire('s',1);
 for(let turn=2;turn<=40;turn++){t.start('s',turn);t.end('s',turn,false);}
 for(let turn=41;turn<=60;turn++)t.start('s',turn);
 assert(t.size().controllers<=9,'idle controllers stay bounded; only the leased one is extra');
 t.cancel('s');
 assert.equal(queued.signal.aborted,true,'the old Turn is cancelled although 59 Turns followed');
 queued.release();
});
test('without leases the registry is bounded per Session and overall',()=>{
 const t=createTurnControls({maxTurns:8,maxSessions:256});
 for(let s=0;s<1000;s++)for(let turn=1;turn<=20;turn++)t.start('s'+s,turn);
 const {sessions,controllers}=t.size();
 assert(sessions<=256,'sessions '+sessions);assert(controllers<=256*8,'controllers '+controllers);
 for(let turn=1;turn<=20;turn++)t.end('s999',turn,false);
 assert.equal(t.latest('s999'),undefined,'completed idle Turns are dropped at turn/end');
});
test('held Sessions are never evicted beyond the cap; they become evictable once released',()=>{
 const t=createTurnControls({maxTurns:8,maxSessions:4});
 const leases=[];for(let s=0;s<10;s++){t.start('s'+s,1);leases.push(t.acquire('s'+s,1));}
 assert.equal(t.size().sessions,10,'every Session with output in the I/O stays reachable');
 for(const [i,l] of leases.entries()){t.cancel('s'+i);assert.equal(l.signal.aborted,true);}
 for(const l of leases)l.release();
 t.start('fresh',1);
 assert(t.size().sessions<=4,'released Sessions are pruned again');
});
test('an aborted Turn stays cancelled for late output; a completed one is fresh for its late output',()=>{
 const t=createTurnControls();
 t.start('s',1);t.end('s',1,true);
 assert.equal(t.acquire('s',1).signal.aborted,true,'late output of the aborted Turn');
 t.end('s',2,true);assert.equal(t.acquire('s',2).signal.aborted,true,'aborted without a seen turn/start');
 t.start('s',3);t.end('s',3,false);
 const late=t.acquire('s',3);assert.equal(late.signal.aborted,false);
 t.cancel('s');assert.equal(late.signal.aborted,true,'/stop still reaches late output of a completed Turn');
});
test('output without a Turn: /stop cancels it, later output gets a fresh controller',()=>{
 const t=createTurnControls();
 const first=t.acquire('s',undefined);t.cancel('s');
 assert.equal(first.signal.aborted,true);
 const next=t.acquire('s',undefined);assert.equal(next.signal.aborted,false,'a /stop is not a permanent block');
 first.release();next.release();
});
test('Session release aborts and forgets; a lease released afterwards does not resurrect it',()=>{
 const t=createTurnControls();
 t.start('s',1);const l=t.acquire('s',1);
 t.release('s');assert.equal(l.signal.aborted,true);assert.equal(t.size().sessions,0);
 l.release();l.release();
 assert.equal(t.size().sessions,0,'double release is harmless');
 assert.equal(t.acquire('other',1).signal.aborted,false,'other Sessions are untouched');
});
test('a cancel during an acquire/release race keeps the cancellation',()=>{
 const t=createTurnControls({maxTurns:2});
 t.start('s',1);const a=t.acquire('s',1),b=t.acquire('s',1);
 a.release();t.cancel('s');
 for(let turn=2;turn<=5;turn++)t.start('s',turn);
 assert.equal(b.signal.aborted,true,'the remaining lease is cancelled and kept reachable');
 b.release();
 assert(t.size().controllers<=2);
});
test('Gateway close aborts every controller and refuses later output',()=>{
 const t=createTurnControls();
 t.start('a',1);const held=t.acquire('a',1);
 t.close();
 assert.equal(held.signal.aborted,true);assert.equal(t.size().sessions,0);
 assert.equal(t.acquire('b',1).signal.aborted,true,'nothing is handed over after close');
 t.start('b',2);t.end('b',2,true);assert.equal(t.size().sessions,0);
});
