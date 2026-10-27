// 从 kipphi-apparatus 里截出来的组件原文（只删掉了跟顺序无关的东西）。
// 用来复现"组件和普通元素混排时插错位置"。
//
// 形状要点：
// - 根是 fragment，内容是一个 div + 里面的 img
// - 组件套组件（PlayButton -> IconSwitchButton）
// - 属性里既有静态字符串，也有函数值（`() => …`）和 `bind:` 绑定

/** `IconSwitchButton.grain`：组件根是 fragment，孩子是一个 div + img */
export const iconSwitchButton = `<script>
    let { offImgSrc, onImgSrc, onchange: onChange, checked = $bindable(false), class: className = '' } = $props<{
        offImgSrc: string;
        onImgSrc: string;
        onchange?: (checked: boolean) => void;
        checked?: boolean;
        class?: string;
    }>();

    function toggle() {
        checked = !checked;
        onChange?.(checked);
    }
</script>

<div class="icon-button {className} {checked ? 'checked' : ''}" role="button" onclick={toggle}>
    <img src={checked ? onImgSrc : offImgSrc} alt={checked ? 'Switch On' : 'Switch Off'}>
</div>

<style>
    img {
        object-fit: cover;
        width: 100%;
        height: 100%;
    }
</style>
`;

/** `PlayButton.grain`：把上面那个再包一层 */
export const playButton = `<script>
    import IconSwitchButton from './icon-switch.ts';

    let { onchange, checked = $bindable(false) } = $props<{
        onchange?: (checked: boolean) => void;
        checked?: boolean;
    }>();
</script>

<IconSwitchButton onImgSrc="/icons/pause.svg" offImgSrc="/icons/play.svg" onchange={onchange} bind:checked />
`;

/** `GridSwitch.grain`：内联 SVG */
export const gridSwitch = `<script>
    let { onchange: onChange, checked = $bindable(false) } = $props<{
        onchange?: (checked: boolean) => void;
        checked?: boolean;
    }>();

    function toggle() {
        checked = !checked;
        onChange?.(checked);
    }
</script>

<div class="icon-button" role="button" onclick={toggle}>
    <svg style="width: 100%; height: 100%;" width="200" height="200" viewBox="0 0 200 200">
        <g transform="scale(0.75, 0.75)" stroke={checked ? '#5f9' : '#f8f9fa'}>
            <path stroke-width="16" d="M20,100 H180" />
            <path stroke-width="16" d="M100,20 V180" />
        </g>
    </svg>
</div>
`;
