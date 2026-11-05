'use strict';
/**
 * 截图模式（RVD_SHOT=1）：把各个页面截成 png，用于发版前肉眼检查排版。
 * 输出到 RVD_SHOT_DIR，默认 <data>/shots。
 */
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');

async function capture(win) {
  const dir = process.env.RVD_SHOT_DIR || path.join(P.dataDir, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code, true);
    } catch (e) {
      console.error('JS 失败:', e.message.slice(0, 600));
      return null;
    }
  };

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
    return name;
  };

  await sleep(1200);
  await shot('01-work');

  await js(`window.__rvd.setStep(2); true`);
  await sleep(400);
  await shot('02-options');

  await js(`window.__rvd.onTaskEvent({
    type:'start', state:{video:'E:/AIGC/_test/sample.mp4', outDir:'E:/data/output/sample', phase:'probe', percent:3, vlmOn:true}
  }); window.__rvd.onTaskEvent({type:'phase', state:{phase:'classify', percent:52, shotsDone:3, shotsTotal:8, vlmOn:true}}); true`);
  await sleep(400);
  await shot('03-running');

  const bdPath = process.env.RVD_SHOT_BREAKDOWN || path.join(P.worksDir, 'sample', 'breakdown.json');
  let demo = null;
  if (fs.existsSync(bdPath)) {
    const { Runner } = require('./runner');
    demo = new Runner(() => {}).collect(path.dirname(bdPath), null, { runId: 'demo' });
  }
  if (demo) {
    await js(`(() => { window.__rvd.S.result = ${JSON.stringify(demo)}; window.__rvd.renderResult(${JSON.stringify(demo)}); window.__rvd.setStep(4); return 'ok'; })()`);
  } else {
    await js(`window.__rvd.setStep(4); true`);
  }
  await sleep(600);
  await shot('04-result');

  await js(`window.__rvd.goPage('history'); true`);
  await sleep(700);
  await shot('05-history');

  await js(`window.__rvd.goPage('env'); true`);
  await sleep(500);
  await shot('06-env');

  await js(`window.__rvd.goPage('settings'); true`);
  await sleep(400);
  await shot('07-settings');

  await js(`window.__rvd.goPage('about'); true`);
  await sleep(300);
  await shot('08-about');

  console.log('SHOTS ' + dir);
  return dir;
}

module.exports = { capture };
