import {createIdentityAccess} from './access.mjs';
export {createIdentityAccess};
export const name='identity-access';
export function apply(ctx,config){const service=createIdentityAccess(config);ctx.provide('identityAccess',service);ctx.effect(()=>()=>service.close());}
