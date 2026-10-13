# Local QQ operations

Versioned host plugin owned by this deployment. No external dependencies. Loads only with the reviewed QQ adapter patch. Owner is pinned separately from the chat allowlist in `data/maintenance/owner.json`.

Configuration: `maintenance/features.json`. Commands: `/ops help`. Queue operations use the existing maintenance lock, idle check, backup and rollback path. Notifications record pending delivery before sending; failed/ambiguous sends are kept for `/ops notifications` and never blindly replayed. Disable using `/ops feature remoteOps off` or the features CLI. The command to re-enable remains available to the owner.

The plugin restores the current persisted owner session on startup for scheduled delivery. It does not execute an LLM prompt on startup. Changing to `/new` does not migrate old reminders; delete/recreate them in the new session.
