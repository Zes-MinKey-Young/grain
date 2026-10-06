import mount from './App.grain';

const target = document.getElementById('app');

if (!target) throw new Error('#app is missing from index.html');

mount(target);
