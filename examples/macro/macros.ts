/**
 * Macros live outside the component too — `<script macro>` may import relative files.
 * The local name has to be renamed with a `$` prefix.
 */

/** Used inside `<script>`: expands into a function that flips a variable */
export function flip(variable: string): string[] {
    return ['()', '=>', `${variable} = ${variable} === 'ada' ? 'bob' : 'ada'`];
}

/** Used on a plain attribute: expands into an expression */
export function shout(variable: string): string[] {
    return [`${variable}.toUpperCase()`];
}
