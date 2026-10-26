import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { setup } from './fixtures.mjs';

test('筛选、分组与返回保留条件；请求使用原有认证', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings');
  await expect(page.locator('.recordings-row')).toHaveCount(18);
  await page.getByLabel('处理状态',{exact:true}).selectOption('failed');
  await expect(page.locator('.recordings-row')).toHaveCount(1);
  await page.getByRole('link',{name:'项目会议 1',exact:true}).click();
  await expect(page.getByRole('heading',{name:'项目会议 1',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'返回录音库',exact:true}).click();
  await expect(page.getByLabel('处理状态',{exact:true})).toHaveValue('failed');
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();
  await page.getByLabel('搜索录音',{exact:true}).fill('不存在的会议');
  await expect(page.getByText('当前条件没有匹配的录音。')).toBeVisible();
  await page.getByLabel('搜索录音',{exact:true}).fill('远川');
  await expect(page.locator('.recordings-row')).toHaveCount(1);
  expect(f.requests.filter(r=>r.path==='/api/recordings').every(r=>r.auth==='Bearer fixture-token')).toBe(true);
  expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});

test('当前正文、历史版本、真实文件下载和时间戳播放', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings/rec-0');
  await expect(page.getByText('确认试用范围，保留原有数据与权限。')).toBeVisible();
  await page.getByLabel('纪要版本',{exact:true}).selectOption('summary-1');
  await expect(page.getByText('这是第一版内容。')).toBeVisible();
  const downloaded=page.waitForEvent('download');
  await page.getByRole('link',{name:'导出纪要 v1',exact:true}).click();
  const download=await downloaded;
  expect(await fs.readFile(await download.path(),'utf8')).toContain('第一版内容');
  await expect(page.getByRole('link',{name:'导出纪要 v1',exact:true})).toHaveAttribute('href','/api/recordings/rec-0/export/summaries/summary-1.md?token=fixture-token');
  await page.getByRole('button',{name:'返回当前版本'}).click();
  await page.getByRole('button',{name:'播放 00:01 的发言'}).click();
  await expect.poll(()=>page.locator('.record-audio audio').evaluate(el=>el.currentTime)).toBeGreaterThanOrEqual(1);
  expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});

test('AI 改写先预览；取消不生效，确认一次并保留旧版本', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings/rec-0');
  await page.locator('.record-revise > summary').click();
  await page.getByLabel('纪要修改要求').fill('按议题整理');
  await page.getByRole('button',{name:'生成改写预览',exact:true}).click();
  await expect(page.getByRole('heading',{name:'改写预览 · 待你确认'})).toBeFocused();
  await expect(page.getByLabel('纪要版本',{exact:true})).toHaveValue('summary-2');
  expect(f.requests.filter(r=>r.path.endsWith('/revise/apply'))).toHaveLength(0);
  await page.getByRole('button',{name:'取消改写',exact:true}).click();
  await expect(page.getByLabel('纪要修改要求')).toBeFocused();
  await expect(page.getByText('修改后纪要',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'生成改写预览',exact:true}).click();
  await page.locator('.revision-preview > details > summary').click();
  await expect(page.locator('.revision-preview details')).toContainText('确认试用范围');
  await page.getByRole('button',{name:'确认应用改写',exact:true}).dblclick();
  await expect(page.getByLabel('纪要版本',{exact:true})).toHaveValue('summary-3');
  await page.getByLabel('纪要版本',{exact:true}).selectOption('summary-2');
  await expect(page.getByText('确认试用范围，保留原有数据与权限。')).toBeVisible();
  expect(f.requests.filter(r=>r.path.endsWith('/revise/apply'))).toHaveLength(1);
  expect(JSON.parse(f.requests.find(r=>r.path.endsWith('/revise/apply')).body)).toEqual({draft_id:'draft-1'});
  expect(f.requests.filter(r=>r.path.endsWith('/summary/revise'))).toHaveLength(0);
});

test('改写确认失败保留预览，重试后生效', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings/rec-0');
  await page.locator('.record-revise > summary').click();
  await page.getByLabel('纪要修改要求').fill('按议题整理');
  await page.getByRole('button',{name:'生成改写预览',exact:true}).click();
  f.state.apiError='/api/recordings/rec-0/summary/revise/apply';
  await page.getByRole('button',{name:'确认应用改写',exact:true}).click();
  await expect(page.getByText('测试请求失败，重试后继续。')).toBeVisible();
  await expect(page.getByRole('heading',{name:'改写预览 · 待你确认'})).toBeVisible();
  await expect(page.getByLabel('纪要版本',{exact:true})).toHaveValue('summary-2');
  f.state.apiError='';
  await page.getByRole('button',{name:'确认应用改写',exact:true}).click();
  await expect(page.getByLabel('纪要版本',{exact:true})).toHaveValue('summary-3');
});

test('未生成内容的阶段隐藏；来源链接和快捷键帮助可用', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings/rec-3');
  await expect(page.locator('#record-summary,#record-transcript,#record-emotion')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'开始处理',exact:true})).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog',{name:'键盘快捷键'})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/app/recordings/rec-0');
  await page.locator('#record-summary > .record-source').getByRole('link',{name:'查看逐字稿依据'}).click();
  await expect(page).toHaveURL(/#record-transcript$/);
  await page.locator('.record-revise > summary').click();
  await page.getByLabel('纪要修改要求').fill('?');
  await expect(page.getByRole('dialog',{name:'键盘快捷键'})).not.toBeVisible();
  expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('纪要失败只重试纪要，并跟踪排队后的结果', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings/rec-1');
  await page.getByRole('button',{name:'重试纪要',exact:true}).click();
  await expect(page.getByRole('button',{name:'等待处理',exact:true})).toBeDisabled();
  await expect(page.getByRole('link',{name:'导出纪要',exact:true})).toBeVisible({timeout:15000});
  expect(f.requests.filter(r=>r.path.endsWith('/summarize'))).toHaveLength(1);
  expect(f.requests.filter(r=>r.path.endsWith('/process'))).toHaveLength(0);
});

test('完成但空正文提示错误；处理与权限错误可见', async ({page}) => {
  const f=await setup(page,{emptySummary:true});
  await page.goto('/app/recordings/rec-0');
  await expect(page.getByText('纪要正文缺失',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'重试纪要',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'导出纪要',exact:true})).toHaveCount(0);
  f.state.apiError='/api/recordings/rec-0/summarize';
  await page.getByRole('button',{name:'重试纪要',exact:true}).click();
  await expect(page.getByText('测试请求失败，重试后继续。')).toBeVisible();
});

test('整条重新处理必须确认，取消不会发送请求', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings/rec-0');
  await page.locator('.record-advanced > summary').click();
  await page.getByRole('button',{name:'重新处理整条录音',exact:true}).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  expect(f.requests.filter(r=>r.path.endsWith('/process'))).toHaveLength(0);
  await page.getByRole('button',{name:'重新处理整条录音',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'重新处理',exact:true}).click();
  await expect(page.getByRole('button',{name:'处理中',exact:true})).toBeDisabled();
  expect(f.requests.filter(r=>r.path.endsWith('/process'))).toHaveLength(1);
});

test('上传保留全部字段；失败可重试，关闭自动处理文案一致', async ({page}) => {
  const f=await setup(page,{uploadError:true});
  await page.goto('/app/recordings/new');
  await page.locator('input[type=file]').setInputFiles({name:'meeting.wav',mimeType:'audio/wav',buffer:Buffer.from('fixture')});
  await page.getByLabel(/^标题/).fill('上传验证');
  await page.getByLabel(/^客户 \/ 项目/).fill('测试项目');
  await page.getByLabel(/^预计说话人数/).fill('3');
  await page.getByLabel('上传后立即开始转写').uncheck();
  await page.getByRole('button',{name:'上传录音',exact:true}).click();
  await expect(page.getByText('上传测试失败')).toBeVisible();
  await expect(page.getByLabel(/^标题/)).toHaveValue('上传验证');
  f.state.uploadError=false;
  await page.getByRole('button',{name:'上传录音',exact:true}).click();
  await expect(page.getByRole('heading',{name:'上传验证',exact:true})).toBeVisible();
  const body=f.requests.filter(r=>r.path==='/api/recordings'&&r.method==='POST').at(-1).body;
  expect(body).toContain('name="expected_speakers"\r\n\r\n3');
  expect(body).toContain('name="auto_process"\r\n\r\nfalse');
  expect(body).toContain('测试项目');
  expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});

test('说话人命名保持长片段建声纹和短片段仅命名的契约', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings/rec-0');
  await page.locator('.record-speakers').getByRole('button',{name:'林悦',exact:true}).click();
  await page.getByLabel('说话人姓名').fill('林悦新姓名');
  await page.getByLabel('说话人姓名').press('Enter');
  await expect(page.locator('.record-speakers').getByRole('button',{name:'林悦新姓名',exact:true})).toBeVisible();
  await page.locator('.record-speakers').getByRole('button',{name:'Speaker 2',exact:true}).click();
  await page.getByLabel('说话人姓名').fill('陈言');
  await page.getByLabel('说话人姓名').press('Enter');
  await expect(page.locator('.record-speakers').getByRole('button',{name:'陈言',exact:true})).toBeVisible();
  expect(f.requests.filter(r=>r.path==='/api/voiceprints/from-recording')).toHaveLength(1);
  expect(f.requests.filter(r=>r.path==='/api/recordings/rec-0/speakers/2')).toHaveLength(1);
});

test('情绪分析和历史抽屉保留，Esc 恢复焦点', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings/rec-0');
  await page.getByRole('button',{name:'生成情绪分析',exact:true}).click();
  await page.locator('#record-emotion summary').click();
  await expect(page.getByText('交流平稳。')).toBeVisible();
  await page.locator('.record-history > summary').click();
  const trigger=page.locator('.record-history').getByRole('button').filter({hasText:'会议纪要 v1'});
  await trigger.click();
  await expect(page.getByRole('button',{name:'关闭预览'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'关闭预览'})).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});

test('热词保存、声纹删除确认与成员权限边界', async ({page}) => {
  const f=await setup(page,{role:'member'});
  await page.goto('/app/recordings?scope=team');
  await expect(page.locator('.recordings-row')).toHaveCount(9);
  await expect(page.getByRole('group',{name:'可见范围'})).toHaveCount(0);
  expect(f.requests.filter(r=>r.path==='/api/recordings').every(r=>r.search.includes('scope=mine'))).toBe(true);
  await page.goto('/app/hotwords');
  await page.getByLabel('热词列表（用顿号「、」分隔）').fill('新术语、客户名');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByText('已保存，共 2 个热词。')).toBeVisible();
  await page.goto('/app/voiceprints');
  await expect(page.getByRole('button',{name:'删除',exact:true})).toHaveCount(1);
  await page.getByRole('button',{name:'删除',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
  expect(f.requests.filter(r=>r.method==='DELETE')).toHaveLength(0);
  await page.goto('/admin/users');
  await expect(page).not.toHaveURL(/\/admin\/users$/);
  expect(f.requests.filter(r=>r.path==='/api/users')).toHaveLength(0);
});

test('主题持久化、命令搜索、手机导航与键盘关闭', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings');
  await page.getByRole('button',{name:'切换深色 / 浅色主题',exact:true}).click();
  await expect(page.locator('html')).toHaveClass('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveClass('dark');
  await page.keyboard.press('Control+k');
  await page.getByLabel('搜索命令',{exact:true}).fill('前往 热词');
  await page.getByLabel('搜索命令',{exact:true}).press('Enter');
  await expect(page).toHaveURL(/\/app\/hotwords$/);
  await page.setViewportSize({width:390,height:900});
  const trigger=page.getByRole('button',{name:'展开导航',exact:true});
  await trigger.click();
  await expect(page.getByRole('navigation',{name:'主导航'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation',{name:'主导航'})).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(f.errors).toEqual([]);
});

for (const width of [1440,1024,390,320]) for(const theme of ['light','dark']) {
  test('列表与详情布局 '+width+' '+theme, async ({page},testInfo) => {
    const f=await setup(page);
    await page.setViewportSize({width,height:900});
    await page.addInitScript(value=>localStorage.setItem('voice.theme',value),theme);
    await page.goto('/app/recordings');
    await expect(page.locator('.recordings-row')).toHaveCount(18);
    await page.evaluate(()=>document.fonts.ready);
    const measure=await page.locator('.recordings-page').evaluate(el=>({
      scroll:el.scrollWidth,client:el.clientWidth,
      visible:[...el.querySelectorAll('.recordings-row')].filter(row=>row.getBoundingClientRect().bottom<=900).length,
      row:el.querySelector('.recordings-row').getBoundingClientRect().height,
    }));
    expect(measure.scroll).toBeLessThanOrEqual(measure.client+1);
    if(width===1440){expect(measure.visible).toBeGreaterThanOrEqual(14);expect(measure.row).toBe(44);}
    await page.screenshot({path:testInfo.outputPath('list.png')});
    await page.getByRole('link',{name:'远川制造 · 需求调研',exact:true}).click();
    await expect(page.getByRole('heading',{name:'远川制造 · 需求调研',exact:true})).toBeVisible();
    expect(await page.locator('.record-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    if(width===1440) expect(await page.locator('.record-properties').evaluate(el=>el.getBoundingClientRect().width)).toBe(288);
    await page.screenshot({path:testInfo.outputPath('detail.png')});
    expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
  });
}

for (const role of ['member','admin']) test('全站页面烟雾检查 '+role, async({page},testInfo)=>{
  const f=await setup(page,{role});
  const paths=role==='admin'?['overview','users','teams','permissions','wecom','audit','voiceprints','hotword','llm'].map(p=>'/admin/'+p):['/app/recordings/new','/app/hotwords','/app/voiceprints','/app/integrations'];
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    for(const path of paths) {
      await page.goto(path);
      await expect(page.locator('.page-head__title')).toBeVisible();
      await page.waitForTimeout(200);
      expect(await page.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth+1),path+' '+width).toBe(true);
      if(width===390) await page.screenshot({path:testInfo.outputPath(path.replaceAll('/','-')+'.png')});
    }
  }
  expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});


test('登录过期与首次改密仍受保护，手机表单可用', async ({page}) => {
  const f=await setup(page,{role:'member',expired:true,mustChangePassword:true});
  await page.setViewportSize({width:390,height:900});
  await page.goto('/app/recordings');
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByLabel('用户名 / 邮箱 / 手机号').fill('test-user');
  await page.getByLabel('密码',{exact:true}).fill('fixture-password');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page).toHaveURL(/\/auth\/change-password$/);
  await page.getByLabel('当前密码',{exact:true}).fill('fixture-password');
  await page.getByLabel('新密码',{exact:true}).fill('fixture-new-password');
  await page.getByLabel('再输入一次',{exact:true}).fill('fixture-new-password');
  await page.getByRole('button',{name:'保存新密码',exact:true}).click();
  await expect(page).toHaveURL(/\/app\/recordings\/new$/);
  expect(f.requests.filter(r=>r.path==='/api/auth/change-password')).toHaveLength(1);
  expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});

test('退出登录清除会话且返回受保护页面需要重新登录', async ({page}) => {
  const f=await setup(page);
  await page.goto('/app/recordings');
  await page.getByRole('link',{name:'远川制造 · 需求调研',exact:true}).click();
  await page.getByRole('button',{name:'账号菜单',exact:true}).click();
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(()=>localStorage.getItem('newvoice.token'))).toBeNull();
  expect(f.requests.filter(r=>r.path==='/api/auth/logout')).toHaveLength(1);
  // Client-side navigation does not re-run the fixture's authentication seed.
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
  expect(f.errors).toEqual([]);
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`改写预览布局 ${width} ${theme}`, async ({page}, testInfo) => {
    await setup(page);
    await page.setViewportSize({width,height:900});
    await page.addInitScript(value=>localStorage.setItem('voice.theme',value),theme);
    await page.goto('/app/recordings/rec-0');
    await page.locator('.record-revise > summary').click();
    await page.getByLabel('纪要修改要求').fill('按议题整理，并列出负责人和下一步。');
    await page.getByRole('button',{name:'生成改写预览',exact:true}).click();
    await expect(page.getByRole('heading',{name:'改写预览 · 待你确认'})).toBeVisible();
    await expect(page.locator('#main .btn--primary:visible')).toHaveCount(1);
    await expect(page.locator('#main .btn--primary:visible')).toHaveText('确认应用改写');
    await page.locator('.revision-preview > details > summary').click();
    await expect(page.locator('.revision-preview')).toContainText('确认试用范围');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('revision-preview.png'),fullPage:true,animations:'disabled'});
  });
}
