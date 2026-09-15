import type { Page } from 'playwright';

const SOLVER_URL = process.env.CAPTCHA_SOLVER_URL ?? 'http://127.0.0.1:5001';

// TikTok / Douyin use the same secsdk CAPTCHA library
const SEL = {
  container:   '#captcha_container, [class*="captcha-verify-container"], [id*="captcha-verify"]',
  imgs:        '#captcha_container img, [class*="captcha-verify"] img, [class*="secsdk-captcha"] img',
  dragIcon:    '.secsdk-captcha-drag-icon, [class*="drag-icon"], [class*="captcha-slider-icon"]',
  dragBar:     '[class*="cap-bg-UISheetGrouped"], .secsdk-captcha-drag-bar, [class*="drag-bar"], [class*="captcha_verify_slide"], [class*="captcha-slider--slider"], [class*="slide-bar"]',
  rotateOuter: '[class*="rotate"][class*="outer"] img, [class*="captcha-verify-rotate-outer"]',
  rotateInner: '[class*="rotate"][class*="inner"] img, [class*="captcha-verify-rotate-inner"]',
};

async function isSolverRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${SOLVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function screenshotB64(page: Page, sel: string, nth = 0): Promise<string | null> {
  try {
    const loc = page.locator(sel);
    if (await loc.count() <= nth) return null;
    const buf = await loc.nth(nth).screenshot({ timeout: 5000 });
    return buf.toString('base64');
  } catch { return null; }
}

async function callSolver(endpoint: string, body: object): Promise<Record<string, unknown>> {
  const res = await fetch(`${SOLVER_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Solver /${endpoint} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function humanDrag(page: Page, fromX: number, fromY: number, distance: number) {
  await page.mouse.move(fromX, fromY);
  await page.waitForTimeout(150 + Math.random() * 100);
  await page.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const x = fromX + (distance * i) / steps;
    const y = fromY + Math.sin((i / steps) * Math.PI) * 3; // slight arc
    await page.mouse.move(x, y);
    await page.waitForTimeout(20 + Math.random() * 15);
  }
  await page.waitForTimeout(100);
  await page.mouse.up();
}

async function getDragStart(page: Page): Promise<{ x: number; y: number; barWidth: number; iconWidth: number } | null> {
  const icon = page.locator(SEL.dragIcon).first();
  const bar  = page.locator(SEL.dragBar).first();
  const iconBox = await icon.boundingBox({ timeout: 3000 }).catch(() => null);
  const barBox  = await bar.boundingBox({ timeout: 3000 }).catch(() => null);
  if (!iconBox) {
    console.warn('  [captcha] drag icon not found — selectors may need updating');
    return null;
  }

  const barWidth = barBox?.width ?? 348; // 348 = observed TikTok CAPTCHA bar width
  console.log(`  [captcha] icon=${JSON.stringify(iconBox)} bar=${JSON.stringify(barBox)} barWidth=${barWidth}`);
  return {
    x: iconBox.x + iconBox.width / 2,
    y: iconBox.y + iconBox.height / 2,
    barWidth,
    iconWidth: iconBox.width,
  };
}

async function solveRotation(page: Page): Promise<boolean> {
  const outer = await screenshotB64(page, SEL.rotateOuter)
             ?? await screenshotB64(page, SEL.imgs, 0);
  const inner = await screenshotB64(page, SEL.rotateInner)
             ?? await screenshotB64(page, SEL.imgs, 1);
  if (!outer || !inner) {
    console.warn('  [captcha] Cannot screenshot rotation images');
    return false;
  }
  const res    = await callSolver('rotate', { outer, inner });
  const angle  = res.angle as number;
  console.log(`  [captcha] Rotation angle: ${angle}°`);

  const drag = await getDragStart(page);
  if (!drag) return false;
  const distance = ((drag.barWidth - drag.iconWidth) * angle) / 360;
  await humanDrag(page, drag.x, drag.y, distance);
  return true;
}

async function solvePuzzle(page: Page): Promise<boolean> {
  const bg    = await screenshotB64(page, SEL.imgs, 0);
  const piece = await screenshotB64(page, SEL.imgs, 1);
  if (!bg || !piece) {
    console.warn('  [captcha] Cannot screenshot puzzle images');
    return false;
  }
  const res        = await callSolver('puzzle', { background: bg, piece });
  const proportion = res.proportion as number;
  console.log(`  [captcha] Puzzle slide proportion: ${proportion}`);

  const drag = await getDragStart(page);
  if (!drag) return false;
  await humanDrag(page, drag.x, drag.y, drag.barWidth * proportion);
  return true;
}

async function detectType(page: Page): Promise<'rotation' | 'puzzle'> {
  return page.evaluate((sels) => {
    const imgs = [...document.querySelectorAll(sels.imgs)] as HTMLImageElement[];
    if (imgs.some((img) => img.className.includes('rotate') || (img.src ?? '').includes('rotate')))
      return 'rotation';
    if (document.querySelector(sels.rotateOuter)) return 'rotation';
    // Rotation CAPTCHA: both images are square (w ≈ h).
    // Puzzle CAPTCHA: background is wide (width >> height).
    const first = imgs[0];
    if (first && first.naturalWidth > 0) {
      const ratio = first.naturalWidth / first.naturalHeight;
      if (ratio > 0.85 && ratio < 1.15) return 'rotation';
    }
    return 'puzzle';
  }, SEL).catch(() => 'puzzle' as const);
}

function isCaptchaVisible(page: Page): Promise<boolean> {
  return page.locator(SEL.container).first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);
}

export async function solveTikTokCaptcha(page: Page): Promise<boolean> {
  if (!await isSolverRunning()) {
    console.warn('  [captcha] Local solver not running at ' + SOLVER_URL + ' — start with: python captcha-solver/solver.py');
    return false;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!await isCaptchaVisible(page)) return true;
    console.log(`  [captcha] Attempt ${attempt}/3...`);
    try {
      const type   = await detectType(page);
      console.log(`  [captcha] Type detected: ${type}`);
      const solved = type === 'rotation'
        ? await solveRotation(page)
        : await solvePuzzle(page);
      if (!solved) break;
      await page.waitForTimeout(2500);
    } catch (err) {
      console.warn(`  [captcha] Attempt ${attempt} error: ${err}`);
      await page.waitForTimeout(1000);
    }
  }

  const solved = !await isCaptchaVisible(page);
  if (solved) console.log('  [captcha] Solved!');
  else        console.warn('  [captcha] Failed to solve — manual intervention needed');
  return solved;
}
