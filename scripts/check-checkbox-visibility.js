#!/usr/bin/env node
/**
 * Browser-rendered regression check for the Sync Options checkbox control.
 *
 * The dashboard has a global SVG sizing rule that previously collapsed the
 * Atlaskit Checkbox SVG to 0x0 inside its min-content grid column. This check
 * loads the real dashboard stylesheet and the real checkbox compiled stylesheet
 * in Chromium, verifies the visible 24px control, and writes a screenshot for
 * review.
 *
 * It is intentionally separate from Jest: Chromium layout is not available in
 * jsdom, and this check must fail closed if no browser is installed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = process.cwd();
const DASHBOARD_CSS = path.join(
  ROOT,
  'static/admin-page/src/dashboard/dashboard.css'
);
const CHECKBOX_CSS = path.join(
  ROOT,
  'static/admin-page/node_modules/@atlaskit/checkbox/dist/cjs/checkbox.compiled.css'
);

const LABEL_CLASS = [
  '_11c82smr', '_1e0c11p5', '_1ejihkll', '_umai184x', '_syazovqm',
  '_80om73ad', '_zulp1nu5', '_yv0ey09t', '_h5e31kd8', '_1nzs1kc0',
  '_1esz1j4g', '_yp0j1ehr', '_ay2w1ouc', '_d51u12ci', '_phftddza'
].join(' ');
const INPUT_CLASS = [
  '_19itglyw', '_nd5lfibj', '_12ji1r31', '_1qu2glyw', '_12y31o36',
  '_1bsb1osq', '_4t3i1osq', '_r06hglyw', '_6rthze3t', '_1pfhze3t',
  '_12l2ze3t', '_ahbqze3t', '_tzy4idpf', '_r050fibj', '_9bg71mn3',
  '_19op11so', '_a30fhteq', '_1610e4h9', '_13wo93zu', '_q5a61gyf'
].join(' ');
const SVG_CLASS = '_lswuvuon _lcxvglyw _vc881r31 _1bsb1tcg _4t3i1tcg';
const LABEL_TEXT_CLASS = '_nd5l11ig _1wpz1h6o';

function html() {
  const labels = [
    'Sync Comments',
    'Synchronize attachments',
    'Sync Issue Links',
    'Sync Sprints',
    'Add Cross-Reference in Description',
    'Recreate Deleted Issues',
    'Automatically recreate a confirmed deleted counterpart'
  ];
  const controls = labels.map((label) => `
      <label class="${LABEL_CLASS}">
        <input type="checkbox" class="${INPUT_CLASS}" aria-label="${label}">
        <svg viewBox="0 0 24 24" role="presentation" class="${SVG_CLASS}"
          style="color: var(--checkbox-background-color); fill: var(--checkbox-tick-color)">
          <g fill-rule="evenodd"><rect fill="currentColor" x="6" y="6" width="12" height="12" rx="2"></rect></g>
        </svg>
        <span class="${LABEL_TEXT_CLASS}">${label}</span>
      </label>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <div class="admin-dashboard" style="padding:24px;width:600px">
      <h4>Sync Options</h4>${controls}
    </div>
  </body></html>`;
}

async function main() {
  const dashboardCss = fs.readFileSync(DASHBOARD_CSS, 'utf8');
  const checkboxCss = fs.readFileSync(CHECKBOX_CSS, 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 300 } });
    await page.setContent(
      html().replace('</head>', `<style>${dashboardCss}\n${checkboxCss}</style></head>`)
    );
    const result = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('label')];
      const controls = labels.map((label) => {
        const input = label.querySelector('input[type="checkbox"]');
        const svg = label.querySelector('svg');
        if (!input || !svg) return null;
        const inputStyle = getComputedStyle(input);
        const svgStyle = getComputedStyle(svg);
        return {
          label: label.textContent.trim(),
          inputWidth: inputStyle.width,
          inputHeight: inputStyle.height,
          svgWidth: svgStyle.width,
          svgHeight: svgStyle.height,
          labelGrid: getComputedStyle(label).gridTemplateColumns
        };
      });
      return controls;
    });
    const invalid = (result || []).filter((control) => (
      !control
      || parseFloat(control.svgWidth) < 20
      || parseFloat(control.svgHeight) < 20
    ));
    if (!result || result.length !== 7 || invalid.length > 0) {
      throw new Error(`Checkbox controls are not visibly rendered: ${JSON.stringify(result)}`);
    }
    const screenshot = path.join('/tmp', 'syncapp-checkbox-visibility.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`[checkbox-visibility] PASS ${result.length} controls; ${JSON.stringify(result.map((control) => ({
      label: control.label,
      svgWidth: control.svgWidth,
      svgHeight: control.svgHeight
    })))}`);
    console.log(`[checkbox-visibility] screenshot ${screenshot}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('[checkbox-visibility] FAIL', error.message);
  process.exitCode = 1;
});
