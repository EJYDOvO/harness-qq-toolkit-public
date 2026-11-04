// Native Preset-local tool policy for the contact/guest role Presets. Covers
// inherited and late-registered global tools, not just the prompt catalog.
// Independent of Memory, Persona and the identity service.
export const name='role-tool-scope';
export const inject=['tools'];
export function apply(ctx,config={}){
 const allow=config.allow??[];
 if(!Array.isArray(allow)||allow.some(n=>typeof n!=='string'||!/^\w+$/.test(n))||new Set(allow).size!==allow.length)throw Error('Invalid role Preset tool policy');
 ctx.effect(()=>ctx.tools.restrict({allow:[...allow]}));
 const names=new Set(allow);
 ctx.tools.guard(exec=>typeof exec.name!=='string'||names.has(exec.name)?undefined:'Role Preset does not authorize this tool');
}
