import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Regression checks for honest feature availability and keyboard usability.
const html = await readFile('index.html', 'utf8');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const vercel = JSON.parse(await readFile('vercel.json', 'utf8'));
const api = await readFile('api/chat.js', 'utf8');
const worker = await readFile('sw.js', 'utf8');
const football = await readFile('football.js', 'utf8');
const footballCss = await readFile('football.css', 'utf8');
const footballBackend = await readFile('supabase/functions/football-data/index.ts', 'utf8');

const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
assert.ok(inlineScripts.length > 0, 'index.html must contain an application script');
for (const script of inlineScripts) new Function(script);

new Function(api.replace('module.exports = async function handler', 'async function handler'));
new Function(worker);
new Function(football);

assert.equal(manifest.lang, 'ar');
assert.equal(manifest.dir, 'rtl');
assert.ok(manifest.icons.some(icon => icon.src === 'icon.svg'));
assert.equal(vercel.functions?.['api/chat.js']?.maxDuration, 30);
assert.ok(api.includes('process.env.GEMINI_API_KEY'), 'Gemini key must be read server-side');
assert.ok(!html.includes('GEMINI_API_KEY'), 'Gemini key must not appear in browser HTML');
assert.ok(html.includes("fetch('api/chat'"), 'Frontend must call the chat API route');
assert.ok(html.includes("navigator.serviceWorker.register('sw.js')"), 'Service worker must be registered');
assert.ok(html.includes('id="football-world"') && html.includes('openFootballWorld()'), 'Football world must be integrated into the portal');
assert.ok(html.includes('football.css') && html.includes('football.js'), 'Football assets must be linked');
assert.ok(football.includes('functions/v1/football-data'), 'Football data must use the protected Supabase Edge Function');
assert.ok(football.includes('loadMatchExtra'), 'Advanced match data must load on demand to conserve quota');
assert.ok(football.includes('data-action="match-extra"'), 'Match extras must be individually selectable');
assert.ok(football.includes('sb_publishable_'), 'Only a public publishable key may be present in the browser');
assert.ok(!football.includes('API_FOOTBALL_KEY') && !football.includes('SUPABASE_SERVICE_ROLE_KEY'), 'Server secrets must not appear in browser JavaScript');
assert.ok(footballCss.includes('.football-world'), 'Football styles must be present');
assert.ok(footballBackend.includes('FOOTBALL_PROVIDER_SUSPENDED'), 'Backend must block a suspended provider');
assert.ok(footballBackend.includes('provider_blocked'), 'Backend must use persistent provider block state');
assert.ok(footballBackend.includes('fixtures'), 'Backend must retain the fixtures data route');
assert.ok(!football.includes('x-apisports-key'), 'Browser must never call API-Football directly');
assert.ok(!html.includes('user_points') && !html.includes('checkDailyBonus'), 'No fake browser-only reward balance may be presented');
assert.ok(html.includes("event.key === 'Enter'"), 'AI input should support Enter to submit');
assert.ok(html.includes('لا يجري هذا القسم فحصاً تقنياً مباشراً'), 'Security section must not claim live URL scanning');

const markup = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '');
const opened = (markup.match(/<div\b/gi) || []).length;
const closed = (markup.match(/<\/div>/gi) || []).length;
assert.equal(opened, closed, 'div elements must be balanced');

console.log('Portal validation passed.');
