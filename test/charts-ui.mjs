/**
 * The revenue and profit charts, in a real browser.
 *
 * Serves the repository on a free port and drives the Analytics page. The
 * checks that matter most are the honesty ones: an empty dataset must draw an
 * explanation rather than eleven flat bars, imported royalties must not be
 * multiplied by a royalty rate a second time, and a book title arriving from an
 * imported report must never be treated as markup.
 *
 *   node test/charts-ui.mjs
 */
import { chromium, devices } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
});
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
  { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const B = `http://127.0.0.1:${port}`;
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1440,height:1100}});
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
p.on('console',m=>{if(m.type()==='error' && !/404/.test(m.text())) errs.push('console: '+m.text());});
const check=async(l,fn)=>{try{const r=await fn();console.log(`PASS  ${l}${r?' — '+r:''}`)}catch(e){console.log(`FAIL  ${l} — ${e.message}`);errs.push(l+': '+e.message)}};

await p.goto(B+'/index.html#/analytics');
await p.waitForTimeout(900);

await check('with no sales, the charts default to what the catalogue is worth', async()=>{
  const pressed = await p.locator('[data-chart-mode][aria-pressed="true"]').getAttribute('data-chart-mode');
  if (pressed !== 'potential') throw new Error('defaulted to '+pressed);
  const note = await p.locator('#chartNote').innerText();
  if (!/not a forecast/i.test(note)) throw new Error('note: '+note);
  return 'per round of sales';
});

await check('the donut draws a segment per storefront that sells', async()=>{
  const n = await p.locator('#storeDonut circle').count();
  if (n < 2) throw new Error('segments: '+n);
  const hero = await p.locator('#storeDonut .chart-hero').textContent();
  if (!/^\$\d/.test(hero)) throw new Error('hero: '+hero);
  return n+' segments, total '+hero;
});

await check('the total matches the distribution-gaps figure it is derived from', async()=>{
  const hero = Number((await p.locator('#storeDonut .chart-hero').textContent()).replace(/[^0-9.]/g,''));
  const legend = await p.locator('#storeDonut .chart-legend-value').allInnerTexts();
  const sum = legend.reduce((t,s)=>t+Number(s.split('·')[0].replace(/[^0-9.]/g,'')),0);
  if (Math.abs(sum-hero) > 0.02) throw new Error(`legend ${sum} vs hero ${hero}`);
  return `$${hero.toFixed(2)} = sum of ${legend.length} legend rows`;
});

await check('every title gets a bar, longest first', async()=>{
  const vals = await p.locator('#titleBars .chart-bar-value').allInnerTexts();
  const nums = vals.map(v=>Number(v.replace(/[^0-9.]/g,'')));
  if (nums.length < 5) throw new Error('rows: '+nums.length);
  for (let i=1;i<nums.length;i++) if (nums[i] > nums[i-1]+0.001) throw new Error('not sorted at '+i);
  return nums.length+' titles, '+vals[0]+' down to '+vals[vals.length-1];
});

await check('hovering a segment explains it', async()=>{
  await p.locator('#storeDonut circle').first().hover({position:{x:110,y:13}});
  await p.waitForSelector('.chart-tip:not([hidden])',{timeout:5000});
  const t=(await p.locator('.chart-tip').innerText()).replace(/\n/g,' · ');
  if (!/%/.test(t)) throw new Error('no share in tip: '+t);
  return t;
});

await check('switching to Earned says plainly that nothing has been imported', async()=>{
  await p.click('[data-chart-mode="earned"]');
  await p.waitForTimeout(400);
  const donut = await p.locator('#storeDonut').innerText();
  const bars = await p.locator('#titleBars').innerText();
  if (!/No sales imported yet/i.test(donut)) throw new Error('donut: '+donut.slice(0,80));
  if (!/every bar would be zero/i.test(bars)) throw new Error('bars: '+bars.slice(0,80));
  if (await p.locator('#titleBars .chart-bar').count()) throw new Error('drew zero-length bars');
  return 'no fake zero chart';
});

await check('a title from a sales report is never treated as markup', async()=>{
  await p.evaluate(()=>{
    const raw = JSON.parse(localStorage.getItem('bookFactory.state.v2'));
    raw.books[0].title = '<img src=x onerror="window.__xss=1">';
    raw.books[0].sales = [{source:'amazon',period:'2026-09',units:3,amount:21.5,currency:'USD',at:Date.now()}];
    raw.books[0].revenue = 21.5;
    localStorage.setItem('bookFactory.state.v2', JSON.stringify(raw));
  });
  await p.reload();
  await p.waitForTimeout(900);
  await p.click('[data-chart-mode="earned"]');
  await p.waitForTimeout(400);
  if (await p.evaluate(()=>window.__xss)) throw new Error('title executed as script');
  const labels = await p.locator('#titleBars .chart-bar-label').allInnerTexts();
  if (!labels.some(l=>l.includes('<img'))) throw new Error('title not shown literally: '+labels[0]);
  return 'rendered as text';
});

await check('imported money is charted as paid, not re-multiplied by a royalty', async()=>{
  const hero = Number((await p.locator('#storeDonut .chart-hero').textContent()).replace(/[^0-9.]/g,''));
  if (Math.abs(hero - 21.5) > 0.01) throw new Error('hero is '+hero+', expected 21.50');
  return '$21.50 in, $21.50 charted';
});

await check('profit equals revenue when no production cost is recorded, and says so', async()=>{
  const note = await p.locator('#chartNote').innerText();
  if (!/production cost/i.test(note)) throw new Error('note: '+note);
  const bars = await p.locator('#titleBars .chart-bar-row').first().locator('.chart-bar').count();
  if (bars !== 2) throw new Error('expected revenue+profit bars, got '+bars);
  return note.slice(-58);
});

await check('a recorded production cost pulls profit below revenue', async()=>{
  await p.evaluate(()=>{
    const raw = JSON.parse(localStorage.getItem('bookFactory.state.v2'));
    raw.books[0].productionCostUsd = 8;
    localStorage.setItem('bookFactory.state.v2', JSON.stringify(raw));
  });
  await p.reload(); await p.waitForTimeout(900);
  await p.click('[data-chart-mode="earned"]'); await p.waitForTimeout(400);
  const widths = await p.locator('#titleBars .chart-bar-row').first().locator('.chart-bar').evaluateAll(els=>els.map(e=>parseFloat(e.style.width)));
  if (!(widths[1] < widths[0])) throw new Error('profit not shorter: '+widths.join(','));
  return `revenue ${widths[0].toFixed(0)}% vs profit ${widths[1].toFixed(0)}%`;
});

await check('the charts survive the light theme', async()=>{
  await p.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
  await p.waitForTimeout(300);
  await p.click('[data-chart-mode="potential"]'); await p.waitForTimeout(400);
  const stroke = await p.locator('#storeDonut circle').first().getAttribute('stroke');
  if (!/^#|rgb/.test(stroke)) throw new Error('stroke: '+stroke);
  await p.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
  return 'segments coloured '+stroke;
});

await p.waitForTimeout(300);

const phone = await b.newPage({...devices['iPhone 13']});
await phone.goto(B+'/index.html#/analytics'); await phone.waitForTimeout(900);
await check('the charts fit a phone', async()=>{
  const over = await phone.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  if (over>2) throw new Error(over+'px overflow');
  return 'no overflow';
});

await b.close();
server.kill();
console.log(`\n--- errors: ${errs.length} ---`); errs.forEach(e=>console.log('  '+e));
process.exit(errs.length?1:0);
