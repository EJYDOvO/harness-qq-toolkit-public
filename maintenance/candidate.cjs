// Bundle list of a maintenance candidate. A Character Profile composes its
// plugins through the dsh-character-core bundle (QQ gateway, Remote Ops,
// Identity, Memory, Long Tasks, Agent I/O ...); those pinned local packages are
// dependencies, not extra bundles, and ops.cjs verify refuses them as bundles.
// A plain QQ Profile keeps the original rule: every pinned local package is a bundle.
function candidateBundles(liveBundles,localPackages={}){
 if(!Array.isArray(liveBundles))throw Error('Profile bundles must be an array');
 if(liveBundles.includes('dsh-character-core'))return [...liveBundles];
 return [...new Set([...liveBundles,...Object.keys(localPackages)])];
}
// Character artifact pins of the candidate: the live record, with each package
// the reviewed policy pins replaced by that pin. Nothing is added or dropped.
function candidateArtifacts(livePins,localPackages={}){
 if(!livePins||typeof livePins!=='object'||Array.isArray(livePins))throw Error('Character artifact pins must be an object');
 return Object.fromEntries(Object.entries(livePins).map(([name,pin])=>{
  const next=localPackages[name];if(!next)return [name,{...pin}];
  for(const key of ['source','sha256','version'])if(typeof next[key]!=='string'||!next[key])throw Error('Incomplete policy pin: '+name+'.'+key);
  return [name,{...(pin.name?{name:pin.name}:{}),source:next.source,sha256:next.sha256,version:next.version}];
 }));
}
module.exports={candidateBundles,candidateArtifacts};
