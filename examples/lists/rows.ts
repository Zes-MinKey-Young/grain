import { reactiveArray, reactiveSet } from '@graints/runtime';

/**
 * A reactive array.
 *
 * Nothing here is visible to the compiler of `App.grain` — the push happens in this module,
 * which is exactly the case the container is for: it announces its own changes, so the `for`
 * loop over it still updates precisely.
 */
export const rows = reactiveArray(['alpha', 'beta']);

let added = 0;

/** Mutates `rows` from outside the component */
export function addRow(): void {
    added += 1;

    rows.push(`added ${added}`);
}

/** Same, but removes from the front */
export function dropRow(): void {
    rows.shift();
}

/** A reactive Set — no order, but the same story */
export const tags = reactiveSet(['one']);

let tagged = 0;

export function addTag(): void {
    tagged += 1;

    tags.add(`tag ${tagged}`);
}
