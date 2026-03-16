'use strict';
/**
 * browse.server.js — Playwright HTTP server running inside a Fly.io Sprite sandbox.
 *
 * This file is self-contained: it only uses require() of node builtins and playwright.
 * It is imported as a text module by the Cloudflare Worker, written to the Sprite filesystem,
 * and executed with: node server.js
 *
 * Endpoints:
 *   POST /browse    { url, sessionId }           → BrowseResult JSON
 *   POST /interact  { action, sessionId, ... }   → BrowseResult JSON
 *   POST /cleanup   { sessionId }                → { ok: true }
 *   GET  /health                                 → { ok: true, sessions: N }
 */

const http = require('node:http');
const { chromium } = require('playwright');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SNAPSHOT_SIZE = 12000;
const PAGE_TIMEOUT = 45000;
const NETWORK_IDLE_TIMEOUT = 3000;
const COOKIE_CHECK_TIMEOUT = 500;
const SESSION_IDLE_TTL = 5 * 60 * 1000;
const SERVER_IDLE_TTL = 60 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const BROWSER_CONTEXT_OPTIONS = {
  userAgent: USER_AGENT,
  viewport: { width: 1280, height: 720 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
  extraHTTPHeaders: {
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-CH-UA': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"macOS"',
  },
};

const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!window.chrome) {
    window.chrome = { runtime: {}, csi: function(){}, loadTimes: function(){} };
  }
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const make = (name, desc, filename) => ({ name, description: desc, filename, length: 1 });
      const arr = [
        make('Chrome PDF Plugin', 'Portable Document Format', 'internal-pdf-viewer'),
        make('Chrome PDF Viewer', '', 'mhjfbmdgcfjbbpaeojofohoefgiehjai'),
        make('Native Client', '', 'internal-nacl-plugin'),
      ];
      arr.item = (i) => arr[i] || null;
      arr.namedItem = (n) => arr.find(p => p.name === n) || null;
      arr.refresh = () => {};
      return arr;
    },
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });
`;

const ALLOWED_KEYS = [
  'Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight',
  'Space', 'Backspace', 'Delete',
];

// SSRF blocklist — expanded for Fly.io internals
const BLOCKED_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
  /^::1$/, /^fe80:/i, /^fc00:/i, /^fd/i,
  /^localhost$/i,
  /^metadata\.google/i, /^metadata\.aws/i,
  /\.internal$/i,
  /^fdaa:/i,  // Fly.io internal IPv6
];

// ---------------------------------------------------------------------------
// SSRF Protection
// ---------------------------------------------------------------------------

/**
 * Throw if the URL is not safe to navigate to.
 * @param {string} url
 */
function assertSafeUrl(url) {
  const parsed = new URL(url); // throws on invalid URL

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }

  // Strip IPv6 brackets
  const hostname = parsed.hostname.replace(/^\[|]$/g, '').toLowerCase();

  if (BLOCKED_PATTERNS.some((re) => re.test(hostname))) {
    throw new Error('Access to internal/private network addresses is not allowed');
  }
}

// ---------------------------------------------------------------------------
// Browser & Session Management
// ---------------------------------------------------------------------------

/** @type {import('playwright').Browser | null} */
let browser = null;

/**
 * Map<string, { context, page, elements, revision, lastDialog, idleTimer }>
 * @type {Map<string, {
 *   context: import('playwright').BrowserContext,
 *   page: import('playwright').Page,
 *   elements: Map<number, object>,
 *   revision: number,
 *   lastDialog: string | undefined,
 *   idleTimer: NodeJS.Timeout | null
 * }>}
 */
const sessions = new Map();

/** Server-level idle timer — close browser + exit when no requests come in. */
let serverIdleTimer = null;

function resetServerIdleTimer() {
  if (serverIdleTimer) clearTimeout(serverIdleTimer);
  serverIdleTimer = setTimeout(async () => {
    console.log('[browse-server] server idle timeout — closing browser and exiting');
    // Hard exit fallback in case browser.close() hangs (e.g. renderer deadlock)
    setTimeout(() => process.exit(0), 5000).unref();
    if (browser) {
      try { await browser.close(); } catch (e) { console.error('[browse-server] error closing browser on idle:', e); }
      browser = null;
    }
    process.exit(0);
  }, SERVER_IDLE_TTL);
}

function resetSessionIdleTimer(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(async () => {
    console.log(`[browse-server] session ${sessionId} idle timeout — closing context`);
    await closeSession(sessionId);
  }, SESSION_IDLE_TTL);
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try { await session.context.close(); } catch (e) { console.error(`[browse-server] error closing session ${sessionId}:`, e); }
  sessions.delete(sessionId);
}

async function ensureBrowser() {
  if (!browser) {
    console.log('[browse-server] launching browser');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

async function ensureSession(sessionId) {
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  const b = await ensureBrowser();
  const context = await b.newContext(BROWSER_CONTEXT_OPTIONS);

  // SSRF protection: intercept all sub-requests in this context
  await context.route('**/*', async (route) => {
    try {
      assertSafeUrl(route.request().url());
      await route.continue();
    } catch (e) {
      console.debug('[browse-server] blocked sub-request:', route.request().url(), e.message);
      await route.abort('blockedbyclient');
    }
  });

  // Stealth injection
  try {
    await context.addInitScript(STEALTH_INIT_SCRIPT);
  } catch (e) {
    console.warn('[browse-server] context.addInitScript failed:', e);
  }

  const page = await context.newPage();

  // Auto-dismiss dialogs, capture message
  page.on('dialog', async (dialog) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastDialog = `[${dialog.type()}] ${dialog.message()}`;
    }
    try { await dialog.dismiss(); } catch (e) { console.warn('[browse-server] dialog dismiss error:', e); }
  });

  const session = {
    context,
    page,
    elements: new Map(),
    revision: 0,
    lastDialog: undefined,
    idleTimer: null,
  };

  sessions.set(sessionId, session);
  resetSessionIdleTimer(sessionId);
  return session;
}

// ---------------------------------------------------------------------------
// Page Utility Functions
// ---------------------------------------------------------------------------

/**
 * Inject JS to index all interactive elements on the page.
 * Assigns data-agent-id to each, returns element metadata.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array>}
 */
async function indexInteractiveElements(page) {
  return await page.evaluate(() => {
    const SELECTORS = [
      'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
      'summary', '[contenteditable="true"]',
      '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
      '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]',
      '[tabindex]:not([tabindex="-1"])', '[onclick]',
    ];

    // Remove old annotations
    document.querySelectorAll('[data-agent-id]').forEach(el => el.removeAttribute('data-agent-id'));

    const seen = new Set();
    const elements = [];
    let nextId = 1;

    for (const sel of SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          if (seen.has(el)) return;
          seen.add(el);

          // Visibility check
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width === 0 && rect.height === 0) return;
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

          // Interactability check
          if (el.hasAttribute('disabled')) return;
          if (el.getAttribute('aria-disabled') === 'true') return;
          if (el.hasAttribute('inert')) return;
          if (style.pointerEvents === 'none') return;

          const id = nextId++;
          el.setAttribute('data-agent-id', String(id));

          const tag = el.tagName.toLowerCase();
          const ariaRole = el.getAttribute('role');

          // Normalize role
          let role = 'Element';
          if (ariaRole) {
            const roleMap = {
              button: 'Button', link: 'Link', tab: 'Tab', menuitem: 'MenuItem',
              option: 'Option', checkbox: 'Checkbox', radio: 'Radio',
              switch: 'Switch', combobox: 'ComboBox', textbox: 'Input', searchbox: 'Input',
            };
            role = roleMap[ariaRole] || ariaRole.charAt(0).toUpperCase() + ariaRole.slice(1);
          } else {
            const tagMap = {
              a: 'Link', button: 'Button', input: 'Input', select: 'Select',
              textarea: 'TextArea', summary: 'Summary',
            };
            role = tagMap[tag] || 'Element';
          }

          // Get name
          const name = (
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('alt') ||
            el.getAttribute('title') ||
            (tag === 'input' || tag === 'textarea' ? '' : el.textContent && el.textContent.trim()) ||
            ''
          ).slice(0, 80);

          // Get dynamic state from DOM properties
          const entry = { id, role, name, tag };
          if (tag === 'input') entry.inputType = el.type || 'text';
          if ('value' in el && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
            const val = el.value;
            if (val) entry.value = val.slice(0, 100);
          }
          if ('checked' in el && (el.type === 'checkbox' || el.type === 'radio')) {
            entry.checked = el.checked;
          }
          if (el.getAttribute('aria-expanded') != null) {
            entry.expanded = el.getAttribute('aria-expanded') === 'true';
          }
          if (tag === 'details') {
            entry.expanded = el.open;
          }

          elements.push(entry);
        });
      } catch (e) {
        console.debug('[browse-server] skipping invalid selector:', e);
      }
    }

    return elements;
  });
}

/**
 * Extract page content as markdown with anchored interactive elements.
 * Runs entirely in page.evaluate() (browser V8), returns a string.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function extractAnchoredMarkdown(page) {
  return await page.evaluate(() => {
    const SKIP_TAGS = new Set(['script', 'style', 'svg', 'noscript', 'link']);

    function roleLabel(el) {
      const role = el.getAttribute('role');
      const tag = el.tagName.toLowerCase();
      if (role) {
        const map = {
          button: 'Button', link: 'Link', tab: 'Tab', menuitem: 'MenuItem',
          option: 'Option', checkbox: 'Checkbox', radio: 'Radio',
          combobox: 'ComboBox', textbox: 'Input', searchbox: 'Input',
        };
        return map[role] || role.charAt(0).toUpperCase() + role.slice(1);
      }
      const tagMap = {
        a: 'Link', button: 'Button', input: 'Input', select: 'Select',
        textarea: 'TextArea', summary: 'Summary',
      };
      return tagMap[tag] || 'Element';
    }

    function stateAnnotation(el) {
      const parts = [];
      if ('value' in el && el.value && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
        parts.push(`value: "${el.value.slice(0, 40)}"`);
      }
      if ('checked' in el && (el.type === 'checkbox' || el.type === 'radio') && el.checked) {
        parts.push('checked');
      }
      if (el.getAttribute('aria-expanded') === 'true' || el.open) {
        parts.push('expanded');
      }
      return parts.length > 0 ? ` (${parts.join(', ')})` : '';
    }

    function nodeToMd(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ? node.textContent.replace(/[ \t]+/g, ' ') : '';
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node;
      const tag = el.tagName.toLowerCase();

      // Skip noise elements
      if (SKIP_TAGS.has(tag)) return '';

      // Skip hidden non-interactive elements
      if (!el.hasAttribute('data-agent-id')) {
        try {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return '';
        } catch (e) {
          console.debug('[browse-server] getComputedStyle failed on detached element:', e);
        }
      }

      // Agent-annotated element → anchor format
      if (el.hasAttribute('data-agent-id')) {
        const id = el.getAttribute('data-agent-id');
        const role = roleLabel(el);
        const name = (
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('alt') ||
          el.getAttribute('title') ||
          (el.textContent && el.textContent.trim()) ||
          ''
        ).slice(0, 60);
        const state = stateAnnotation(el);
        return `[${role} ${id}: ${name}${state}]`;
      }

      const children = () => Array.from(el.childNodes).map(nodeToMd).join('');

      // Headings
      if (/^h[1-6]$/.test(tag)) {
        const level = '#'.repeat(parseInt(tag[1]));
        const text = children().trim();
        return text ? `\n\n${level} ${text}\n` : '';
      }
      // Paragraphs
      if (tag === 'p') {
        const text = children().trim();
        return text ? `\n${text}\n` : '';
      }
      // Lists
      if (tag === 'li') {
        const text = children().trim();
        return text ? `\n- ${text}` : '';
      }
      if (tag === 'ul' || tag === 'ol') return `\n${children()}\n`;
      // Line breaks
      if (tag === 'br') return '\n';
      if (tag === 'hr') return '\n---\n';
      // Tables — simplified
      if (tag === 'table') {
        const text = (el.textContent && el.textContent.trim().slice(0, 300)) || '';
        return `\n[Table: ${text}]\n`;
      }
      // Images (non-interactive — no agent-id)
      if (tag === 'img') {
        const alt = el.getAttribute('alt') || '';
        return alt ? `[Image: ${alt}]` : '';
      }
      // Block elements
      if (['div', 'section', 'article', 'main', 'nav', 'header', 'footer', 'aside', 'form', 'fieldset', 'details'].includes(tag)) {
        return children();
      }
      // Strong/em
      if (tag === 'strong' || tag === 'b') return `**${children()}**`;
      if (tag === 'em' || tag === 'i') return `*${children()}*`;
      // Code
      if (tag === 'code') return `\`${children()}\``;
      if (tag === 'pre') return `\n\`\`\`\n${el.textContent && el.textContent.trim()}\n\`\`\`\n`;

      // Default: just render children
      return children();
    }

    return Array.from(document.body.childNodes).map(nodeToMd).join('');
  });
}

/**
 * Attempt to dismiss cookie consent banners. Best-effort.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function dismissCookieConsent(page) {
  const selectors = [
    'button:has-text("Accept all")', 'button:has-text("Accept All")',
    'button:has-text("Accept")', 'button:has-text("Agree")',
    'button:has-text("I agree")', 'button:has-text("OK")',
    'button:has-text("Got it")', 'button:has-text("Allow all")',
    'button:has-text("同意")', 'button:has-text("接受")',
    '#onetrust-accept-btn-handler', '.cc-accept',
    '[data-testid="cookie-accept"]', '#cookie-accept',
    '[aria-label="Accept cookies"]',
  ];

  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: COOKIE_CHECK_TIMEOUT })) {
        await btn.click();
        await page.waitForTimeout(500);
        return true;
      }
    } catch (e) {
      console.debug('[browse-server] cookie selector failed:', sel, e.message);
      continue;
    }
  }

  // Check cookie banners in iframes
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    for (const sel of selectors.slice(0, 5)) {
      try {
        const btn = frame.locator(sel).first();
        if (await btn.isVisible({ timeout: 300 })) {
          await btn.click();
          await page.waitForTimeout(500);
          return true;
        }
      } catch (e) {
        console.debug('[browse-server] iframe cookie selector failed:', sel, e.message);
        continue;
      }
    }
  }

  return false;
}

/**
 * Get current page metadata including tabs and scroll position.
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 */
async function getPageInfo(page, context) {
  const allPages = context.pages();
  const tabIndex = allPages.indexOf(page) + 1;

  const scroll = await page.evaluate(() => {
    const scrollTop = window.scrollY;
    const scrollHeight = document.documentElement.scrollHeight;
    const clientHeight = window.innerHeight;
    const maxScroll = scrollHeight - clientHeight;
    return {
      start: maxScroll > 0 ? Math.round((scrollTop / scrollHeight) * 100) : 0,
      end: maxScroll > 0 ? Math.round(((scrollTop + clientHeight) / scrollHeight) * 100) : 100,
      canDown: scrollTop < maxScroll - 10,
    };
  });

  return {
    url: page.url(),
    title: await page.title(),
    tabIndex,
    tabCount: allPages.length,
    scrollStart: scroll.start,
    scrollEnd: scroll.end,
    canScrollDown: scroll.canDown,
  };
}

/**
 * Classify a navigation error for structured reporting.
 * NOTE: duplicated in browse.ts — keep in sync.
 * @param {Error} error
 * @returns {'timeout' | 'dns_error' | 'network_error' | 'browser_error' | 'installing' | 'unknown'}
 */
function classifyBrowseError(error) {
  const msg = error.message.toLowerCase();
  if (msg.includes('being initialized')) return 'installing';
  if (msg.includes('timeout')) return 'timeout';
  if (msg.includes('err_name_not_resolved') || msg.includes('dns')) return 'dns_error';
  if (msg.includes('err_connection') || msg.includes('err_network') || msg.includes('net::')) return 'network_error';
  if (msg.includes('browser closed') || msg.includes('target closed') || msg.includes('browser.close')) return 'browser_error';
  return 'unknown';
}

/**
 * Detect if a successfully loaded page is actually a challenge/block page.
 * NOTE: duplicated in browse.ts — keep in sync.
 * @param {number} status
 * @param {Map<string, string>} headers
 * @param {string} title
 * @returns {string | null}
 */
function detectChallengePage(status, headers, title) {
  // Cloudflare challenge header (most reliable signal)
  if (headers.get('cf-mitigated') === 'challenge') return 'cloudflare_challenge';

  const lowerTitle = title.toLowerCase();

  // Cloudflare "Just a moment" interstitial — only on 403/503
  if ((status === 403 || status === 503) && lowerTitle.includes('just a moment')) return 'cloudflare_challenge';

  // Captcha / human verification — status-gated
  if ((status === 403 || status === 503) && (
    lowerTitle.includes('verify you are human') || lowerTitle.includes('captcha')
  )) return 'captcha';

  // 403 WAF block — require short, generic WAF-like titles
  if (status === 403 && title.length < 30 && (
    lowerTitle === 'access denied' ||
    lowerTitle === 'forbidden' ||
    lowerTitle === 'blocked' ||
    lowerTitle === '403 forbidden' ||
    lowerTitle === '' // Empty title on 403 often indicates WAF block
  )) return 'blocked_403';

  // 503 with specific challenge phrasing
  if (status === 503 && (
    lowerTitle.includes('checking your browser') ||
    lowerTitle.includes('ddos protection')
  )) return 'service_challenge';

  return null;
}

/**
 * Truncate text to limit, appending note if truncated.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncateText(text, limit = MAX_SNAPSHOT_SIZE) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n[Content truncated, ${text.length - limit} more chars]`;
}

/**
 * Build a full BrowseResult snapshot for the given session.
 * @param {string} sessionId
 * @returns {Promise<object>} BrowseResult
 */
async function getPageSnapshot(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const { page, context } = session;
  session.revision++;

  // Index elements
  const elements = await indexInteractiveElements(page);
  session.elements = new Map(elements.map(e => [e.id, e]));

  // Extract anchored markdown (in browser V8)
  let markdown = await extractAnchoredMarkdown(page);

  // Clean up markdown: collapse whitespace
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

  // Get page info
  const info = await getPageInfo(page, context);

  // Build tabs info
  const tabsInfo = info.tabCount > 1
    ? await Promise.all(context.pages().map(async (p, i) => ({
        id: i + 1,
        title: await p.title().catch(() => '') || p.url(),
        url: p.url(),
        active: p === page,
      })))
    : [];

  const header = [
    `[URL]: ${info.url}`,
    info.tabCount > 1
      ? `[Tab ${info.tabIndex}/${info.tabCount}] | Scroll: ${info.scrollStart}-${info.scrollEnd}%`
      : `Scroll: ${info.scrollStart}-${info.scrollEnd}%`,
  ].join('\n');

  const fullMarkdown = `${header}\n\n${markdown}`;
  const truncated = fullMarkdown.length > MAX_SNAPSHOT_SIZE;
  const truncatedMarkdown = truncateText(fullMarkdown, MAX_SNAPSHOT_SIZE);

  const footer = info.canScrollDown
    ? `\n---\n(Page ${info.scrollEnd}% shown, ${elements.length} interactive elements, use scroll to see more)`
    : '';

  const result = {
    url: info.url,
    title: info.title,
    tabs: tabsInfo,
    revision: session.revision,
    truncated,
    ...(session.lastDialog && { lastDialog: `${session.lastDialog} (dismissed)` }),
    markdown: truncatedMarkdown + footer,
    mode: 'browser',
    interactable: true,
  };

  // Clear lastDialog after reporting
  session.lastDialog = undefined;

  return result;
}

// ---------------------------------------------------------------------------
// Request Handlers
// ---------------------------------------------------------------------------

/**
 * Handle POST /browse
 * @param {{ url: string, sessionId: string }} body
 * @returns {Promise<object>} BrowseResult or error object
 */
async function handleBrowse(body) {
  const { url, sessionId } = body;

  if (!url || !sessionId) {
    return { __httpStatus: 400, error: true, message: 'Missing required fields: url, sessionId' };
  }

  try {
    assertSafeUrl(url);
  } catch (e) {
    return { __httpStatus: 400, error: true, message: e.message };
  }

  try {
    const session = await ensureSession(sessionId);
    const { page } = session;

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT,
    });

    // Wait for dynamic content (best-effort, short timeout)
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT })
      .catch((e) => { console.debug('[browse-server] networkidle timeout (expected):', e.message); });

    // Detect Chrome error pages (connection failures render as chrome-error://)
    const currentUrl = page.url();
    if (currentUrl.startsWith('chrome-error://')) {
      const pageTitle = await page.title().catch(() => '');
      console.warn(`[browse-server] chrome error page detected for ${url}: ${pageTitle}`);
      return {
        error: true,
        errorType: 'network_error',
        url,
        message: `Browse failed: ${pageTitle || 'Connection error'}`,
        hint: 'The site may be blocking server requests. Try a different URL.',
      };
    }

    // Challenge detection
    if (response) {
      const status = response.status();
      const headers = new Map(Object.entries(response.headers()));
      const pageTitle = await page.title().catch(() => '');
      const challenge = detectChallengePage(status, headers, pageTitle);

      if (challenge) {
        console.warn(`[browse-server] challenge detected (${challenge}) for ${url}`);
        return {
          error: true,
          errorType: challenge,
          url,
          message: `Page blocked by ${challenge}.`,
          hint: 'Try a different URL or use web_fetch for static content.',
        };
      }
    }

    // Auto-dismiss cookie consent
    await dismissCookieConsent(page);

    return await getPageSnapshot(sessionId);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const errorType = classifyBrowseError(err);
    console.warn(`[browse-server] navigation failed (${errorType}):`, err.message);

    return {
      error: true,
      errorType,
      url,
      message: `Browse failed: ${err.message}`,
      hint: errorType === 'dns_error'
        ? 'Domain could not be resolved. Check the URL spelling.'
        : errorType === 'network_error'
          ? 'Network connection failed. The site may be down.'
          : 'Try a different URL.',
    };
  }
}

/**
 * Handle POST /interact
 * @param {{ action: string, sessionId: string, id?: number, value?: string, key?: string, direction?: string, selector?: string, tabId?: number }} body
 * @returns {Promise<object>} BrowseResult or error object
 */
async function handleInteract(body) {
  const { action, sessionId, id, value, key, direction, selector, tabId } = body;

  if (!action || !sessionId) {
    return { __httpStatus: 400, error: true, message: 'Missing required fields: action, sessionId' };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return { __httpStatus: 400, error: true, message: `Session ${sessionId} not found. Call /browse first.` };
  }

  const { page } = session;

  function locateElement(elemId) {
    return page.locator(`[data-agent-id="${elemId}"]`);
  }

  async function handleStaleElement(elemId) {
    const snapshot = await getPageSnapshot(sessionId);
    return {
      ...snapshot,
      staleElementMessage: `Element #${elemId} no longer exists (page content changed).`,
    };
  }

  try {
    switch (action) {
      case 'click': {
        if (id == null) return { __httpStatus: 400, error: true, message: "'id' is required for click" };
        const el = locateElement(id);
        if (await el.count() === 0) return await handleStaleElement(id);

        // Watch for new tab
        const newPagePromise = page.context()
          .waitForEvent('page', { timeout: 3000 })
          .catch(() => null);

        await el.click({ timeout: 5000 });

        const newPage = await newPagePromise;
        if (newPage) {
          const allPages = page.context().pages();
          if (allPages.length === 2) {
            // Single new tab → auto-switch
            await newPage.waitForLoadState('domcontentloaded');
            session.page = newPage;
          }
          // Multiple tabs → don't auto-switch, tabs shown in snapshot
        }

        await session.page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT })
          .catch((e) => { console.debug('[browse-server] networkidle timeout (expected):', e.message); });
        await session.page.waitForTimeout(300);
        break;
      }

      case 'type': {
        if (id == null) return { __httpStatus: 400, error: true, message: "'id' is required for type" };
        if (!value && value !== '') return { __httpStatus: 400, error: true, message: "'value' is required for type" };
        const el = locateElement(id);
        if (await el.count() === 0) return await handleStaleElement(id);
        await el.fill(value, { timeout: 5000 });
        break;
      }

      case 'select': {
        if (id == null) return { __httpStatus: 400, error: true, message: "'id' is required for select" };
        if (!value) return { __httpStatus: 400, error: true, message: "'value' is required for select" };
        const el = locateElement(id);
        if (await el.count() === 0) return await handleStaleElement(id);
        await el.selectOption(value, { timeout: 5000 });
        break;
      }

      case 'press': {
        if (!key) return { __httpStatus: 400, error: true, message: "'key' is required for press" };
        if (!ALLOWED_KEYS.includes(key)) {
          return { __httpStatus: 400, error: true, message: `Unsupported key: ${key}. Allowed: ${ALLOWED_KEYS.join(', ')}` };
        }
        await page.keyboard.press(key);
        await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT })
          .catch((e) => { console.debug('[browse-server] networkidle timeout (expected):', e.message); });
        await page.waitForTimeout(300);
        break;
      }

      case 'scroll': {
        const delta = (direction === 'up') ? -600 : 600;
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(800);
        break;
      }

      case 'back': {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT })
          .catch((e) => { console.debug('[browse-server] networkidle timeout (expected):', e.message); });
        break;
      }

      case 'switch_tab': {
        if (tabId == null) return { __httpStatus: 400, error: true, message: "'tabId' is required for switch_tab" };
        const allPages = page.context().pages();
        const targetIdx = tabId - 1;
        if (targetIdx < 0 || targetIdx >= allPages.length) {
          return { __httpStatus: 400, error: true, message: `Tab ${tabId} not found. Available: 1-${allPages.length}` };
        }
        session.page = allPages[targetIdx];
        await session.page.bringToFront();
        break;
      }

      case 'wait': {
        if (selector) {
          await page.waitForSelector(selector, { timeout: 10000 });
        } else {
          await page.waitForLoadState('networkidle', { timeout: 10000 })
            .catch((e) => { console.debug('[browse-server] networkidle timeout (expected):', e.message); });
        }
        break;
      }

      case 'screenshot': {
        const img = await page.screenshot({ type: 'png', fullPage: false });
        const base64 = img.toString('base64');
        return { screenshot: base64 };
      }

      default:
        return { __httpStatus: 400, error: true, message: `Unknown action: ${action}` };
    }

    // All non-screenshot actions return updated snapshot
    return await getPageSnapshot(sessionId);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[browse-server] interact error (${action}):`, err.message);
    return {
      error: true,
      errorType: 'browser_error',
      message: `Interact failed: ${err.message}`,
    };
  }
}

/**
 * Handle POST /cleanup
 * @param {{ sessionId: string }} body
 * @returns {Promise<object>}
 */
async function handleCleanup(body) {
  const { sessionId } = body;
  if (!sessionId) {
    return { __httpStatus: 400, error: true, message: 'Missing required field: sessionId' };
  }
  await closeSession(sessionId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

/**
 * Parse JSON body from a request.
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_048_576) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  resetServerIdleTimer();

  const { method, url: reqUrl } = req;

  try {
    // Health check
    if (method === 'GET' && reqUrl === '/health') {
      sendJson(res, 200, { ok: true, sessions: sessions.size });
      return;
    }

    // Parse body for POST endpoints
    if (method !== 'POST') {
      sendJson(res, 404, { error: true, message: 'Not found' });
      return;
    }

    let body;
    try {
      body = await parseBody(req);
    } catch (e) {
      sendJson(res, 400, { error: true, message: e.message });
      return;
    }

    let result;
    if (reqUrl === '/browse') {
      // Reset session idle timer before handling
      if (body.sessionId) resetSessionIdleTimer(body.sessionId);
      result = await handleBrowse(body);
    } else if (reqUrl === '/interact') {
      if (body.sessionId) resetSessionIdleTimer(body.sessionId);
      result = await handleInteract(body);
    } else if (reqUrl === '/cleanup') {
      result = await handleCleanup(body);
    } else {
      sendJson(res, 404, { error: true, message: 'Not found' });
      return;
    }

    // Extract __httpStatus if set (used for 400 errors from handlers)
    const status = result.__httpStatus || 200;
    if (result.__httpStatus) delete result.__httpStatus;

    sendJson(res, status, result);
  } catch (error) {
    console.error('[browse-server] unexpected server error:', error);
    try {
      sendJson(res, 500, { error: true, message: String(error && error.message || error) });
    } catch (writeErr) {
      console.error('[browse-server] failed to send error response:', writeErr);
    }
  }
});

server.listen(3000, '127.0.0.1', () => {
  console.log('[browse-server] listening on 127.0.0.1:3000');
  // Start the server idle timer
  resetServerIdleTimer();
});

server.on('error', (err) => {
  console.error('[browse-server] server error:', err);
  process.exit(1);
});
