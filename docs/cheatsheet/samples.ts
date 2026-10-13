/**
 * Cheatsheet samples.
 *
 * Kept in `.ts` rather than inlined in the template: a literal `<script>` inside a grain
 * template is picked up by grain's own parser (it only reads template text, never the
 * inside of a `<script>`), which then reports "only allowed at the top level".
 *
 * `note` fields are plain text — no markdown, the component renders them as-is.
 */

export interface Sample {
    title: string;
    code: string;
    note?: string;
}

export const samples: Sample[] = [
    {
        title: '1 · A component',
        code: `<script>
    let count = $state(0);
<\/script>

<button onclick={() => count += 1}>{count}</button>

<style>
    button { padding: 4px 8px; }
<\/style>`,
        note: 'State in script, markup in the template, styles are scoped.'
    },
    {
        title: '2 · $state and levels',
        code: `let n    = $state(0);            // level 0: reassign only
let list = $state([1, 2]);       // containers default to level 1
let obj  = $state({ a: 1 }, 1);  // objects default to 0, opt in

const third = list[2];
third.name = 'x';                // touches only what reads it`,
        note: 'Deps are paths, not variables. Locals taken out of a container keep that precision.'
    },
    {
        title: '3 · Interpolation',
        code: `<p>{count} / {count * 2} / {count > 3 ? 'big' : 'small'}</p>
<input bind:value={name} />`,
        note: 'Anything inside braces is a TS expression.'
    },
    {
        title: '4 · bind: (two-way)',
        code: `<MyInput bind:value={count} />

<MyInput bind:value={{
    get: () => count,
    set: (value) => count = value
    listen: (u) => bus.on('valchange', u)
}} />`,
        note: 'The prop must be declared with $bindable.'
    },
    {
        title: '5 · $props / $bindable',
        code: `let { label, count = $bindable(0) } = $props<{
    label: string;
    count?: number;
}>();`,
        note: 'Destructure to declare. $bindable makes a prop writable.'
    },
    {
        title: '6 · {#if}',
        code: `{#if count > 3}
    <p>big</p>
{:else if count > 0}
    <p>small</p>
{:else}
    <p>none</p>
{/if}`,
        note: 'Branches swap the DOM, they do not re-run the parent.'
    },
    {
        title: '7 · {#for}',
        code: `{#for item of items with key = item.id}
    <p>{item.name}</p>
{:else}
    <p>empty</p>
{/for}

{#for [i, item] of items.entries() with key = i}
    <p>{i}: {item}</p>
{/for}`,
        note: 'No key: reuse by position. With key: reuse by identity, reorder moves nodes.'
    },
    {
        title: '8 · $node (derived)',
        code: `const doubled = $node({ get: () => count * 2 });
const tripled = $node(count * 3);
const shown   = $node({
    get: () => name.get(),
    set: (v) => name.set(v)
});`,
        note: 'With set it is two-way. Compile-time only — no object survives in the output.'
    },
    {
        title: '9 · Reactive containers',
        code: `let list = $state([{ id: 1 }]);

list.push({ id: 2 });   // builds just the new row
list[1] = { id: 9 };    // replaces just that item
[list[0], list[1]] = [list[1], list[0]];   // one batch call`,
        note: 'Recognised writes become precise calls; unrecognised ones fall back to a diff.'
    },
    {
        title: '10 · Stores (cross-module)',
        code: `// counter.grain.ts
export const counter = writable(0);

// usage
{$read(counter)}
<input bind:value={$store(counter)} />`,
        note: 'writable comes from the runtime. $read is one-way, $store is two-way.'
    },
    {
        title: '11 · bind:this',
        code: `
<div bind:this={box}></div>
<script onmount>box.style.background = 'red';</script>`,
        note: 'Gives you the element. Only guaranteed inside script onmount.'
    },
    {
        title: '12 · script onmount',
        code: `<script onmount>
    greeting = 'after mount';
<\/script>`,
        note: 'Runs once the DOM is in place. Writing $state here refreshes too.'
    },
    {
        title: '13 · Macros',
        code: `<script macro>
    // compile-time fn; args are source text
    function twice(x) { return \`(\${x}) * 2\`; }
<\/script>

<p>{twice(count)}</p>`,
        note: 'Names start with $. $store and $read are built in.'
    }
];
