import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const html = await readFile('index.html', 'utf8');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const vercel = JSON.parse(await readFile('vercel.json', 'utf8'));
const api = await readFile('api/chat.js', 'utf8');
const worker = await readFile('sw.js', 'utf8');

const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
assert.ok(inlineScripts.length > 0, 'index.html must contain an application script');
for (const script of inlineScripts) new Function(script);

new Function(api.replace('module.exports = async function handler', 'async function handler'));
new Function(worker);

assert.equal(manifest.lang, 'ar');
assert.equal(manifest.dir, 'rtl');
assert.ok(manifest.icons.some(icon => icon.src === '/icon.svg'));
assert.equal(vercel.functions?.['api/chat.js']?.maxDuration, 30);
assert.ok(api.includes('process.env.GEMINI_API_KEY'), 'Gemini key must be read server-side');
assert.ok(!html.includes('GEMINI_API_KEY'), 'Gemini key must not appear in browser HTML');
assert.ok(html.includes("fetch('/api/chat'"), 'Frontend must call the chat API route');
assert.ok(html.includes("navigator.serviceWorker.register('/sw.js')"), 'Service worker must be registered');

const markup = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '');
const opened = (markup.match(/<div\b/gi) || []).length;
const closed = (markup.match(/<\/div>/gi) || []).length;
assert.equal(opened, closed, 'div elements must be balanced');

console.log('Portal validation passed.');
