// scraper/ace-mitchell.mjs against canned replies, no network.
//   node --test tests/ace-mitchell.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseItemCodes, buildUrl, authHeader, parseResponse, checkStock, BATCH_SIZE } from '../scraper/ace-mitchell.mjs';

const REPLY = `<?xml version="1.0" encoding="UTF-8"?>
<PriceAndAvailabilityResponse>
  <Item><ItemCode>DX100 10</ItemCode><NetPrice>59.95</NetPrice><SalesDescription>Mens Shoe Black &amp; Gray 10</SalesDescription>
    <DisplayName>Mens Shoe Black &amp; Gray 10</DisplayName><UPCCode>12345678901</UPCCode><ParentClass_Category>Shoes</ParentClass_Category>
    <Availability><OH>3</OH><NY>0</NY><TN>1</TN><Total>4</Total></Availability></Item>
  <Item><ItemCode>BG200</ItemCode><NetPrice>40</NetPrice><SalesDescription>Single Tote</SalesDescription><DisplayName></DisplayName>
    <UPCCode>999</UPCCode><ParentClass_Category>Bags</ParentClass_Category>
    <Availability><OH>0</OH><NY>0</NY><TN>0</TN><Total>0</Total></Availability></Item>
  <Item><ItemCode>BR157 12</ItemCode><Error>The item with item code [BR157 12] could not be found</Error></Item>
</PriceAndAvailabilityResponse>`;

test('parses list file codes', () => {
  assert.deepEqual(parseItemCodes('# note\nBR157  12\nBG200, dx100 10 # shoe\n\nbr157 12'), ['BR157 12', 'BG200', 'dx100 10']);
});

test('url encodes spaces and keeps commas; role only when given', () => {
  assert.match(buildUrl(['BR157 12', 'BG200']), /itemCodes=BR157%2012,BG200$/);
  assert.match(authHeader('a@b.com', 'pw'), /nlauth_email=a@b\.com, nlauth_signature=pw$/);
  assert.match(authHeader('a@b.com', 'pw', '1005'), /nlauth_signature=pw, nlauth_role=1005$/);
});

test('parses found items and errors', () => {
  const { found, errors } = parseResponse(REPLY);
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], {
    item_code: 'DX100 10', display_name: 'Mens Shoe Black & Gray 10', sales_description: 'Mens Shoe Black & Gray 10',
    upc: '12345678901', category: 'Shoes', net_price: 59.95, qty_oh: 3, qty_ny: 0, qty_tn: 1, qty_total: 4,
  });
  assert.equal(found[1].display_name, 'Single Tote');
  assert.deepEqual(errors, [{ item_code: 'BR157 12', error: 'The item with item code [BR157 12] could not be found' }]);
});

test('a login error page throws instead of saving nothing', () => {
  assert.throws(() => parseResponse('{"error":{"code":"INVALID_LOGIN_CREDENTIALS"}}'), /Unexpected reply/);
});

test('batches requests', async () => {
  const codes = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => `X${i}`);
  const urls = [];
  const fetchImpl = async (url, opts) => {
    urls.push(url);
    assert.match(opts.headers.Authorization, /nlauth_signature=p$/);
    return { ok: true, text: async () => '<PriceAndAvailabilityResponse></PriceAndAvailabilityResponse>' };
  };
  await checkStock(codes, { email: 'e', password: 'p', fetchImpl, log: () => {} });
  assert.equal(urls.length, 2);
});

test('needs credentials', async () => {
  await assert.rejects(checkStock(['A'], {}), /must be set/);
});
