import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as OTPAuth from 'otpauth';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Browser, Page } from 'playwright';

// Add the stealth plugin to playwright
chromium.use(StealthPlugin());

// Browser launch options for Microsoft Edge on Windows (via WSL)
// Can be overridden with BROWSER_PATH environment variable
const launchOptions = {
  executablePath: process.env.BROWSER_PATH || '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
};

// Helper: Retry wrapper with exponential backoff
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.error(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

// Helper: Take screenshot on error
async function screenshotOnError(page: Page, error: Error): Promise<void> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `error-screenshot-${timestamp}.png`;
    await page.screenshot({ path: filename, fullPage: true });
    console.error(`Screenshot saved to ${filename}`);
  } catch (screenshotError) {
    console.error('Failed to capture error screenshot:', screenshotError);
  }
}

// Helper: Validate cookie path to prevent path traversal
function validateCookiePath(cookiesPath: string): string {
  const allowedBase = process.env.COOKIES_BASE_DIR || process.cwd();
  const resolvedPath = path.resolve(cookiesPath);
  const resolvedBase = path.resolve(allowedBase);

  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new Error(`Cookie path must be within ${resolvedBase}`);
  }

  return resolvedPath;
}

// Helper: Save cookies to file
async function saveCookies(page: Page, cookiesPath: string): Promise<void> {
  const validatedPath = validateCookiePath(cookiesPath);
  const cookies = await page.context().cookies();
  const dir = path.dirname(validatedPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(validatedPath, JSON.stringify(cookies, null, 2));
  console.error(`Saved ${cookies.length} cookies to ${validatedPath}`);
}

// Helper: Load cookies from file
async function loadCookies(page: Page, cookiesPath: string): Promise<void> {
  try {
    const validatedPath = validateCookiePath(cookiesPath);
    const cookiesData = await fs.readFile(validatedPath, 'utf-8');
    const cookies = JSON.parse(cookiesData);
    await page.context().addCookies(cookies);
    console.error(`Loaded ${cookies.length} cookies from ${validatedPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    console.error(`No cookies file found at ${cookiesPath}, starting fresh`);
  }
}

// Create a new FastMCP server
const server = new FastMCP({
  name: 'stealth-browser-mcp',
  version: '1.0.0'
});

// Add the screenshot tool
server.addTool({
  name: 'screenshot',
  description: 'Navigate to a URL and take a screenshot of the webpage',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to'),
    fullPage: z.boolean().default(true).describe('Whether to take a screenshot of the full page'),
    selector: z.string().optional().describe('CSS selector to screenshot a specific element'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode'),
    cookiesPath: z.string().optional().describe('Optional path to cookies file to load before navigation'),
    screenshotOnError: z.boolean().default(false).describe('Whether to save a screenshot when an error occurs'),
    retry: z.boolean().default(false).describe('Whether to retry on failure with exponential backoff')
  }),
  execute: async ({ url, fullPage = true, selector, headless = true, cookiesPath, screenshotOnError: enableScreenshotOnError = false, retry = false }) => {
    const operation = async () => {
      // Launch browser with stealth mode
      const browser = await chromium.launch({ ...launchOptions, headless });
      let page: Page | null = null;
      try {
        page = await browser.newPage();

        if (cookiesPath) {
          await loadCookies(page, cookiesPath);
        }

        // Navigate to the URL
        console.error(`Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle' });

        // Take the screenshot
        const screenshotOptions = { fullPage };
        let screenshot;

        if (selector) {
          // Screenshot specific element if selector is provided
          const element = await page.$(selector);
          if (element) {
            screenshot = await element.screenshot();
          } else {
            throw new Error(`Element with selector '${selector}' not found`);
          }
        } else {
          // Screenshot entire page
          screenshot = await page.screenshot(screenshotOptions);
        }

        // Return screenshot as base64 data with content type
        return {
          content: [
            {
              type: 'image' as const,
              data: screenshot.toString('base64'),
              mimeType: 'image/png'
            }
          ]
        };
      } catch (error) {
        if (enableScreenshotOnError && page) {
          await screenshotOnError(page, error instanceof Error ? error : new Error(String(error)));
        }
        throw error;
      } finally {
        await browser.close();
      }
    };

    if (retry) {
      return await withRetry(operation);
    } else {
      return await operation();
    }
  }
});

// Add navigate tool
server.addTool({
  name: 'navigate',
  description: 'Navigate to a URL in a browser session',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load').describe('When to consider navigation succeeded'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode')
  }),
  execute: async ({ url, waitUntil = 'load', headless = true }) => {
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const page = await browser.newPage();
      console.error(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully navigated to ${url}`
          }
        ]
      };
    } finally {
      await browser.close();
    }
  }
});

// Add click tool
server.addTool({
  name: 'click',
  description: 'Click an element on the page',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to first'),
    selector: z.string().describe('CSS selector of element to click'),
    waitAfterClick: z.number().default(1000).describe('Milliseconds to wait after clicking'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode')
  }),
  execute: async ({ url, selector, waitAfterClick = 1000, headless = true }) => {
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const page = await browser.newPage();

      console.error(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'load' });

      console.error(`Clicking element: ${selector}...`);
      await page.click(selector);

      if (waitAfterClick > 0) {
        await new Promise(resolve => setTimeout(resolve, waitAfterClick));
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully clicked element: ${selector}`
          }
        ]
      };
    } finally {
      await browser.close();
    }
  }
});

// Add type tool
server.addTool({
  name: 'type',
  description: 'Type text into an input field',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to first'),
    selector: z.string().describe('CSS selector of input element'),
    text: z.string().describe('Text to type'),
    clearFirst: z.boolean().default(true).describe('Whether to clear the field before typing'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode')
  }),
  execute: async ({ url, selector, text, clearFirst = true, headless = true }) => {
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const page = await browser.newPage();

      console.error(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'load' });

      console.error(`Typing into element: ${selector}...`);
      if (clearFirst) {
        await page.fill(selector, text);
      } else {
        await page.type(selector, text);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully typed text into: ${selector}`
          }
        ]
      };
    } finally {
      await browser.close();
    }
  }
});

// Add waitForSelector tool
server.addTool({
  name: 'waitForSelector',
  description: 'Wait for an element to appear on the page',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to first'),
    selector: z.string().describe('CSS selector to wait for'),
    timeout: z.number().default(30000).describe('Maximum time to wait in milliseconds (default: 30000)'),
    state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible').describe('State to wait for'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode')
  }),
  execute: async ({ url, selector, timeout = 30000, state = 'visible', headless = true }) => {
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const page = await browser.newPage();

      console.error(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'load' });

      console.error(`Waiting for selector: ${selector} (state: ${state})...`);
      await page.waitForSelector(selector, { state, timeout });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully found element: ${selector}`
          }
        ]
      };
    } finally {
      await browser.close();
    }
  }
});

// Add getText tool
server.addTool({
  name: 'getText',
  description: 'Get text content from an element on the page',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to first'),
    selector: z.string().describe('CSS selector of element to get text from'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode')
  }),
  execute: async ({ url, selector, headless = true }) => {
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const page = await browser.newPage();

      console.error(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'load' });

      console.error(`Getting text from element: ${selector}...`);
      const element = await page.$(selector);
      if (!element) {
        throw new Error(`Element with selector '${selector}' not found`);
      }

      const text = await element.textContent();

      return {
        content: [
          {
            type: 'text',
            text: text || ''
          }
        ]
      };
    } finally {
      await browser.close();
    }
  }
});

// Add generateTOTP tool
server.addTool({
  name: 'generateTOTP',
  description: 'Generate a TOTP (Time-based One-Time Password) code from a base32 secret',
  parameters: z.object({
    secret: z.string().optional().describe('Base32-encoded TOTP secret (provide this OR secretEnvVar)'),
    secretEnvVar: z.string().optional().describe('Environment variable name containing the TOTP secret (provide this OR secret)'),
    algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']).default('SHA1').describe('Hash algorithm (default: SHA1)'),
    digits: z.number().default(6).describe('Number of digits in the code (default: 6)'),
    period: z.number().default(30).describe('Time period in seconds (default: 30)')
  }),
  execute: async ({ secret, secretEnvVar, algorithm = 'SHA1', digits = 6, period = 30 }) => {
    const totpSecret = secretEnvVar ? process.env[secretEnvVar] : secret;
    if (!totpSecret) {
      throw new Error('Either secret or secretEnvVar must be provided');
    }
    try {
      const totp = new OTPAuth.TOTP({
        algorithm,
        digits,
        period,
        secret: totpSecret
      });

      const code = totp.generate();

      return {
        content: [
          {
            type: 'text',
            text: code
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to generate TOTP: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});

// Add enterMFA tool
server.addTool({
  name: 'enterMFA',
  description: 'Generate TOTP code and enter it into an MFA input field on the page',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to first'),
    selector: z.string().describe('CSS selector of MFA input field'),
    secret: z.string().optional().describe('Base32-encoded TOTP secret (provide this OR secretEnvVar)'),
    secretEnvVar: z.string().optional().describe('Environment variable name containing the TOTP secret (provide this OR secret)'),
    submitAfter: z.boolean().default(false).describe('Whether to submit form after entering code'),
    submitSelector: z.string().optional().describe('CSS selector of submit button (if submitAfter is true)'),
    waitAfterEnter: z.number().default(1000).describe('Milliseconds to wait after entering code'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode')
  }),
  execute: async ({ url, selector, secret, secretEnvVar, submitAfter = false, submitSelector, waitAfterEnter = 1000, headless = true }) => {
    const totpSecret = secretEnvVar ? process.env[secretEnvVar] : secret;
    if (!totpSecret) {
      throw new Error('Either secret or secretEnvVar must be provided');
    }
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const page = await browser.newPage();

      console.error(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'load' });

      // Generate TOTP code
      const totp = new OTPAuth.TOTP({
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: totpSecret
      });
      const code = totp.generate();
      console.error(`TOTP generated successfully`);

      // Enter the code
      console.error(`Entering MFA code into element: ${selector}...`);
      await page.fill(selector, code);

      if (waitAfterEnter > 0) {
        await new Promise(resolve => setTimeout(resolve, waitAfterEnter));
      }

      // Submit if requested
      if (submitAfter) {
        if (!submitSelector) {
          throw new Error('submitSelector is required when submitAfter is true');
        }
        console.error(`Clicking submit button: ${submitSelector}...`);
        await page.click(submitSelector);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return {
        content: [
          {
            type: 'text',
            text: submitAfter
              ? `Successfully entered MFA code and submitted form`
              : `Successfully entered MFA code into: ${selector}`
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to enter MFA: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await browser.close();
    }
  }
});

// Add saveCookies tool
server.addTool({
  name: 'saveCookies',
  description: 'Navigate to a URL and save browser cookies to a file for later reuse',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to before saving cookies'),
    cookiesPath: z.string().describe('Path to save cookies file (e.g., "./cookies/session.json")'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load').describe('When to consider navigation succeeded'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode')
  }),
  execute: async ({ url, cookiesPath, waitUntil = 'load', headless = true }) => {
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const page = await browser.newPage();

      console.error(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil });

      await saveCookies(page, cookiesPath);

      return {
        content: [
          {
            type: 'text',
            text: `Successfully saved cookies to ${cookiesPath}`
          }
        ]
      };
    } finally {
      await browser.close();
    }
  }
});

// Add loadCookies tool
server.addTool({
  name: 'loadCookies',
  description: 'Navigate to a URL with previously saved cookies loaded',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to'),
    cookiesPath: z.string().describe('Path to cookies file (e.g., "./cookies/session.json")'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load').describe('When to consider navigation succeeded'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode')
  }),
  execute: async ({ url, cookiesPath, waitUntil = 'load', headless = true }) => {
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const page = await browser.newPage();

      await loadCookies(page, cookiesPath);

      console.error(`Navigating to ${url} with loaded cookies...`);
      await page.goto(url, { waitUntil });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully navigated to ${url} with cookies from ${cookiesPath}`
          }
        ]
      };
    } finally {
      await browser.close();
    }
  }
});

// Add extractTable tool
server.addTool({
  name: 'extractTable',
  description: 'Extract HTML table data to JSON format from a webpage',
  parameters: z.object({
    url: z.string().url().describe('URL to navigate to'),
    tableSelector: z.string().default('table').describe('CSS selector for the table element (default: "table")'),
    headless: z.boolean().default(true).describe('Whether to run browser in headless mode (default) or visible mode'),
    cookiesPath: z.string().optional().describe('Optional path to cookies file to load before navigation')
  }),
  execute: async ({ url, tableSelector = 'table', headless = true, cookiesPath }) => {
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const page = await browser.newPage();

      if (cookiesPath) {
        await loadCookies(page, cookiesPath);
      }

      console.error(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'load' });

      console.error(`Extracting table: ${tableSelector}...`);
      const tableData = await page.evaluate((selector) => {
        const table = document.querySelector(selector);
        if (!table) {
          throw new Error(`Table with selector '${selector}' not found`);
        }

        const headers: string[] = [];
        const rows: Record<string, string>[] = [];

        // Extract headers
        const headerCells = table.querySelectorAll('thead th, thead td');
        if (headerCells.length > 0) {
          headerCells.forEach((cell) => {
            headers.push(cell.textContent?.trim() || '');
          });
        } else {
          // Try first row if no thead
          const firstRow = table.querySelector('tr');
          if (firstRow) {
            firstRow.querySelectorAll('th, td').forEach((cell) => {
              headers.push(cell.textContent?.trim() || '');
            });
          }
        }

        // Extract data rows
        const dataRows = table.querySelectorAll('tbody tr');
        const rowsToProcess = dataRows.length > 0 ? dataRows : table.querySelectorAll('tr:not(:first-child)');

        rowsToProcess.forEach((row) => {
          const cells = row.querySelectorAll('td, th');
          if (cells.length > 0) {
            const rowData: Record<string, string> = {};
            cells.forEach((cell, index) => {
              const header = headers[index] || `column_${index}`;
              rowData[header] = cell.textContent?.trim() || '';
            });
            rows.push(rowData);
          }
        });

        return { headers, rows, rowCount: rows.length };
      }, tableSelector);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(tableData, null, 2)
          }
        ]
      };
    } finally {
      await browser.close();
    }
  }
});

// Start the server with STDIO transport
server.start({ transportType: 'stdio' }).then(() => {
  console.error('MCP server started and waiting for commands...');
}).catch(error => {
  console.error('Failed to start MCP server:', error);
});