import test from 'node:test';
import assert from 'node:assert/strict';
import {renderStoredMemory} from '../lib/render.js';
test('recall and search send the stored fact to the model, including Chinese text',()=>{
 const fact={key:'deadline',content:'项目截止日期：2026-11-01',tags:['plan']};
 for(const value of [{taskId:'project',found:true,entry:fact},{taskId:'project',hits:[fact]}]){
  const text=renderStoredMemory(value);assert.match(text,/项目截止日期：2026-11-01/);
  assert.deepEqual(JSON.parse(text.slice(text.indexOf('\n')+1)),value);
 }
});
