/** Lightweight bilingual search: substring + token overlap, no embeddings. */
export function searchEntries(entries, query, limit = 10) {
    const q = query.trim();
    if (!q) {
        return [...entries]
            .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
            .slice(0, limit)
            .map(entry => ({ entry, score: entry.pinned ? 2 : 1 }));
    }
    const qLower = q.toLowerCase();
    const tokens = tokenize(qLower);
    const hits = [];
    for (const entry of entries) {
        const hayKey = entry.key.toLowerCase();
        const hayContent = entry.content.toLowerCase();
        const hayTags = entry.tags.join(' ').toLowerCase();
        let score = 0;
        if (hayKey === qLower)
            score += 100;
        else if (hayKey.includes(qLower))
            score += 40;
        if (hayContent.includes(qLower))
            score += 25;
        if (hayTags.includes(qLower))
            score += 20;
        for (const token of tokens) {
            if (token.length < 2 && !/[\u4e00-\u9fff]/.test(token))
                continue;
            if (hayKey.includes(token))
                score += 8;
            if (hayContent.includes(token))
                score += 4;
            if (hayTags.includes(token))
                score += 6;
        }
        if (entry.pinned)
            score += 5;
        if (score > 0)
            hits.push({ entry, score });
    }
    hits.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
    return hits.slice(0, limit);
}
function tokenize(text) {
    const parts = text.split(/[^\p{L}\p{N}\u4e00-\u9fff]+/u).filter(Boolean);
    const cjk = [];
    for (const part of parts) {
        if (/^[\u4e00-\u9fff]+$/u.test(part) && part.length > 1) {
            for (let i = 0; i < part.length - 1; i++)
                cjk.push(part.slice(i, i + 2));
        }
    }
    return [...new Set([...parts, ...cjk])];
}
/**
 * Build the prompt injection block for one task.
 *
 * The block is budget-constrained twice: `maxChars` caps the whole block and
 * `maxEntryChars` caps each entry's content, so one over-long pinned memory
 * cannot starve the rest of the budget.
 */
export function renderInjectBlock(taskId, title, entries, limit, maxChars, maxEntryChars = 400) {
    if (entries.length === 0)
        return '';
    const selected = [...entries]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
        .slice(0, limit);
    const lines = [
        `## Task memory (${title} / ${taskId})`,
        'These facts are scoped to the ACTIVE task only. Do not apply them to other tasks.',
        'Use memory_remember / memory_recall / memory_search / memory_forget to manage them.',
        '',
    ];
    let used = lines.join('\n').length;
    for (const entry of selected) {
        const pin = entry.pinned ? ' [pinned]' : '';
        const tags = entry.tags.length ? ` tags=${entry.tags.join(',')}` : '';
        const content = maxEntryChars > 0 && entry.content.length > maxEntryChars
            ? `${entry.content.slice(0, maxEntryChars)}…`
            : entry.content;
        const chunk = `- ${entry.key}${pin}${tags}: ${content}`;
        if (used + chunk.length + 1 > maxChars)
            break;
        lines.push(chunk);
        used += chunk.length + 1;
    }
    return lines.length > 4 ? lines.join('\n') : '';
}
