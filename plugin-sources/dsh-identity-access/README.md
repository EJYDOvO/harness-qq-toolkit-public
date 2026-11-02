# Identity & Access — experimental Host service

Independent of QQ SDK, Memory and Persona. `createIdentityAccess({stateFile,owner:{provider,subject}})` owns one private JSON policy/audit snapshot. `registerProvider(id,verify)` accepts only trusted Host code; its resolver returns opaque verified handles. Include platform, adapter and actual application account in the provider ID. Do not register a verifier which trusts message text or caller-provided role fields.

`resolve(handle)` returns stable Principal/role; `issue(handle,{sessionId,preset})` creates an opaque revocable lease; `authorize(lease,{sessionId,operation,preset})` checks the current epoch, expiry, Provider and Session. Only chat/reply/HITL are allowed to non-Owners. A global epoch conservatively revokes all current leases on any policy mutation. Expiry is checked at every authorization, not via a scheduler. Callers must recheck at each sensitive boundary and observe the AbortSignal.

`show/list/change/audit/reference` require Owner authorization. Targets must have been verified by a registered Provider. Owner binding is immutable; guests are not persisted by default. Roles do not write Character Memory. One active in-process writer is permitted; deployments must prevent multiple processes sharing the same stateFile. JSON rename is atomic within one filesystem; power-loss durability depends on the filesystem.

`role-command.mjs` produces an existing I/O command spec using a Host actor resolver. References are verified Principal IDs, not nicknames. Commands are not auto-registered.

**Not enabled or wired into the production Gateway.** This initial service alone is not a multi-user safety boundary. Existing Character Identity still admits only its fixed Owner. Do not open platform admission until commands, HITL, Manager recovery/preset switching and all outbound routes use the same authorization lifecycle. No deployment or data migration is included.

Any persistence exception revokes all leases and makes the current instance fail closed. Recovery requires reviewing durable state and restarting the isolated service; no old grant is allowed to continue on assumed in-memory success.

