import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
// Element Plus theme first, then our styles.css — so our same-specificity
// overrides reliably win over EP defaults.
import 'element-plus/dist/index.css'
import './styles.css'

createApp(App).use(createPinia()).mount('#app')
