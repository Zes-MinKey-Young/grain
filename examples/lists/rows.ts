import { reactive_array, reactive_set } from '@graints/runtime';

/**
 * A reactive array.
 *
 * Nothing here is visible to the compiler of `App.grain` — the push happens in this module,
 * which is exactly the case the container is for: it announces its own changes, so the `for`
 * loop over it still updates precisely.
 */
export const rows = reactive_array(['alpha', 'beta']);

let added = 0;

/** Mutates `rows` from outside the component */
export function add_row(): void {
    added += 1;

    rows.push(`added ${added}`);
}

/** Same, but removes from the front */
export function drop_row(): void {
    rows.shift();
}

/** A reactive Set — no order, but the same story */
export const tags = reactive_set(['one']);

let tagged = 0;

export function add_tag(): void {
    tagged += 1;

    tags.add(`tag ${tagged}`);
}
