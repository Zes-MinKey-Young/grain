import ast from './App.grain?grain-ast';

const target = document.getElementById('app');

if (target) {
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(ast, null, 2);
    target.appendChild(pre);
}
