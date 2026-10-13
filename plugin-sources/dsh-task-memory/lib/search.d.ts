import type { MemoryEntry } from './store.js';
export interface SearchHit {
    entry: MemoryEntry;
    score: number;
}
/** Lightweight bilingual search: substring + token overlap, no embeddings. */
export declare function searchEntries(entries: readonly MemoryEntry[], query: string, limit?: number): SearchHit[];
/**
 * Build the prompt injection block for one task.
 *
 * The block is budget-constrained twice: `maxChars` caps the whole block and
 * `maxEntryChars` caps each entry's content, so one over-long pinned memory
 * cannot starve the rest of the budget.
 */
export declare function renderInjectBlock(taskId: string, title: string, entries: readonly MemoryEntry[], limit: number, maxChars: number, maxEntryChars?: number): string;
