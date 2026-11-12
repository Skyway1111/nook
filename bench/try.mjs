// Drives a dev nook's page over CDP: node bench/try.mjs '<js>' [port] runs one expression and prints what it gives,
// with `screen()` the showing terminal's rows that hold text and `tabs()` the tab strip's labels.
// node bench/try.mjs --type '<text>' types into the page, each \r as Enter. --crash ends the page's process.
import { connect } from './cdp.mjs'

const [what, arg] = process.argv.slice(2)
const page = await connect(Number(process.env.CDP_PORT ?? 9222))
if (what === '--type') {
  for (const part of arg.split(/(\r)/)) {
    if (part === '\r') for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined })
    else if (part) await page.send('Input.insertText', { text: part })
  }
} else if (what === '--crash') {
  page.send('Page.crash').catch(() => {})
  await new Promise(r => setTimeout(r, 300))
} else {
  const helpers = `const screen = () => [...document.querySelectorAll('.view:not([hidden]) .xterm-rows > div')].map(r => r.textContent.trimEnd()).filter(Boolean);
  const tabs = () => [...document.querySelectorAll('#tabs .tab')].map(t => t.textContent + (t.classList.contains('active') ? ' *' : ''));`
  console.log(JSON.stringify(await page.evaluate(`(async () => { ${helpers} return (${what}) })()`), null, 1))
}
page.close()
