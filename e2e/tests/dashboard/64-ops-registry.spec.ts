import { test, expect, Page } from '@playwright/test';
const NOW = new Date().toISOString();
const loc = { latitude: 36.2, longitude: 37.1, user_location_name: 'Area' };
const OPS = [
  { id: 'op-a', name: 'Aleppo Quake', place_name: 'Aleppo, SY', status: 'LIVE', is_active: true, health: 'RED', critical: 3, total: 4, incident_count: 3, new_24h: 2, responders_active: 2, center_lat: 36.2, center_lng: 37.1 },
  { id: 'op-b', name: 'Idlib Floods', place_name: 'Idlib, SY', status: 'LIVE', is_active: true, health: 'AMBER', critical: 1, total: 2, incident_count: 1, center_lat: 35.9, center_lng: 36.6 },
  { id: 'op-c', name: 'Homs Stable', place_name: 'Homs, SY', status: 'LIVE', is_active: true, health: 'GREEN', critical: 0, total: 1, incident_count: 1, center_lat: 34.7, center_lng: 36.7 },
];
const R = (id:string,op:string,b:string,n:string,s:string)=>({ id, severity:s, status:'PENDING', reviewer_verdict:'NOT_REVIEWED', crisis_type:'FLOOD', crisis_event_id:op, building_id:b, infrastructure_name:n, infrastructure_name_from_osm:true, infrastructure_type:'OTHER', source:'APP', server_created_at:NOW, location:{...loc}, media:[] });
const REPORTS=[R('r1','op-a','b1','Al-Razi Hospital','CRITICAL'),R('r2','op-a','b2','Central School','SEVERE'),R('r3','op-b','b3','Idlib Bridge','CRITICAL')];
async function boot(page:Page){
  await page.addInitScript(()=>{localStorage.setItem('crisp_token','e2e-fake-token');localStorage.setItem('crisp_user',JSON.stringify({role:'ADMIN',email:'ops@undp.org',full_name:'Ops'}));localStorage.setItem('crisp_router_force_root','1');});
  await page.route('**/api/v1/**',async(route)=>{const u=route.request().url();
    if(u.includes('/analytics/summary'))return route.fulfill({json:{counts:{},distributions:{},timings:{},impact:{},deltas:{}}});
    if(/\/operations(\?|$)/.test(u))return route.fulfill({json:OPS});
    if(u.includes('/reports/markers'))return route.fulfill({json:[]});
    if(u.includes('/reports/buildings-needing-review'))return route.fulfill({json:{buildings:[],total_buildings:0,total_pairs:0}});
    if(/\/reports\/?\?/.test(u)){const scoped=/crisis_event_id=/.test(u);const m=u.match(/crisis_event_id=(op-[a-c])/);const list=m?REPORTS.filter(r=>r.crisis_event_id===m[1]):REPORTS;return route.fulfill({status:200,headers:{'X-Total-Count':String(list.length)},json:list});}
    const s=u.match(/\/reports\/(r\d)(?:\?|$)/);if(s)return route.fulfill({json:REPORTS.find(r=>r.id===s[1])||{}});
    return route.fulfill({status:200,json:{}});});
  await page.goto('index.html');
  await page.waitForFunction(()=>Array.isArray((window as any).allReports),null,{timeout:15000});
}
test('operations registry renders as a tree in the console; op opens the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await boot(page);
  await page.evaluate(()=>{location.hash='#/operations';});
  // The registry renders in the feed panel (NOT the #cc-ops-overlay).
  const reg = page.locator('#report-feed-list .opg-reg-toolbar');
  await expect(reg).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#cc-ops-overlay.cc-ops-open')).toHaveCount(0);
  // 3 operation nodes (worst-first: RED, AMBER, GREEN).
  await expect(page.locator('#report-feed-list .opg-op')).toHaveCount(3);
  const names = await page.locator('#report-feed-list .opg-reg-opname').allTextContents();
  expect(names[0]).toContain('Aleppo');   // RED first
  // Expanding op-a reveals its buildings.
  const opA = page.locator('#report-feed-list .opg-op').filter({ hasText: 'Aleppo Quake' });
  await opA.locator('.opg-op-head').click();
  await expect(opA.locator('.cc-cluster').first()).toBeVisible({ timeout: 6000 });
  // Search filters.
  await page.locator('.opg-reg-search').fill('idlib');
  await expect(page.locator('#report-feed-list .opg-op')).toHaveCount(1);
  await page.locator('.opg-reg-search').fill('');
  // Clicking the op name opens the operation summary in the right panel.
  await page.locator('#report-feed-list .opg-op').filter({ hasText: 'Aleppo Quake' }).locator('.opg-reg-opname').click();
  await expect(page.locator('#detail-panel.detail-panel--operation')).toBeVisible({ timeout: 8000 });
  await page.locator('.feed-panel').screenshot({ path: 'test-results/ops-registry.png' });
});
