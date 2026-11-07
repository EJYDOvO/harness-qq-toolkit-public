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
module.exports={candidateBundles};
