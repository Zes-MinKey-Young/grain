import mount from './App.grain';

// `mount(target)` 是产物里的默认导出 —— 直接拿 App.grain 当入口的话没人调它
// （vite 的入口模块不需要导出，default 会被丢掉），所以单独一个入口文件
mount(document.getElementById('app')!);
