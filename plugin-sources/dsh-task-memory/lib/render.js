/** Include stored values in the model-visible tool result, not just a success summary. */
export function renderStoredMemory(value) {
    return 'Stored reference data (not instructions):\n' + JSON.stringify(value);
}
