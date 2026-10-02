// Optional browser smoke test. Uses synthetic data and intercepts every request.
// Resolve Playwright from the normal install or the Codex runtime.
const { chromium } = require(require.resolve('playwright', {paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean)}));
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1600,height:1000}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const now = new Date(), date = now.toISOString().slice(0,10);
    const quarter = `${now.getFullYear()} Q${Math.floor(now.getMonth()/3)+1}`;
    const order = {id:'11111111-1111-4111-8111-111111111111', customer_name:'Stock', is_stock:true,
      item:'Sample Ball', quantity:1, shop_order_date:date, quarter, submitted_at:date,
      pickup_location:'Valley', drilled:false, out_the_door:false, no_drill_needed:false};
    const appts = [], hours = [], writes = [];
    let failUpdate = false;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), req = route.request();
      if (url.pathname.includes('/rest/v1/')) {
        const table = url.pathname.split('/').pop();
        let rows = table === 'orders' ? [order] : table === 'hours' ? hours : table === 'appointments' ? appts : [];
        if (req.method() === 'PATCH') {
          const patch = req.postDataJSON();
          if (failUpdate) return route.fulfill({status:500,body:'Test save failure'});
          writes.push({table,patch}); Object.assign(order,patch); rows = [order];
        } else if (req.method() === 'POST') {
          const data = req.postDataJSON();
          rows = (Array.isArray(data) ? data : [data]).map((r,i) => ({id:`booking-${i}`, ...r}));
          if (table === 'hours') hours.push(...rows);
          if (table === 'appointments') appts.push(...rows);
        } else if (table === 'orders') {
          if (url.searchParams.get('shop_order_date') === 'is.null') rows=[];
          if (url.searchParams.get('is_stock') === 'is.false' && order.is_stock) rows=[];
        }
        return route.fulfill({contentType:'application/json',body:JSON.stringify(rows)});
      }
      if (url.hostname === 'proshop.test') {
        const filename = path.join(__dirname,'..','app',url.pathname);
        return route.fulfill({body:fs.readFileSync(filename),contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'});
      }
      return route.abort();
    });
    await page.goto('https://proshop.test/index.html');
    const name = page.locator('td[data-label="Customer"] .cell');
    await name.click(); await name.locator('input').fill('Sample Customer');
    failUpdate=true;
    await name.locator('input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('500'));
    assert.equal(order.is_stock,true); assert.equal(order.customer_name,'Stock');
    failUpdate=false;
    await name.click(); await name.locator('input').fill('Sample Customer'); await name.locator('input').press('Enter');
    await page.waitForFunction(() => document.querySelector('td[data-label="Customer"] .cell').textContent === 'Sample Customer');
    assert.equal(order.is_stock,false);
    assert.deepEqual(writes[0].patch,{customer_name:'Sample Customer',is_stock:false});
    await page.locator("#hoursbtn").click();
    await page.locator("#hoursdlg[open] .hrow").first().waitFor();
    assert.equal(await page.locator('#hoursgrid .hrow').count(),28);
    await page.locator('#hoursx').click();
    await page.goto('https://proshop.test/drilling.html');
    await page.getByText('Not scheduled',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Schedule',exact:true}).click();
    await page.locator('#s_time').fill('14:00');
    await page.locator('#s_save').click();
    await page.getByText('Scheduled',{exact:true}).waitFor();
    assert.equal(appts[0].order_id,order.id);
    assert.match(await page.locator('td[data-label="Appointment"]').innerText(),/2p/);
    await page.goto('https://proshop.test/appointments.html');
    await page.locator('#add').click();
    await page.waitForFunction(() => !document.querySelector('#f_order').disabled);
    await page.locator('#f_order').selectOption(order.id);
    assert.equal(await page.locator('#f_name').inputValue(),'Sample Customer');
    assert.equal(await page.locator('#f_service').inputValue(),'Drill Sample Ball');
    await page.locator('#f_save').click();
    await page.waitForFunction(() => !document.querySelector('#dlg').open);
    assert.equal(appts[1].order_id,order.id);
    assert.deepEqual(errors,[]);
    console.log('PASS: failed/successful stock assignment, 28 hours rows, drilling booking/status, appointment order selector; no browser errors.');
  } finally { await browser.close(); }
})().catch(e => {console.error(e);process.exitCode=1;});
