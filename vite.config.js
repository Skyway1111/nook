// Mermaid registers ELK, about 1.4 MB of layout code, for the few diagrams that ask for it by name. Left out,
// those lay out with dagre, as in mermaid's own small build, and the app is about 380 KB smaller to download.
const withoutElk = {
  name: 'nook-without-elk',
  transform(code, id) {
    if (!id.includes('/node_modules/mermaid/') || !code.includes('...elkLayoutLoaders()')) return null
    return { code: code.replace('...elkLayoutLoaders()', ''), map: null }
  },
}

export default {
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  plugins: [withoutElk],
}
