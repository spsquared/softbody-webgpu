import { resolve } from 'node:path'

import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src/')
        }
    },
    build: {
        target: 'es2021'
    },
    server: {
        port: 5176
    }
})